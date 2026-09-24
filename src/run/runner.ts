/**
 * src/run/runner.ts
 *
 * Run one experiment over a list of records with bounded concurrency. Each
 * record becomes one Jev request (all the experiment's questions for that
 * record, in parallel on the provider side). Rows are yielded as they complete so the CLI can
 * stream them to JSONL; the report is computed from the collected rows.
 */

import { type JevClient, JevHttpError, type JevResult } from '../client/index.ts';
import { type Experiment, questionsFor } from '../experiments/index.ts';
import type { Record_ } from '../input/index.ts';
import type { Answer } from '../questions/index.ts';

export interface RunRow {
  readonly id: string;
  readonly experiment: string;
  readonly model: string;
  readonly answers: Readonly<Record<string, Answer>>;
  readonly derived?: Readonly<Record<string, unknown>>;
  readonly usage: JevResult<never>['usage'];
  readonly costUsd: number;
  readonly latencyMs: number;
  readonly attempts: number;
  /** The record as loaded — only when `keepInput` is set. */
  readonly input?: unknown;
  /** The state sent to Jev — only when `keepState` is set. */
  readonly state?: unknown;
}

export interface RunFailure {
  readonly id: string;
  readonly error: string;
}

export interface RunOptions {
  readonly concurrency?: number;
  readonly keepInput?: boolean;
  readonly keepState?: boolean;
  readonly onRow?: (row: RunRow) => void | Promise<void>;
  readonly onFailure?: (failure: RunFailure) => void | Promise<void>;
}

export interface RunOutcome {
  readonly rows: RunRow[];
  readonly failures: RunFailure[];
}

export async function runExperiment(
  client: JevClient,
  experiment: Experiment,
  records: readonly Record_[],
  options: RunOptions = {},
): Promise<RunOutcome> {
  const concurrency = Math.max(1, options.concurrency ?? 8);
  const rows: RunRow[] = [];
  const failures: RunFailure[] = [];
  let next = 0;

  /**
   * Set by the first error that ends the run: an auth failure, after which every
   * remaining record would fail the same way, or a sink that threw. Workers stop
   * taking records; requests already in flight finish before the run rejects.
   */
  let fatal: { readonly error: unknown } | undefined;

  /** A sink that cannot take a row or a failure ends the run, not the record. */
  async function deliver(send: () => void | Promise<void>): Promise<void> {
    try {
      await send();
    } catch (error) {
      fatal ??= { error };
    }
  }

  async function worker(): Promise<void> {
    while (next < records.length && !fatal) {
      const record = records[next++];
      if (!record) return;
      let row: RunRow;
      try {
        const state = experiment.state(record.data);
        const result = await client.ask(state, questionsFor(experiment, record.data));
        const derived = experiment.derive?.(result.answers, record.data);
        row = {
          id: record.id,
          experiment: experiment.name,
          model: result.model,
          answers: result.answers,
          ...(derived !== undefined && { derived }),
          usage: result.usage,
          costUsd: result.costUsd,
          latencyMs: result.latencyMs,
          attempts: result.attempts,
          ...(options.keepInput && { input: record.data }),
          ...(options.keepState && { state }),
        };
      } catch (error) {
        if (error instanceof JevHttpError && error.isAuthFailure) {
          fatal ??= { error };
          return;
        }
        const failure = {
          id: record.id,
          error: error instanceof Error ? error.message : String(error),
        };
        failures.push(failure);
        await deliver(() => options.onFailure?.(failure));
        continue;
      }
      rows.push(row);
      await deliver(() => options.onRow?.(row));
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, records.length) }, worker));
  if (fatal) throw fatal.error;
  return { rows, failures };
}
