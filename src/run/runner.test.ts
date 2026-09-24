import { describe, expect, test } from 'bun:test';
import { JevClient } from '../client/index.ts';
import { defineExperiment } from '../experiments/index.ts';
import { choice, noul, score } from '../questions/index.ts';
import { type RunRow, renderReport, runExperiment } from './index.ts';

const experiment = defineExperiment({
  name: 'test-exp',
  description: 'routes tickets',
  questions: {
    dept: choice('Which team?', { billing: 'money', technical: 'bugs' }),
    urgent: noul('Urgent?'),
  },
  state: (record: { text: string }) => record.text,
  derive: (answers, record) => ({
    escalate: answers.urgent.noul > 0.5 && answers.dept.choice === 'technical',
    len: record.text.length,
  }),
});

function clientWith(handler: (body: { state: unknown }) => Response): JevClient {
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) =>
    handler(JSON.parse(String(init?.body)))) as typeof fetch;
  return new JevClient({ provider: 'openrouter', apiKey: 'k', fetch: fetchImpl, maxAttempts: 1 });
}

function ok(dept: string, urgent: number): Response {
  return Response.json({
    model: 'typesafe/jev-1.13-x',
    answers: {
      dept: {
        type: 'choice',
        choice: dept,
        probabilities: { billing: 0.5, technical: 0.5 },
        confidence: 0.6,
      },
      urgent: { type: 'noul', noul: urgent },
    },
    usage: { input_tokens: 100, output_tokens: 2 },
  });
}

describe('runExperiment', () => {
  test('runs every record, keeps derived fields, isolates failures', async () => {
    const client = clientWith((body) =>
      body.state === 'boom' ? new Response('nope', { status: 422 }) : ok('technical', 0.9),
    );
    const records = [
      { id: 'a', data: { text: 'server down' } },
      { id: 'b', data: { text: 'boom' } },
      { id: 'c', data: { text: 'billing q' } },
    ];
    const seen: string[] = [];
    const outcome = await runExperiment(client, experiment, records, {
      concurrency: 2,
      keepState: true,
      onRow: (row) => {
        seen.push(row.id);
      },
    });
    expect(outcome.rows.map((r) => r.id).sort()).toEqual(['a', 'c']);
    expect(outcome.failures).toEqual([{ id: 'b', error: expect.stringContaining('422') }]);
    expect(seen.sort()).toEqual(['a', 'c']);
    expect(outcome.rows[0]?.derived).toEqual({ escalate: true, len: expect.any(Number) });
    expect(outcome.rows[0]?.state).toBeDefined();
    expect(outcome.rows[0]?.input).toBeUndefined();
  });

  test('a throwing onRow ends the run instead of filing the record as a failure', async () => {
    const client = clientWith(() => ok('billing', 0.2));
    const failures: string[] = [];
    await expect(
      runExperiment(client, experiment, [{ id: 'a', data: { text: 'x' } }], {
        onRow: () => {
          throw new Error('disk full');
        },
        onFailure: (f) => {
          failures.push(f.id);
        },
      }),
    ).rejects.toThrow('disk full');
    expect(failures).toEqual([]);
  });

  test('a throwing sink stops the workers from taking more records', async () => {
    let calls = 0;
    const client = clientWith((body) => {
      calls += 1;
      return body.state === 'boom' ? new Response('nope', { status: 422 }) : ok('billing', 0.2);
    });
    const records = Array.from({ length: 20 }, (_, i) => ({
      id: String(i),
      data: { text: i === 0 ? 'boom' : 'x' },
    }));
    await expect(
      runExperiment(client, experiment, records, {
        concurrency: 1,
        onFailure: () => {
          throw new Error('disk full');
        },
      }),
    ).rejects.toThrow('disk full');
    expect(calls).toBe(1);
  });

  test('stops at the first auth failure instead of failing every record', async () => {
    let calls = 0;
    const client = clientWith(() => {
      calls += 1;
      return new Response('{"error":{"message":"User not found."}}', { status: 401 });
    });
    const records = Array.from({ length: 50 }, (_, i) => ({ id: String(i), data: { text: 'x' } }));
    await expect(runExperiment(client, experiment, records, { concurrency: 2 })).rejects.toThrow(
      /401/,
    );
    expect(calls).toBeLessThanOrEqual(2);
  });

  test('report tallies answers and derived fields', async () => {
    const client = clientWith(() => ok('billing', 0.2));
    const outcome = await runExperiment(client, experiment, [
      { id: '1', data: { text: 'x' } },
      { id: '2', data: { text: 'yy' } },
    ]);
    const report = renderReport(experiment, outcome);
    expect(report).toContain('test-exp — 2 row(s), 0 failure(s)');
    expect(report).toContain('[choice] dept');
    expect(report).toContain('100.0%      2  billing');
    expect(report).toContain('[noul] urgent');
    expect(report).toContain('escalate');
    expect(report).toContain('len: mean 1.500');
  });

  test('report labels a structured score level as JSON', () => {
    const scored = defineExperiment({
      name: 'scored',
      description: 'one score',
      questions: { level: score('How bad?', ['fine', { label: 'broken' }]) },
      state: () => 'x',
    });
    const row = {
      id: '1',
      experiment: 'scored',
      model: 'm',
      answers: {
        level: { type: 'score', score: 1, legend: {}, probabilities: {}, confidence: 1 },
      },
      usage: { inputTokens: 1, outputTokens: 0 },
      costUsd: 0,
      latencyMs: 1,
      attempts: 1,
    } as const;
    expect(renderReport(scored, { rows: [row], failures: [] })).toContain('1 {"label":"broken"}');
  });

  test('report notes a question whose answer barely varies, from 20 rows up', async () => {
    const client = clientWith(() => ok('billing', 0.9));
    const records = (count: number) =>
      Array.from({ length: count }, (_, i) => ({ id: String(i), data: { text: 'x' } }));
    const many = renderReport(experiment, await runExperiment(client, experiment, records(20)));
    expect(many).toContain('! one answer on 100.0% of rows');
    expect(many).toContain('! yes on 100.0% of rows');
    const few = renderReport(experiment, await runExperiment(client, experiment, records(19)));
    expect(few).not.toContain('!');
  });
});

