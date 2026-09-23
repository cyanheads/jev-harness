/**
 * src/run/report.ts
 *
 * Plain-text summary of a run: per-question distributions (Choice option
 * shares, Score mean and level shares, Noul yes-rate), confidence, latency
 * percentiles, tokens and cost, and tallies of `derived` fields.
 */

import type { Experiment } from '../experiments/index.ts';
import type { RunOutcome } from './runner.ts';

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

  for (const [id, question] of Object.entries(experiment.questions)) {
    lines.push('', `[${question.type}] ${id}`);
    const answers = rows.map((r) => r.answers[id]);
    switch (question.type) {
      case 'choice': {
        const picked = answers.filter((a) => a?.type === 'choice');
        const conf = picked.map((a) => a.confidence);
        lines.push(
          `  confidence mean ${mean(conf).toFixed(2)} · min ${Math.min(...conf).toFixed(2)}`,
        );
        lines.push(...shareLines(tally(picked.map((a) => a.choice)), n));
        break;
      }
      case 'score': {
        const scored = answers.filter((a) => a?.type === 'score');
        const scores = scored.map((a) => a.score);
        const conf = scored.map((a) => a.confidence);
        lines.push(
          `  score mean ${mean(scores).toFixed(2)} of 0–${question.criteria.length - 1} · confidence mean ${mean(conf).toFixed(2)}`,
        );
        const levels = scores.map((s) => {
          const level = Math.round(s);
          const label = question.criteria[level] ?? '';
          return `${level} ${typeof label === 'string' ? label : JSON.stringify(label)}`;
        });
        lines.push(...shareLines(tally(levels), n));
        break;
      }
      case 'noul': {
        const p = answers.filter((a) => a?.type === 'noul').map((a) => a.noul);
        const yes = p.filter((x) => x > 0.5).length;
        const unsure = p.filter((x) => x >= 0.35 && x <= 0.65).length;
        lines.push(
          `  mean ${mean(p).toFixed(2)} · yes (>0.5) ${pct(yes, n)} · unsure (0.35–0.65) ${pct(unsure, n)}`,
        );
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

function tally(values: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const v of values) counts[v] = (counts[v] ?? 0) + 1;
  return counts;
}

function shareLines(counts: Record<string, number>, total: number): string[] {
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `  ${pct(v, total).padStart(6)}  ${String(v).padStart(5)}  ${k}`);
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
