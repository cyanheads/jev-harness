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

/**
 * Questions built from one record, for options that come from the record
 * itself (a query's candidate tools, a document's line ids). Declared through a
 * method type so `R` stays bivariant, like `state` and `derive` below.
 */
export type QuestionsBuilder<Qs extends Questions, R> = {
  build(record: R): Qs;
}['build'];

export interface Experiment<Qs extends Questions = Questions, R = unknown> {
  readonly name: string;
  readonly description: string;
  /**
   * Asked together, in one request, over every record's state. A function
   * builds them per record; the report then reads question ids and types from
   * the answers.
   */
  readonly questions: Qs | QuestionsBuilder<Qs, R>;
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
  const { questions } = experiment;
  if (typeof questions !== 'function' && Object.keys(questions).length === 0) {
    throw new Error(`experiment "${experiment.name}" declares no questions`);
  }
  return experiment;
}

/** The questions to ask about one record. */
export function questionsFor(experiment: Experiment, record: unknown): Questions {
  const { questions } = experiment;
  if (typeof questions !== 'function') return questions;
  const built = questions(record);
  if (Object.keys(built).length === 0) {
    throw new Error(`experiment "${experiment.name}" built no questions for this record`);
  }
  return built;
}
