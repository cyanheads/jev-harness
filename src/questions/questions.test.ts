import { describe, expect, test } from 'bun:test';
import { answerSchema, assertAnswerMatches, choice, noul, score } from './index.ts';

describe('builders', () => {
  test('choice keeps option keys', () => {
    const q = choice('Which team?', { billing: 'Money', technical: 'Bugs' });
    expect(q.type).toBe('choice');
    expect(Object.keys(q.criteria)).toEqual(['billing', 'technical']);
  });

  test('choice rejects no options or more than 255', () => {
    expect(() => choice('Which?', {})).toThrow(/got 0/);
    const many = Object.fromEntries(Array.from({ length: 256 }, (_, i) => [`o${i}`, null]));
    expect(() => choice('Which?', many)).toThrow(/got 256/);
  });

  test('score rejects fewer than two or more than ten levels', () => {
    expect(() => score('How bad?', ['one'])).toThrow();
    expect(() =>
      score(
        'How bad?',
        Array.from({ length: 11 }, (_, i) => `l${i}`),
      ),
    ).toThrow();
    expect(score('How bad?', ['low', 'high']).criteria).toHaveLength(2);
  });

  test('noul omits criteria when not given', () => {
    expect(noul('Urgent?')).toEqual({ type: 'noul', instructions: 'Urgent?' });
    expect(noul('Urgent?', { true: 'yes', false: 'no' }).criteria).toEqual({
      true: 'yes',
      false: 'no',
    });
  });
});

describe('answers', () => {
  test('schema parses each answer type', () => {
    expect(answerSchema.parse({ type: 'noul', noul: 0.9 }).type).toBe('noul');
    expect(
      answerSchema.parse({
        type: 'choice',
        choice: 'a',
        probabilities: { a: 0.9, b: 0.1 },
        confidence: 0.8,
      }).type,
    ).toBe('choice');
    expect(
      answerSchema.parse({
        type: 'score',
        score: 1.2,
        legend: { '0': 'low', '1': 'high' },
        probabilities: { '0': 0.4, '1': 0.6 },
        confidence: 0.5,
      }).type,
    ).toBe('score');
  });

  test('assertAnswerMatches rejects type and option mismatches', () => {
    const q = choice('Which?', { a: null, b: null });
    expect(() => assertAnswerMatches('q', q, { type: 'noul', noul: 0.5 })).toThrow(/type/);
    expect(() =>
      assertAnswerMatches('q', q, {
        type: 'choice',
        choice: 'zzz',
        probabilities: { zzz: 1 },
        confidence: 1,
      }),
    ).toThrow(/not one of/);
  });
});
