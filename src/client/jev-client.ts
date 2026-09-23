/**
 * src/client/jev-client.ts
 *
 * HTTP client for Jev. One request shape (`{ model, state, questions }`) served
 * by two providers: OpenRouter's `/api/alpha/decisions` and TypeSafe's own
 * `/v1/systemone`. Retries 408/429/5xx, timeouts, and dropped connections with
 * backoff, honors `retry-after`, validates the response with Zod, and reports
 * token usage, cost, and latency per call.
 */

import { z } from 'zod';
import {
  type AnswersFor,
  answerSchema,
  assertAnswerMatches,
  type Entry,
  type Question,
  type Questions,
} from '../questions/index.ts';

export type Provider = 'openrouter' | 'typesafe';

export const PROVIDERS: Readonly<
  Record<Provider, { url: string; defaultModel: string; keyEnv: string }>
> = {
  openrouter: {
    url: 'https://openrouter.ai/api/alpha/decisions',
    defaultModel: 'typesafe/jev-1.13',
    keyEnv: 'OPENROUTER_API_KEY',
  },
  typesafe: {
    url: 'https://api.typesafe.ai/v1/systemone',
    defaultModel: 'jev-1.13.0',
    keyEnv: 'TYPESAFE_API_KEY',
  },
};

/** Listed input price on both providers; output tokens are free. */
export const USD_PER_INPUT_TOKEN = 0.042 / 1_000_000;

export type State = string | readonly State[] | { readonly [key: string]: State };

export interface JevClientOptions {
  readonly provider?: Provider;
  readonly apiKey?: string;
  readonly model?: string;
  readonly fetch?: typeof fetch;
  readonly maxAttempts?: number;
  readonly timeoutMs?: number;
}

export interface JevResult<Qs extends Questions> {
  readonly model: string;
  readonly answers: AnswersFor<Qs>;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
  readonly costUsd: number;
  readonly latencyMs: number;
  readonly attempts: number;
}

const responseSchema = z.object({
  model: z.string(),
  answers: z.record(z.string(), answerSchema),
  usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }),
});

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504, 524, 529]);

/** A `retry-after` longer than this is slept for this long instead. */
const MAX_RETRY_DELAY_MS = 60_000;

/** A non-2xx answer from the provider, after retries. */
export class JevHttpError extends Error {
  readonly status: number;

  constructor(provider: Provider, status: number, attempts: number, body: string) {
    super(`Jev ${provider} ${status} after ${attempts} attempt(s): ${body.slice(0, 500)}`);
    this.name = 'JevHttpError';
    this.status = status;
  }

