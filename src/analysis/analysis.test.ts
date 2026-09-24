import { describe, expect, test } from 'bun:test';
import type { Answer } from '../questions/index.ts';
import type { RunRow } from '../run/index.ts';
import {
  calibrate,
  compare,
  renderCalibration,
  renderComparison,
  stability,
  type Truth,
  truthLineSchema,
} from './index.ts';

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

  test('scores a Score against a level index, by its most probable level', () => {
    const level = (s: number, probabilities: Record<string, number>): Answer => ({
      type: 'score',
      score: s,
      legend: { '0': 'low', '1': 'mid', '2': 'high' },
      probabilities,
      confidence: 0.8,
    });
    const rows = [
      row('a', { sev: level(1.8, { '0': 0, '1': 0.2, '2': 0.8 }) }),
      row('b', { sev: level(0.6, { '0': 0.5, '1': 0.4, '2': 0.1 }) }),
    ];
    const truth = new Map<string, Truth>([
      ['a', { sev: 2 }],
      ['b', { sev: 1 }],
    ]);
    const { questions, skipped } = calibrate(rows, truth);
    expect(questions[0]?.type).toBe('score');
    expect(questions[0]?.accuracy).toBe(0.5);
    expect(questions[0]?.meanLevelError).toBeCloseTo(0.3);
    expect(skipped).toEqual({});
    expect(calibrate(rows, new Map([['a', { sev: 3 }]])).skipped).toEqual({ sev: 1 });
    expect(renderCalibration({ questions, skipped })).toContain('mean level error 0.300');
  });

  test('sweeps thresholds: rows kept, precision among them, and recall', () => {
    const rows = [
      row('a', { flag: { type: 'noul', noul: 0.95 } }),
      row('b', { flag: { type: 'noul', noul: 0.75 } }),
      row('c', { flag: { type: 'noul', noul: 0.35 } }),
      row('d', { flag: { type: 'noul', noul: 0.05 } }),
    ];
    const truth = new Map<string, Truth>([
      ['a', { flag: true }],
      ['b', { flag: false }],
      ['c', { flag: true }],
      ['d', { flag: false }],
    ]);
    const sweep = calibrate(rows, truth).questions[0]?.sweep ?? [];
    const at = (t: number) => sweep.find((c) => c.threshold === t);
    expect(at(0.7)).toEqual({ threshold: 0.7, share: 0.5, precision: 0.5, recall: 0.5 });
    expect(at(0.3)).toEqual({ threshold: 0.3, share: 0.75, precision: 2 / 3, recall: 1 });
    expect(at(0.95)?.precision).toBe(1);
    expect(sweep.every((c) => c.threshold <= 0.95)).toBe(true);
  });

  test('a truth file takes option keys, level indexes, and booleans', () => {
    const line = { id: 7, truth: { kind: 'bug', sev: 2, flag: true } };
    expect(truthLineSchema.parse(line)).toEqual({ id: '7', truth: line.truth });
    expect(() => truthLineSchema.parse({ id: 'a', truth: { sev: 1.5 } })).toThrow();
  });
});

describe('compare', () => {
  test('reports changes, shift, and the records that changed', () => {
    const before = [
      row('a', { kind: kind('bug', 0.9), flag: { type: 'noul', noul: 0.6 } }),
      row('b', { kind: kind('bug', 0.8), flag: { type: 'noul', noul: 0.2 } }),
      row('c', { kind: kind('feat', 0.9) }),
    ];
    const after = [
      row('a', { kind: kind('feat', 0.7), flag: { type: 'noul', noul: 0.3 } }),
      row('b', { kind: kind('bug', 0.85), flag: { type: 'noul', noul: 0.3 } }),
      row('d', { kind: kind('feat', 0.9) }),
    ];
    const result = compare(before, after);
    expect(result.shared).toBe(2);
    expect(result.onlyA).toBe(1);
    expect(result.onlyB).toBe(1);
    const kindResult = result.questions.find((q) => q.question === 'kind');
    const flagResult = result.questions.find((q) => q.question === 'flag');
    expect(kindResult?.changed).toBe(1);
    expect(kindResult?.meanShift).toBeUndefined();
    expect(kindResult?.examples).toEqual([
      { id: 'a', a: 'bug 0.90', b: 'feat 0.70', diff: expect.closeTo(0.6) },
    ]);
    expect(flagResult?.changed).toBe(1);
    expect(flagResult?.meanShift).toBeCloseTo(-0.1);
    const text = renderComparison(result, ['v1.jsonl', 'v2.jsonl']);
    expect(text).toContain('shared records 2 · only in a 1 · only in b 1');
    expect(text).toContain('  a: bug 0.90 → feat 0.70');
    expect(text).toContain('-0.1000');
  });

  test('lists questions only one run asked and answers whose type changed', () => {
    const before = [row('a', { old: { type: 'noul', noul: 0.5 }, q: { type: 'noul', noul: 0.5 } })];
    const after = [row('a', { new: { type: 'noul', noul: 0.5 }, q: kind('bug', 0.9) })];
    const result = compare(before, after);
    expect(result.questionsOnlyA).toEqual(['old']);
    expect(result.questionsOnlyB).toEqual(['new']);
    expect(result.retyped).toEqual({ q: 1 });
    expect(result.questions).toEqual([]);
  });

  test('refuses two runs with no record in common', () => {
    const runA = [row('a', { flag: { type: 'noul', noul: 0.4 } })];
    const runB = [row('b', { flag: { type: 'noul', noul: 0.4 } })];
    expect(() => compare(runA, runB)).toThrow('share no record ids');
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
