/**
 * src/analysis/calibration.ts
 *
 * Reliability of Jev's probabilities against known answers. For a Choice the
 * prediction is the confidence of the chosen option and the outcome is whether
 * that option was correct; for a Noul the prediction is the probability and the
 * outcome is the true/false label. Scores carry no comparable truth and are
 * skipped. A well-calibrated question has `observed` tracking `meanPredicted`
 * in every bin.
 */

import type { RunRow } from '../run/index.ts';

/** Correct answers for one record: question id → option key (Choice) or boolean (Noul). */
export type Truth = Readonly<Record<string, string | boolean>>;

export interface ReliabilityBin {
  readonly lo: number;
  readonly hi: number;
  readonly n: number;
  readonly meanPredicted: number;
  /** Share of rows in the bin whose outcome was positive. */
  readonly observed: number;
}

export interface QuestionCalibration {
  readonly question: string;
  readonly type: 'choice' | 'noul';
  /** Rows that had both an answer and a usable truth value. */
  readonly n: number;
  /** Choice: top-1 accuracy. Noul: accuracy at a 0.5 threshold. */
  readonly accuracy: number;
  /** Mean squared error of the probabilities; multiclass sum for a Choice. Lower is better. */
  readonly brier: number;
  /** Expected calibration error: bin-weighted mean of |observed − meanPredicted|. */
  readonly ece: number;
  readonly bins: readonly ReliabilityBin[];
}

interface Point {
  readonly predicted: number;
  readonly outcome: boolean;
  readonly correct: boolean;
  readonly squaredError: number;
}

export function calibrate(
  rows: readonly RunRow[],
  truth: ReadonlyMap<string, Truth>,
  binCount = 10,
): QuestionCalibration[] {
  const points = new Map<string, { type: 'choice' | 'noul'; points: Point[] }>();
  for (const row of rows) {
    const answers = truth.get(row.id);
    if (!answers) continue;
    for (const [question, expected] of Object.entries(answers)) {
      const answer = row.answers[question];
      if (!answer) continue;
      let point: Point | undefined;
      if (answer.type === 'choice' && typeof expected === 'string') {
        if (!(expected in answer.probabilities)) continue;
        const correct = answer.choice === expected;
        point = {
          predicted: answer.confidence,
          outcome: correct,
          correct,
          squaredError: Object.entries(answer.probabilities).reduce(
            (sum, [option, p]) => sum + (p - (option === expected ? 1 : 0)) ** 2,
            0,
          ),
        };
      } else if (answer.type === 'noul' && typeof expected === 'boolean') {
        point = {
          predicted: answer.noul,
          outcome: expected,
          correct: answer.noul >= 0.5 === expected,
          squaredError: (answer.noul - (expected ? 1 : 0)) ** 2,
        };
      }
      if (!point) continue;
      const entry = points.get(question) ?? { type: answer.type as 'choice' | 'noul', points: [] };
      entry.points.push(point);
      points.set(question, entry);
    }
  }

  return [...points.entries()].map(([question, { type, points: pts }]) => {
    const bins = toBins(pts, binCount);
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
      bins,
    };
  });
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

export function renderCalibration(results: readonly QuestionCalibration[]): string {
  const lines: string[] = [];
  for (const r of results) {
    lines.push(
      `[${r.type}] ${r.question} — n ${r.n} · accuracy ${(r.accuracy * 100).toFixed(1)}% · brier ${r.brier.toFixed(3)} · ece ${r.ece.toFixed(3)}`,
      '  bin          n   predicted  observed   gap',
    );
    for (const b of r.bins) {
      const gap = b.observed - b.meanPredicted;
      lines.push(
        `  ${b.lo.toFixed(1)}–${b.hi.toFixed(1)}  ${String(b.n).padStart(6)}   ${b.meanPredicted.toFixed(3)}      ${b.observed.toFixed(3)}    ${gap >= 0 ? '+' : ''}${gap.toFixed(3)}`,
      );
    }
    lines.push('');
  }
  return lines.join('\n');
}
