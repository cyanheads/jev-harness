/**
 * src/experiments/experiment.ts
 *
 * An experiment is the variable part of a run: the questions to ask and how to
 * turn one input record into Jev `state`. Everything else (client, batching,
 * output, report) is the harness. One file per experiment under `experiments/`,
 * default-exporting `defineExperiment({...})`.
 */

import type { State } from '../client/index.ts';
import type { AnswersFor, Questions } from '../questions/index.ts';

export interface Experiment<Qs extends Questions = Questions, R = unknown> {
  readonly name: string;
  readonly description: string;
  /** Asked together, in parallel, over every record's state. */
  readonly questions: Qs;
  /**
   * Build the state Jev sees from one input record. Send only what the
   * questions need. Method syntax on purpose: it keeps `R` bivariant so a
   * typed experiment is assignable to the `Experiment` the runner accepts.
   */
  state(record: R): State;
  /**
   * Optional code-side policy over the answers: thresholds, agreement with a
   * label carried on the record, a derived decision. Returned fields land in the
   * output row under `derived` and are tallied in the report.
   */
  derive?(answers: AnswersFor<Qs>, record: R): Readonly<Record<string, unknown>>;
}

export function defineExperiment<const Qs extends Questions, R = unknown>(
  experiment: Experiment<Qs, R>,
): Experiment<Qs, R> {
  if (Object.keys(experiment.questions).length === 0) {
    throw new Error(`experiment "${experiment.name}" declares no questions`);
  }
  return experiment;
}
