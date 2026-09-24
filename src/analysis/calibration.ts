/**
 * src/analysis/calibration.ts
 *
 * Reliability of Jev's probabilities against known answers. For a Choice or a
 * Score the prediction is the answer's `confidence` — how peaked the
 * distribution is, not the picked option's probability — and the outcome is
 * whether the picked option (a Score's most probable level) was correct; for a
 * Noul the prediction is the probability and the outcome is the true/false
 * label. So a Choice's or Score's bins and ECE grade `confidence` while its
 * Brier score grades the per-option probabilities. A well-calibrated question
 * has `observed` tracking `meanPredicted` in every bin.
 *
 * The threshold sweep answers "what if the code acted only at or above t":
 * how many rows that keeps, how many of them were right (a Noul: were true),
 * and what share of all right (true) rows it keeps.
 *
 * A truth value that cannot be scored is counted under `skipped`, never dropped
 * silently: the row has no such answer, the truth is the wrong kind for the
 * answer type, or it names an option or level the question does not have.
 */

import { z } from 'zod';
import type { Answer } from '../questions/index.ts';
import type { RunRow } from '../run/index.ts';

/**
 * Correct answers for one record, by question id: an option key (Choice), a
 * level index (Score), or a boolean (Noul).
 */
export type Truth = Readonly<Record<string, string | number | boolean>>;

/** One line of a hand-written truth file. The id is compared as a string, like a row's. */
export const truthLineSchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  truth: z.record(z.string(), z.union([z.string(), z.number().int().min(0), z.boolean()])),
});

export interface ReliabilityBin {
  readonly lo: number;
  readonly hi: number;
  readonly n: number;
  readonly meanPredicted: number;
  /** Share of rows in the bin whose outcome was positive. */
  readonly observed: number;
}

export interface Cutoff {
  readonly threshold: number;
  /** Share of rows whose prediction is at or above the threshold. */
  readonly share: number;
  /** Of those rows, the share with a positive outcome; undefined when there are none. */
  readonly precision: number | undefined;
  /** Of all rows with a positive outcome, the share at or above the threshold. */
  readonly recall: number;
}

export interface QuestionCalibration {
  readonly question: string;
  readonly type: Answer['type'];
  /** Rows that had both an answer and a usable truth value. */
  readonly n: number;
  /** Choice and Score: top-1 accuracy. Noul: accuracy at a 0.5 threshold. */
  readonly accuracy: number;
  /** Mean squared error of the probabilities; multiclass sum for a Choice or Score. Lower is better. */
  readonly brier: number;
  /** Expected calibration error: bin-weighted mean of |observed − meanPredicted|. */
  readonly ece: number;
  /** Score only: mean distance between the weighted score and the true level. */
  readonly meanLevelError?: number;
  readonly bins: readonly ReliabilityBin[];
  readonly sweep: readonly Cutoff[];
}

export interface Calibration {
  readonly questions: readonly QuestionCalibration[];
  /** Truth values that could not be scored, by question id. */
  readonly skipped: Readonly<Record<string, number>>;
}

interface Point {
  readonly predicted: number;
  readonly outcome: boolean;
  readonly correct: boolean;
  readonly squaredError: number;
  readonly levelError?: number;
}

const THRESHOLDS = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95];

export function calibrate(
  rows: readonly RunRow[],
  truth: ReadonlyMap<string, Truth>,
  binCount = 10,
): Calibration {
  const points = new Map<string, { type: Answer['type']; points: Point[] }>();
  const skipped: Record<string, number> = {};
  for (const row of rows) {
    const answers = truth.get(row.id);
    if (!answers) continue;
    for (const [question, expected] of Object.entries(answers)) {
      const answer = row.answers[question];
      const point = answer && toPoint(answer, expected);
      if (!answer || !point) {
        skipped[question] = (skipped[question] ?? 0) + 1;
        continue;
      }
      const entry = points.get(question) ?? { type: answer.type, points: [] };
      entry.points.push(point);
      points.set(question, entry);
    }
  }

  const questions = [...points.entries()].map(([question, { type, points: pts }]) => {
    const bins = toBins(pts, binCount);
    const levelErrors = pts.flatMap((p) => (p.levelError === undefined ? [] : [p.levelError]));
    return {
      question,
      type,
      n: pts.length,
      accuracy: pts.filter((p) => p.correct).length / pts.length,
      brier: pts.reduce((s, p) => s + p.squaredError, 0) / pts.length,
      ece: bins.reduce(
        (s, b) => s + (b.n / pts.length) * Math.abs(b.observed - b.meanPredicted),
        0,
      ),
      ...(type === 'score' && {
        meanLevelError: levelErrors.reduce((s, e) => s + e, 0) / levelErrors.length,
      }),
      bins,
      sweep: toSweep(pts),
    };
  });
  return { questions, skipped };
}