  /** The key is wrong or lacks access, so every other record would fail the same way. */
  get isAuthFailure(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

export class JevClient {
  readonly provider: Provider;
  readonly model: string;
  readonly url: string;
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;
  readonly #maxAttempts: number;
  readonly #timeoutMs: number;

  constructor(options: JevClientOptions = {}) {
    this.provider = options.provider ?? readProvider();
    const spec = PROVIDERS[this.provider];
    this.url = spec.url;
    this.model = options.model ?? process.env.JEV_MODEL ?? spec.defaultModel;
    const key = options.apiKey ?? process.env[spec.keyEnv];
    if (!key) {
      throw new Error(
        `${spec.keyEnv} is not set (provider ${this.provider}); copy .env.example to .env`,
      );
    }
    this.#apiKey = key;
    this.#fetch = options.fetch ?? fetch;
    this.#maxAttempts = options.maxAttempts ?? 4;
    this.#timeoutMs = options.timeoutMs ?? 15_000;
  }

  /** The exact JSON body that would be sent — for `--dry-run` and tests. */
  payload(state: State, questions: Questions): Record<string, unknown> {
    return {
      model: this.model,
      state,
      questions: this.provider === 'openrouter' ? stringifyEntries(questions) : questions,
    };
  }

  async ask<const Qs extends Questions>(state: State, questions: Qs): Promise<JevResult<Qs>> {
    const body = JSON.stringify(this.payload(state, questions));
    const started = performance.now();
    let attempt = 0;
    for (;;) {
      attempt += 1;
      let res: Response;
      try {
        res = await this.#fetch(this.url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.#apiKey}`, 'Content-Type': 'application/json' },
          body,
          signal: AbortSignal.timeout(this.#timeoutMs),
        });
      } catch (error) {
        // A timeout or a dropped connection is as transient as a 503.
        if (attempt >= this.#maxAttempts) {
          const reason = error instanceof Error ? error.message : String(error);
          throw new Error(
            `Jev ${this.provider} request failed after ${attempt} attempt(s): ${reason}`,
            {
              cause: error,
            },
          );
        }
        await Bun.sleep(retryDelayMs(null, attempt));
        continue;
      }
      if (res.ok) {
        const parsed = parseResponse(await res.text());
        for (const [id, question] of Object.entries(questions)) {
          const answer = parsed.answers[id];
          if (!answer) throw new Error(`response is missing answer "${id}"`);
          assertAnswerMatches(id, question, answer);
        }
        return {
          model: parsed.model,
          answers: parsed.answers as unknown as AnswersFor<Qs>,
          usage: {
            inputTokens: parsed.usage.input_tokens,
            outputTokens: parsed.usage.output_tokens,
          },
          costUsd: parsed.usage.input_tokens * USD_PER_INPUT_TOKEN,
          latencyMs: Math.round(performance.now() - started),
          attempts: attempt,
        };
      }
      const text = await res.text();
      if (!RETRYABLE.has(res.status) || attempt >= this.#maxAttempts) {
        throw new JevHttpError(this.provider, res.status, attempt, text);
      }
      await Bun.sleep(retryDelayMs(res.headers.get('retry-after'), attempt));
    }
  }
}

function readProvider(): Provider {
  const raw = process.env.JEV_PROVIDER ?? 'openrouter';
  if (raw !== 'openrouter' && raw !== 'typesafe') {
    throw new Error(`JEV_PROVIDER must be openrouter or typesafe, got "${raw}"`);
  }
  return raw;
}

/** A 2xx whose body is not the documented shape: an error envelope, or markup from the edge. */
function parseResponse(text: string): z.infer<typeof responseSchema> {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`response is not JSON: ${text.slice(0, 200)}`);
  }
  const parsed = responseSchema.safeParse(json);
  if (!parsed.success) {
    const where = parsed.error.issues.map((issue) => issue.path.join('.') || '(root)').join(', ');
    throw new Error(`response has the wrong shape at ${where}: ${text.slice(0, 200)}`);
  }
  return parsed.data;
}

/**
 * `retry-after` when present — delay-seconds or an HTTP date — capped at a
 * minute, else exponential backoff with jitter (0.5s, 1s, 2s…).
 */
export function retryDelayMs(retryAfter: string | null, attempt: number, now = Date.now()): number {
  // `Number('')` is 0: a blank header would otherwise retry at once.
  if (retryAfter !== null && retryAfter.trim() !== '') {
    const seconds = Number(retryAfter);
    const fromHeader = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - now;
    if (Number.isFinite(fromHeader) && fromHeader >= 0) {
      return Math.min(fromHeader, MAX_RETRY_DELAY_MS);
    }
  }
  return 500 * 2 ** (attempt - 1) + Math.random() * 250;
}

/**
 * OpenRouter validates `instructions` and criteria values as strings, so
 * structured entries are JSON-encoded on the wire. TypeSafe accepts them as-is.
 */
export function stringifyEntries(questions: Questions): Record<string, Question> {
  const asString = (entry: NonNullable<Entry>): string =>
    typeof entry === 'string' ? entry : JSON.stringify(entry);
  const out: Record<string, Question> = {};
  for (const [id, q] of Object.entries(questions)) {
    const instructions = asString(q.instructions);
    switch (q.type) {
      case 'choice':
        out[id] = {
          type: 'choice',
          instructions,
          // A null option value is the one null OpenRouter accepts.
          criteria: Object.fromEntries(
            Object.entries(q.criteria).map(([k, v]) => [k, v === null ? null : asString(v)]),
          ),
        };
        break;
      case 'score':
        out[id] = { type: 'score', instructions, criteria: q.criteria.map(asString) };
        break;
      case 'noul':
        out[id] = q.criteria
          ? {
              type: 'noul',
              instructions,
              criteria: { true: asString(q.criteria.true), false: asString(q.criteria.false) },
            }
          : { type: 'noul', instructions };
        break;
    }
  }
  return out;
}
