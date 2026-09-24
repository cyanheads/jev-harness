/**
 * src/run/report.ts
 *
 * Plain-text summary of a run: per-question distributions (Choice option
 * shares, Score mean and level shares, Noul yes-rate), confidence, latency
 * percentiles, tokens and cost, and tallies of `derived` fields.
 *
 * A question whose answer barely varies gets a note: over at least 20 rows, one
 * option or level taking 90% of them, or a Noul above 0.5 on 75% of them. A
 * question that is true of most records separates nothing.
 */

import type { Experiment } from '../experiments/index.ts';
import type { Answer, Entry } from '../questions/index.ts';
import type { RunOutcome, RunRow } from './runner.ts';

const NOTE_MIN_ROWS = 20;
const NOTE_TOP_SHARE = 0.9;
const NOTE_NOUL_YES_SHARE = 0.75;
/** Options listed per question before the rest are summed into one line. */
const MAX_SHARE_LINES = 15;

interface QuestionInfo {
  readonly id: string;
  readonly type: Answer['type'];
  /** Score level labels, index 0 first. */
  readonly levels: readonly string[];
}

export function renderReport(experiment: Experiment, outcome: RunOutcome): string {
  const { rows, failures } = outcome;
  const lines: string[] = [];
  const n = rows.length;
  lines.push(`${experiment.name} — ${n} row(s), ${failures.length} failure(s)`);
  if (n === 0) return lines.join('\n');

  const models = new Set(rows.map((r) => r.model));
  const latencies = rows.map((r) => r.latencyMs).sort((a, b) => a - b);
  const tokens = rows.reduce((s, r) => s + r.usage.inputTokens, 0);
  const cost = rows.reduce((s, r) => s + r.costUsd, 0);
  lines.push(`model: ${[...models].join(', ')}`);
  lines.push(
    `latency p50 ${percentile(latencies, 0.5)}ms · p95 ${percentile(latencies, 0.95)}ms · max ${latencies.at(-1)}ms`,
  );
  lines.push(
    `input tokens ${tokens} · cost $${cost.toFixed(6)} · $${((cost / n) * 1000).toFixed(4)} per 1k rows`,
  );

  for (const { id, type, levels } of questionIndex(experiment, rows)) {
    const answers = rows.map((r) => r.answers[id]);
    const answered = answers.filter((a) => a !== undefined).length;
    lines.push(
      '',
      `[${type}] ${id}${answered < n ? ` — answered in ${answered} of ${n} rows` : ''}`,
    );
    switch (type) {
      case 'choice': {
        const picked = answers.filter((a) => a?.type === 'choice');
        const conf = picked.map((a) => a.confidence);
        lines.push(
          `  confidence mean ${mean(conf).toFixed(2)} · min ${Math.min(...conf).toFixed(2)}`,
        );
        const counts = tally(picked.map((a) => a.choice));
        lines.push(...shareLines(counts, answered), ...topShareNote(counts, answered));
        break;
      }
      case 'score': {
        const scored = answers.filter((a) => a?.type === 'score');
        const scores = scored.map((a) => a.score);
        const conf = scored.map((a) => a.confidence);
        lines.push(
          `  score mean ${mean(scores).toFixed(2)} of 0–${levels.length - 1} · confidence mean ${mean(conf).toFixed(2)}`,
        );
        const counts = tally(
          scores.map((s) => {
            const level = Math.round(s);
            return `${level} ${levels[level] ?? ''}`;
          }),
        );
        lines.push(...shareLines(counts, answered), ...topShareNote(counts, answered));
        break;
      }
      case 'noul': {
        const p = answers.filter((a) => a?.type === 'noul').map((a) => a.noul);
        const yes = p.filter((x) => x > 0.5).length;
        const unsure = p.filter((x) => x >= 0.35 && x <= 0.65).length;
        lines.push(
          `  mean ${mean(p).toFixed(2)} · yes (>0.5) ${pct(yes, answered)} · unsure (0.35–0.65) ${pct(unsure, answered)}`,
        );
        if (answered >= NOTE_MIN_ROWS && yes / answered >= NOTE_NOUL_YES_SHARE) {
          lines.push(
            `  ! yes on ${pct(yes, answered)} of rows; a question true of most records separates little`,
          );
        }
        break;
      }
    }
  }

  const derivedKeys = new Set(rows.flatMap((r) => Object.keys(r.derived ?? {})));
  if (derivedKeys.size > 0) {
    lines.push('', 'derived');
    for (const key of derivedKeys) {
      const values = rows.map((r) => r.derived?.[key]).filter((v) => v !== undefined);
      if (values.every((v) => typeof v === 'number')) {
        lines.push(`  ${key}: mean ${mean(values).toFixed(3)}`);
      } else {
        lines.push(`  ${key}`, ...shareLines(tally(values.map(String)), n).map((l) => `  ${l}`));
      }
    }
  }

  if (failures.length > 0) {
    lines.push('', 'failures');
    for (const f of failures.slice(0, 10)) lines.push(`  ${f.id}: ${f.error}`);
    if (failures.length > 10) lines.push(`  … and ${failures.length - 10} more`);
  }
  return lines.join('\n');
}

/**
 * Questions in declaration order. Questions built per record are read from the
 * answers instead, in the order the rows first answer them, with Score level
 * labels from the answer's legend.
 */
function questionIndex(experiment: Experiment, rows: readonly RunRow[]): QuestionInfo[] {
  const { questions } = experiment;
  if (typeof questions !== 'function') {
    return Object.entries(questions).map(([id, q]) => ({
      id,
      type: q.type,
      levels: q.type === 'score' ? q.criteria.map(entryLabel) : [],
    }));
  }
  const seen = new Map<string, QuestionInfo>();
  for (const row of rows) {
    for (const [id, answer] of Object.entries(row.answers)) {
      if (seen.has(id)) continue;
      const levels =
        answer.type === 'score'
          ? Object.entries(answer.legend)
              .sort(([a], [b]) => Number(a) - Number(b))
              .map(([, label]) => label)
          : [];
      seen.set(id, { id, type: answer.type, levels });
    }
  }
  return [...seen.values()];
}

function entryLabel(entry: Entry): string {
  return typeof entry === 'string' ? entry : JSON.stringify(entry);
}

function topShareNote(counts: Record<string, number>, total: number): string[] {
  const top = Math.max(...Object.values(counts));
  return total >= NOTE_MIN_ROWS && top / total >= NOTE_TOP_SHARE
    ? [
        `  ! one answer on ${pct(top, total)} of rows; a question that rarely changes separates little`,
      ]
    : [];
}

function tally(values: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const v of values) counts[v] = (counts[v] ?? 0) + 1;
  return counts;
}

function shareLines(counts: Record<string, number>, total: number): string[] {
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const lines = sorted
    .slice(0, MAX_SHARE_LINES)
    .map(([k, v]) => `  ${pct(v, total).padStart(6)}  ${String(v).padStart(5)}  ${k}`);
  const rest = sorted.slice(MAX_SHARE_LINES);
  if (rest.length > 0) {
    const restCount = rest.reduce((s, [, v]) => s + v, 0);
    lines.push(
      `  ${pct(restCount, total).padStart(6)}  ${String(restCount).padStart(5)}  (${rest.length} more)`,
    );
  }
  return lines;
}

function pct(part: number, total: number): string {
  return `${((part / total) * 100).toFixed(1)}%`;
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((s, v) => s + v, 0) / values.length;
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1);
  return sorted[Math.max(0, index)] ?? 0;
}
