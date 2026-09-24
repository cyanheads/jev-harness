/**
 * src/analysis/compare.ts
 *
 * Two runs over the same records, read as before (a) and after (b): a reworded
 * question, a new model version, a changed state mapper. Unlike `stability`,
 * which measures noise between identical runs, this is directional: a Noul or
 * Score reports its mean shift from a to b, and every question lists the
 * records whose answer changed. A Choice changes when its pick differs, a Score
 * when its rounded level differs, a Noul when it crosses 0.5.
 */

import type { Answer } from '../questions/index.ts';
import type { RunRow } from '../run/index.ts';
import { spread } from './stability.ts';

const MAX_EXAMPLES = 10;

export interface ChangedRecord {
  readonly id: string;
  readonly a: string;
  readonly b: string;
  readonly diff: number;
}

export interface QuestionComparison {
  readonly question: string;
  readonly type: Answer['type'];
  /** Shared records answered in both runs. */
  readonly n: number;
  readonly changed: number;
  /** Noul and Score: mean of b − a (probability of yes, weighted score). */
  readonly meanShift?: number;
  /** Choice: largest per-option probability difference. Noul and Score: |b − a|. */
  readonly meanAbsDiff: number;
  readonly maxAbsDiff: number;
  /** Changed records, largest difference first. */
  readonly examples: readonly ChangedRecord[];
}

export interface Comparison {
  readonly shared: number;
  readonly onlyA: number;
  readonly onlyB: number;
  readonly modelsA: readonly string[];
  readonly modelsB: readonly string[];
  readonly questionsOnlyA: readonly string[];
  readonly questionsOnlyB: readonly string[];
  /** Records where a question's answer has a different type in each run, by question id. */
  readonly retyped: Readonly<Record<string, number>>;
  readonly questions: readonly QuestionComparison[];
}

export function compare(runA: readonly RunRow[], runB: readonly RunRow[]): Comparison {
  const byIdB = new Map(runB.map((r) => [r.id, r]));
  const idsA = new Set(runA.map((r) => r.id));
  const pairs = runA.flatMap((a) => {
    const b = byIdB.get(a.id);
    return b ? [[a, b] as const] : [];
  });
  // Two runs over different inputs are a wrong pair of files, not a comparison with no changes.
  if (pairs.length === 0) throw new Error('the two runs share no record ids');

  const questionIds = (rows: readonly RunRow[]): Set<string> =>
    new Set(rows.flatMap((r) => Object.keys(r.answers)));
  const inA = questionIds(pairs.map(([a]) => a));
  const inB = questionIds(pairs.map(([, b]) => b));

  const retyped: Record<string, number> = {};
  const collected = new Map<
    string,
    { type: Answer['type']; diffs: number[]; shifts: number[]; changed: ChangedRecord[] }
  >();
  for (const [rowA, rowB] of pairs) {
    for (const [question, a] of Object.entries(rowA.answers)) {
      const b = rowB.answers[question];
      if (!b) continue;
      if (a.type !== b.type) {
        retyped[question] = (retyped[question] ?? 0) + 1;
        continue;
      }
      const entry = collected.get(question) ?? { type: a.type, diffs: [], shifts: [], changed: [] };
      const diff = spread([a, b]);
      entry.diffs.push(diff);
      const shift = numeric(b) - numeric(a);
      if (a.type !== 'choice') entry.shifts.push(shift);
      if (label(a, true) !== label(b, true)) {
        entry.changed.push({ id: rowA.id, a: label(a, false), b: label(b, false), diff });
      }
      collected.set(question, entry);
    }
  }

  const models = (rows: readonly RunRow[]): string[] => [...new Set(rows.map((r) => r.model))];
  return {
    shared: pairs.length,
    onlyA: runA.length - pairs.length,
    onlyB: runB.filter((r) => !idsA.has(r.id)).length,
    modelsA: models(runA),
    modelsB: models(runB),
    questionsOnlyA: [...inA].filter((q) => !inB.has(q)),
    questionsOnlyB: [...inB].filter((q) => !inA.has(q)),
    retyped,
    questions: [...collected.entries()].map(([question, { type, diffs, shifts, changed }]) => ({
      question,
      type,
      n: diffs.length,
      changed: changed.length,
      ...(type !== 'choice' && { meanShift: mean(shifts) }),
      meanAbsDiff: mean(diffs),
      maxAbsDiff: Math.max(...diffs),
      examples: changed.sort((x, y) => y.diff - x.diff).slice(0, MAX_EXAMPLES),
    })),
  };
}

/** The value a shift is measured on: probability of yes, or the weighted score. */
function numeric(answer: Answer): number {
  return answer.type === 'noul' ? answer.noul : answer.type === 'score' ? answer.score : 0;
}

/** The answer as a decision (`coarse`, for detecting a change) or as a value to show. */
function label(answer: Answer, coarse: boolean): string {
  switch (answer.type) {
    case 'choice':
      return coarse
        ? answer.choice
        : `${answer.choice} ${(answer.probabilities[answer.choice] ?? 0).toFixed(2)}`;
    case 'score':
      return coarse ? String(Math.round(answer.score)) : answer.score.toFixed(2);
    case 'noul':
      return coarse ? String(answer.noul >= 0.5) : answer.noul.toFixed(2);
  }
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((s, v) => s + v, 0) / values.length;
}

export function renderComparison(result: Comparison, labels: readonly [string, string]): string {
  const [labelA, labelB] = labels;
  const lines = [
    `a: ${labelA} · model ${result.modelsA.join(', ')}`,
    `b: ${labelB} · model ${result.modelsB.join(', ')}`,
    `shared records ${result.shared} · only in a ${result.onlyA} · only in b ${result.onlyB}`,
  ];
  if (result.questionsOnlyA.length > 0) {
    lines.push(`questions only in a: ${result.questionsOnlyA.join(', ')}`);
  }
  if (result.questionsOnlyB.length > 0) {
    lines.push(`questions only in b: ${result.questionsOnlyB.join(', ')}`);
  }
  lines.push(
    '',
    'question              type      n   changed   mean shift   mean |Δ|   max |Δ|',
    ...result.questions.map(
      (q) =>
        `${q.question.padEnd(20)}  ${q.type.padEnd(6)}  ${String(q.n).padStart(4)}   ${String(q.changed).padStart(7)}   ${(q.meanShift === undefined ? '—' : signed(q.meanShift)).padStart(10)}   ${q.meanAbsDiff.toFixed(4)}     ${q.maxAbsDiff.toFixed(3)}`,
    ),
  );
  for (const q of result.questions) {
    if (q.examples.length === 0) continue;
    lines.push(
      '',
      `changed — ${q.question}${q.changed > q.examples.length ? ` (largest ${q.examples.length} of ${q.changed})` : ''}`,
    );
    for (const e of q.examples) lines.push(`  ${e.id}: ${e.a} → ${e.b}`);
  }
  const retyped = Object.entries(result.retyped);
  if (retyped.length > 0) {
    lines.push(
      '',
      'skipped — answers of a different type in each run',
      ...retyped.map(([question, count]) => `  ${question}: ${count}`),
    );
  }
  return lines.join('\n');
}

function signed(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(4)}`;
}
