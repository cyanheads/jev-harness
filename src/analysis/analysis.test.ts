import { describe, expect, test } from 'bun:test';
import type { Answer } from '../questions/index.ts';
import type { RunRow } from '../run/index.ts';
import { calibrate, renderCalibration, stability, type Truth } from './index.ts';

function row(id: string, answers: Record<string, Answer>): RunRow {
  return {
    id,
    experiment: 't',
    model: 'm',
    answers,
    usage: { inputTokens: 0, outputTokens: 0 },
    costUsd: 0,
    latencyMs: 0,
    attempts: 1,
  };
}

const kind = (choice: string, p: number): Answer => ({
  type: 'choice',
  choice,
  probabilities: { bug: choice === 'bug' ? p : 1 - p, feat: choice === 'feat' ? p : 1 - p },
  confidence: p,
});

describe('calibrate', () => {
  test('scores a Choice on top-1 accuracy and bins by confidence', () => {
    const rows = [row('a', { kind: kind('bug', 0.95) }), row('b', { kind: kind('bug', 0.95) })];
    const truth = new Map<string, Truth>([
      ['a', { kind: 'bug' }],
      ['b', { kind: 'feat' }],
    ]);
    const [result] = calibrate(rows, truth).questions;
    expect(result?.n).toBe(2);
    expect(result?.accuracy).toBe(0.5);
    expect(result?.bins).toHaveLength(1);
    expect(result?.bins[0]?.observed).toBe(0.5);
    expect(result?.ece).toBeCloseTo(0.45);
  });

  test('scores a Noul against a boolean and skips rows without truth', () => {
    const rows = [
      row('a', { flag: { type: 'noul', noul: 0.9 } }),
      row('b', { flag: { type: 'noul', noul: 0.1 } }),
      row('c', { flag: { type: 'noul', noul: 0.5 } }),
    ];
    const truth = new Map<string, Truth>([
      ['a', { flag: true }],
      ['b', { flag: false }],
    ]);
    const { questions, skipped } = calibrate(rows, truth);
    expect(questions[0]?.n).toBe(2);
    expect(questions[0]?.accuracy).toBe(1);
    expect(questions[0]?.brier).toBeCloseTo(0.01);
    expect(skipped).toEqual({});
  });

  test('counts truth values it cannot score instead of dropping them', () => {
    const rows = [row('a', { kind: kind('bug', 0.8), flag: { type: 'noul', noul: 0.9 } })];
    const truth = new Map<string, Truth>([['a', { kind: 'chore', flag: 'yes', missing: true }]]);
    const result = calibrate(rows, truth);
    expect(result.questions).toEqual([]);
    expect(result.skipped).toEqual({ kind: 1, flag: 1, missing: 1 });
    expect(renderCalibration(result)).toContain('  kind: 1');
  });
});

describe('stability', () => {
  test('reports flips and the largest difference per record', () => {
    const runA = [row('a', { kind: kind('bug', 0.6), flag: { type: 'noul', noul: 0.4 } })];
    const runB = [row('a', { kind: kind('feat', 0.7), flag: { type: 'noul', noul: 0.42 } })];
    const results = stability([runA, runB]);
    const kindResult = results.find((r) => r.question === 'kind');
    const flagResult = results.find((r) => r.question === 'flag');
    expect(kindResult?.flips).toBe(1);
    expect(kindResult?.maxAbsDiff).toBeCloseTo(0.3);
    expect(flagResult?.maxAbsDiff).toBeCloseTo(0.02);
    expect(flagResult?.over005).toBe(0);
  });

  test('only compares records present in every run', () => {
    const runA = [row('a', { flag: { type: 'noul', noul: 0.4 } })];
    const runB = [row('b', { flag: { type: 'noul', noul: 0.4 } })];
    expect(stability([runA, runB])).toEqual([]);
  });
});
