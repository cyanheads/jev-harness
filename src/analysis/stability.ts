/**
 * src/analysis/stability.ts
 *
 * Run-to-run stability: the same records sent more than once. For every record
 * present in all runs, each question contributes its largest pairwise
 * difference — per-option probability for a Choice, the probability for a Noul,
 * the weighted score for a Score. A Choice also counts flips: records whose
 * chosen option differs between any two runs.
 */

import type { Answer } from '../questions/index.ts';
import type { RunRow } from '../run/index.ts';

export interface QuestionStability {
  readonly question: string;
  readonly type: Answer['type'];
  /** Records answered in every run. */
  readonly n: number;
  /** Choice only: records whose chosen option changed between runs. */
  readonly flips?: number;
  readonly meanAbsDiff: number;
  readonly maxAbsDiff: number;
  /** Records whose largest difference exceeded 0.05. */
  readonly over005: number;
}

export function stability(runs: readonly (readonly RunRow[])[]): QuestionStability[] {
  if (runs.length < 2) throw new Error('stability needs at least two runs');
  const byId = runs.map((rows) => new Map(rows.map((r) => [r.id, r])));
  const [first, ...others] = byId;
  if (!first) throw new Error('unreachable: runs is non-empty');
  const shared = [...first.keys()].filter((id) => others.every((m) => m.has(id)));

  const diffs = new Map<string, { type: Answer['type']; values: number[]; flips: number }>();
  for (const id of shared) {
    const rows = byId.map((m) => m.get(id) as RunRow);
    for (const question of Object.keys(rows[0]?.answers ?? {})) {
      const present = rows.map((r) => r.answers[question]).filter((a) => a !== undefined);
      const head = present[0];
      if (!head || present.length < rows.length || present.some((a) => a.type !== head.type)) {
        continue;
      }
      const entry = diffs.get(question) ?? { type: head.type, values: [], flips: 0 };
      entry.values.push(spread(present));
      if (head.type === 'choice') {
        const picks = new Set(present.map((a) => (a.type === 'choice' ? a.choice : '')));
        if (picks.size > 1) entry.flips += 1;
      }
      diffs.set(question, entry);
    }
  }

  return [...diffs.entries()].map(([question, { type, values, flips }]) => ({
    question,
    type,
    n: values.length,
    ...(type === 'choice' && { flips }),
    meanAbsDiff: values.reduce((s, v) => s + v, 0) / values.length,
    maxAbsDiff: Math.max(...values),
    over005: values.filter((v) => v > 0.05).length,
  }));
}

/** Largest difference across runs of the quantity that defines the answer. */
export function spread(answers: readonly Answer[]): number {
  const series: number[][] = [];
  const head = answers[0];
  if (head?.type === 'choice') {
    for (const option of Object.keys(head.probabilities)) {
      series.push(answers.map((a) => (a.type === 'choice' ? (a.probabilities[option] ?? 0) : 0)));
    }
  } else {
    series.push(
      answers.map((a) => (a.type === 'noul' ? a.noul : a.type === 'score' ? a.score : 0)),
    );
  }
  return Math.max(...series.map((values) => Math.max(...values) - Math.min(...values)));
}

export function renderStability(results: readonly QuestionStability[], runCount: number): string {
  const lines = [
    `${runCount} runs`,
    'question              type      n   flips   mean |Δ|   max |Δ|   >0.05',
  ];
  for (const r of results) {
    lines.push(
      `${r.question.padEnd(20)}  ${r.type.padEnd(6)}  ${String(r.n).padStart(4)}   ${String(r.flips ?? '—').padStart(5)}   ${r.meanAbsDiff.toFixed(4)}     ${r.maxAbsDiff.toFixed(3)}     ${String(r.over005).padStart(4)}`,
    );
  }
  return lines.join('\n');
}
