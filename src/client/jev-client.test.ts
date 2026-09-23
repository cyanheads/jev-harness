import { describe, expect, test } from 'bun:test';
import { choice, noul, score } from '../questions/index.ts';
import { JevClient, JevHttpError, retryDelayMs, stringifyEntries } from './index.ts';

const questions = {
  dept: choice('Which team?', { billing: 'Money', technical: 'Bugs', other: null }),
  urgent: noul('Is it urgent?'),
  mood: score('How annoyed?', ['calm', 'annoyed', 'furious']),
};

const okBody = {
  model: 'typesafe/jev-1.13-20260917',
  answers: {
    dept: {
      type: 'choice',
      choice: 'billing',
      probabilities: { billing: 0.9, technical: 0.05, other: 0.05 },
      confidence: 0.88,
    },
    urgent: { type: 'noul', noul: 0.71 },
    mood: {
      type: 'score',
      score: 1.3,
      legend: { '0': 'calm', '1': 'annoyed', '2': 'furious' },
      probabilities: { '0': 0.1, '1': 0.5, '2': 0.4 },
      confidence: 0.5,
    },
  },
  usage: { input_tokens: 1000, output_tokens: 12 },
};

function fakeFetch(
  responses: Array<{ status: number; body: unknown; headers?: Record<string, string> }>,
) {
  const calls: Array<{ url: string; body: unknown }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    const next = responses.shift();
    if (!next) throw new Error('no more fake responses');
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { 'content-type': 'application/json', ...next.headers },
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe('JevClient', () => {
  test('requires a key for the selected provider', () => {
    expect(() => new JevClient({ provider: 'typesafe', apiKey: '' })).toThrow(/TYPESAFE_API_KEY/);
  });

  test('sends the wire shape, decodes typed answers, computes cost', async () => {
    const { fetchImpl, calls } = fakeFetch([{ status: 200, body: okBody }]);
    const client = new JevClient({ provider: 'openrouter', apiKey: 'k', fetch: fetchImpl });
    const result = await client.ask({ text: 'charged twice' }, questions);

    expect(calls[0]?.url).toBe('https://openrouter.ai/api/alpha/decisions');
    expect(calls[0]?.body).toMatchObject({
      model: 'typesafe/jev-1.13',
      state: { text: 'charged twice' },
    });
    expect(result.answers.dept.choice).toBe('billing');
    expect(result.answers.urgent.noul).toBeCloseTo(0.71);
    expect(result.answers.mood.score).toBeCloseTo(1.3);
    expect(result.costUsd).toBeCloseTo(0.000042);
    expect(result.model).toBe('typesafe/jev-1.13-20260917');
    expect(result.attempts).toBe(1);
  });

  test('retries a 429 honoring retry-after, then succeeds', async () => {
    const { fetchImpl, calls } = fakeFetch([
      { status: 429, body: { error: 'slow down' }, headers: { 'retry-after': '0' } },
      { status: 200, body: okBody },
    ]);
    const client = new JevClient({ provider: 'openrouter', apiKey: 'k', fetch: fetchImpl });
    const result = await client.ask('x', questions);
    expect(calls).toHaveLength(2);
    expect(result.attempts).toBe(2);
  });

  test('retries a 504', async () => {
    const { fetchImpl, calls } = fakeFetch([
      { status: 504, body: 'gateway timeout', headers: { 'retry-after': '0' } },
      { status: 200, body: okBody },
    ]);
    const client = new JevClient({ provider: 'openrouter', apiKey: 'k', fetch: fetchImpl });
    expect((await client.ask('x', questions)).attempts).toBe(2);
    expect(calls).toHaveLength(2);
  });

  test('reports a 2xx error envelope by its shape, not as a schema dump', async () => {
    const { fetchImpl } = fakeFetch([
      { status: 200, body: { error: { message: 'provider returned error' } } },
    ]);
    const client = new JevClient({ provider: 'openrouter', apiKey: 'k', fetch: fetchImpl });
    const error = await client.ask('x', questions).catch((e: unknown) => e);
    expect((error as Error).message).toMatch(/wrong shape at model, answers, usage/);
    expect((error as Error).message).toContain('provider returned error');
  });

  test('does not retry a 422', async () => {
    const { fetchImpl, calls } = fakeFetch([{ status: 422, body: { error: 'bad question' } }]);
    const client = new JevClient({ provider: 'openrouter', apiKey: 'k', fetch: fetchImpl });
    await expect(client.ask('x', questions)).rejects.toThrow(/422/);
    expect(calls).toHaveLength(1);
  });

  test('marks a 401 as an auth failure', async () => {
    const { fetchImpl } = fakeFetch([{ status: 401, body: { error: 'User not found.' } }]);
    const client = new JevClient({ provider: 'openrouter', apiKey: 'k', fetch: fetchImpl });
    const error = await client.ask('x', questions).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JevHttpError);
    expect((error as JevHttpError).isAuthFailure).toBe(true);
  });

  test('retries a dropped connection, then succeeds', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      if (calls === 1) throw new TypeError('socket hang up');
      return Response.json(okBody);
    }) as unknown as typeof fetch;
    const client = new JevClient({ provider: 'openrouter', apiKey: 'k', fetch: fetchImpl });
    const result = await client.ask('x', questions);
    expect(result.attempts).toBe(2);
  });

  test('names the provider and attempts when the connection never succeeds', async () => {
    const fetchImpl = (async () => {
      throw new TypeError('socket hang up');
    }) as unknown as typeof fetch;
    const client = new JevClient({
      provider: 'openrouter',
      apiKey: 'k',
      fetch: fetchImpl,
      maxAttempts: 1,
    });
    await expect(client.ask('x', questions)).rejects.toThrow(
      'Jev openrouter request failed after 1 attempt(s): socket hang up',
    );
  });

  test('rejects an answer outside the declared options', async () => {
    const bad = structuredClone(okBody);
    bad.answers.dept.choice = 'sales';
    const { fetchImpl } = fakeFetch([{ status: 200, body: bad }]);
    const client = new JevClient({ provider: 'openrouter', apiKey: 'k', fetch: fetchImpl });
    await expect(client.ask('x', questions)).rejects.toThrow(/not one of/);
  });
});

describe('stringifyEntries', () => {
  test('JSON-encodes structured entries and keeps strings and nulls', () => {
    const out = stringifyEntries({
      dept: choice(
        { question: 'Which team?', focus: 'primary request' },
        { billing: { what: 'money' }, other: null },
      ),
      ok: noul('fine?', { true: ['yes', 'affirmative'], false: 'no' }),
    });
    expect(out.dept).toMatchObject({
      instructions: '{"question":"Which team?","focus":"primary request"}',
      criteria: { billing: '{"what":"money"}', other: null },
    });
    expect(out.ok).toMatchObject({ criteria: { true: '["yes","affirmative"]', false: 'no' } });
  });
});

describe('retryDelayMs', () => {
  test('prefers retry-after seconds', () => {
    expect(retryDelayMs('2', 1)).toBe(2000);
  });
  test('caps a long retry-after at a minute', () => {
    expect(retryDelayMs('3600', 1)).toBe(60_000);
  });
  test('reads a retry-after HTTP date', () => {
    const now = Date.parse('Wed, 23 Sep 2026 12:00:00 GMT');
    expect(retryDelayMs('Wed, 23 Sep 2026 12:00:05 GMT', 1, now)).toBe(5000);
  });
  test('falls back to exponential backoff', () => {
    const d = retryDelayMs(null, 3);
    expect(d).toBeGreaterThanOrEqual(2000);
    expect(d).toBeLessThan(2250);
  });
});