describe('questions built per record', () => {
  const perRecord = defineExperiment({
    name: 'per-record',
    description: 'options come from the record',
    questions: (record: { text: string; options: string[] }) => ({
      pick: choice('Which fits?', Object.fromEntries(record.options.map((o) => [o, null]))),
    }),
    state: (record) => record.text,
    derive: (answers, record) => ({ first: answers.pick.choice === record.options[0] }),
  });

  /** Picks the first option it was offered, and records every option set it saw. */
  function firstOptionClient(seen: string[][]): JevClient {
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      const options = Object.keys(body.questions.pick.criteria);
      seen.push(options);
      return Response.json({
        model: 'm',
        answers: {
          pick: {
            type: 'choice',
            choice: options[0],
            probabilities: Object.fromEntries(options.map((o, i) => [o, i === 0 ? 1 : 0])),
            confidence: 1,
          },
        },
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    }) as typeof fetch;
    return new JevClient({ provider: 'openrouter', apiKey: 'k', fetch: fetchImpl, maxAttempts: 1 });
  }

  test('each record is asked over its own options', async () => {
    const seen: string[][] = [];
    const outcome = await runExperiment(
      firstOptionClient(seen),
      perRecord,
      [
        { id: 'a', data: { text: 'x', options: ['red', 'blue'] } },
        { id: 'b', data: { text: 'y', options: ['cat', 'dog', 'eel'] } },
      ],
      { concurrency: 1 },
    );
    expect(seen).toEqual([
      ['red', 'blue'],
      ['cat', 'dog', 'eel'],
    ]);
    expect(outcome.rows.map((r) => r.derived)).toEqual([{ first: true }, { first: true }]);
    const report = renderReport(perRecord, outcome);
    expect(report).toContain('[choice] pick');
    expect(report).toContain('red');
    expect(report).toContain('cat');
  });

  test('a record that builds no questions fails on its own', async () => {
    const outcome = await runExperiment(firstOptionClient([]), perRecord, [
      { id: 'a', data: { text: 'x', options: [] } },
    ]);
    expect(outcome.rows).toEqual([]);
    expect(outcome.failures[0]?.error).toContain('choice() needs 1–255 options');
  });

  test('a question asked of only some records says so in the report', () => {
    const row = (id: string, answers: RunRow['answers']): RunRow => ({
      id,
      experiment: 'e',
      model: 'm',
      answers,
      usage: { inputTokens: 0, outputTokens: 0 },
      costUsd: 0,
      latencyMs: 0,
      attempts: 1,
    });
    const report = renderReport(perRecord, {
      rows: [
        row('a', { extra: { type: 'noul', noul: 0.9 } }),
        row('b', { other: { type: 'noul', noul: 0.1 } }),
      ],
      failures: [],
    });
    expect(report).toContain('[noul] extra — answered in 1 of 2 rows');
    expect(report).toContain('yes (>0.5) 100.0%');
  });
});