function toPoint(answer: Answer, expected: string | number | boolean): Point | undefined {
  if (answer.type === 'choice') {
    if (typeof expected !== 'string' || !(expected in answer.probabilities)) return undefined;
    const correct = answer.choice === expected;
    return {
      predicted: answer.confidence,
      outcome: correct,
      correct,
      squaredError: sumSquaredError(answer.probabilities, expected),
    };
  }
  if (answer.type === 'score') {
    const level = String(expected);
    if (typeof expected !== 'number' || !(level in answer.probabilities)) return undefined;
    const [picked] = Object.entries(answer.probabilities).sort((a, b) => b[1] - a[1])[0] ?? [];
    const correct = picked === level;
    return {
      predicted: answer.confidence,
      outcome: correct,
      correct,
      squaredError: sumSquaredError(answer.probabilities, level),
      levelError: Math.abs(answer.score - expected),
    };
  }
  if (typeof expected !== 'boolean') return undefined;
  return {
    predicted: answer.noul,
    outcome: expected,
    correct: answer.noul >= 0.5 === expected,
    squaredError: (answer.noul - (expected ? 1 : 0)) ** 2,
  };
}

function sumSquaredError(
  probabilities: Readonly<Record<string, number>>,
  expected: string,
): number {
  return Object.entries(probabilities).reduce(
    (sum, [option, p]) => sum + (p - (option === expected ? 1 : 0)) ** 2,
    0,
  );
}

function toBins(points: readonly Point[], binCount: number): ReliabilityBin[] {
  const buckets: Point[][] = Array.from({ length: binCount }, () => []);
  for (const point of points) {
    const index = Math.min(binCount - 1, Math.floor(point.predicted * binCount));
    buckets[index]?.push(point);
  }
  return buckets.flatMap((bucket, i) =>
    bucket.length === 0
      ? []
      : [
          {
            lo: i / binCount,
            hi: (i + 1) / binCount,
            n: bucket.length,
            meanPredicted: bucket.reduce((s, p) => s + p.predicted, 0) / bucket.length,
            observed: bucket.filter((p) => p.outcome).length / bucket.length,
          },
        ],
  );
}

function toSweep(points: readonly Point[]): Cutoff[] {
  const positives = points.filter((p) => p.outcome).length;
  return THRESHOLDS.map((threshold) => {
    const kept = points.filter((p) => p.predicted >= threshold);
    const hits = kept.filter((p) => p.outcome).length;
    return {
      threshold,
      share: kept.length / points.length,
      precision: kept.length === 0 ? undefined : hits / kept.length,
      recall: positives === 0 ? 0 : hits / positives,
    };
  });
}

export function renderCalibration({ questions, skipped }: Calibration): string {
  const lines: string[] = [];
  for (const r of questions) {
    const levelError =
      r.meanLevelError === undefined ? '' : ` · mean level error ${r.meanLevelError.toFixed(3)}`;
    lines.push(
      `[${r.type}] ${r.question} — n ${r.n} · accuracy ${(r.accuracy * 100).toFixed(1)}% · brier ${r.brier.toFixed(3)} · ece ${r.ece.toFixed(3)}${levelError}`,
      '  bin          n   predicted  observed   gap',
    );
    for (const b of r.bins) {
      const gap = b.observed - b.meanPredicted;
      lines.push(
        `  ${b.lo.toFixed(1)}–${b.hi.toFixed(1)}  ${String(b.n).padStart(6)}   ${b.meanPredicted.toFixed(3)}      ${b.observed.toFixed(3)}    ${gap >= 0 ? '+' : ''}${gap.toFixed(3)}`,
      );
    }
    lines.push(
      '',
      r.type === 'noul'
        ? '  p ≥     flagged   precision   recall'
        : '  conf ≥  kept      accuracy    right kept',
    );
    for (const c of r.sweep) {
      lines.push(
        `  ${c.threshold.toFixed(2)}    ${pctCell(c.share)}    ${c.precision === undefined ? '     —' : pctCell(c.precision)}      ${pctCell(c.recall)}`,
      );
    }
    lines.push('');
  }
  const skips = Object.entries(skipped);
  if (skips.length > 0) {
    lines.push(
      'skipped — truth values with no matching answer, the wrong kind, or an undeclared option or level',
      ...skips.map(([question, count]) => `  ${question}: ${count}`),
    );
  }
  return lines.join('\n');
}

function pctCell(value: number): string {
  return `${(value * 100).toFixed(1)}%`.padStart(6);
}
