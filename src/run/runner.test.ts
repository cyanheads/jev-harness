import { describe, expect, test } from 'bun:test';
import { JevClient } from '../client/index.ts';
import { defineExperiment } from '../experiments/index.ts';
import { choice, noul } from '../questions/index.ts';
import { renderReport, runExperiment } from './index.ts';

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
});
