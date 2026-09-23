/**
 * src/questions/questions.ts
 *
 * The three Jev question primitives (Choice, Score, Noul) as typed builders,
 * plus the Zod schemas for the wire shapes of questions and answers. Answer
 * types are inferred from the question map, so `answers.department.choice`
 * is typed to the option keys you declared.
 *
 * Wire reference: https://docs.typesafe.ai/api
 */

import { z } from 'zod';

/**
 * A question field that accepts free-form JSON structure (instructions, criteria).
 * `null` stands alone only as a Choice option value: OpenRouter answers a null
 * instruction, Score level, or Noul side with a 400.
 */
export const entrySchema: z.ZodType<Entry> = z.lazy(() =>
  z.union([z.string(), z.null(), z.array(entrySchema), z.record(z.string(), entrySchema)]),
);
export type Entry = string | null | Entry[] | { [key: string]: Entry };

export interface ChoiceQuestion<K extends string = string> {
  readonly type: 'choice';
  readonly instructions: NonNullable<Entry>;
  /** `null` for an option that needs no description. */
  readonly criteria: Readonly<Record<K, Entry>>;
}

export interface ScoreQuestion {
  readonly type: 'score';
  readonly instructions: NonNullable<Entry>;
  /** Ordered levels, index 0 first. Two to ten. */
  readonly criteria: readonly NonNullable<Entry>[];
}

export interface NoulQuestion {
  readonly type: 'noul';
  readonly instructions: NonNullable<Entry>;
  /** Both sides or neither — OpenRouter rejects a criteria object with one side missing. */
  readonly criteria?: { readonly true: NonNullable<Entry>; readonly false: NonNullable<Entry> };
}

export type Question = ChoiceQuestion | ScoreQuestion | NoulQuestion;
export type Questions = Readonly<Record<string, Question>>;

/** One option from a set. Up to 255 options; include an `other` when the set may not cover every input. */
export function choice<const K extends string>(
  instructions: NonNullable<Entry>,
  criteria: Readonly<Record<K, Entry>>,
): ChoiceQuestion<K> {
  const options = Object.keys(criteria).length;
  if (options === 0 || options > 255) {
    throw new Error(`choice() needs 1–255 options, got ${options}`);
  }
  return { type: 'choice', instructions, criteria };
}

/** A position on 2–10 ordered, described levels. Level index comes from array order. */
export function score(
  instructions: NonNullable<Entry>,
  criteria: readonly NonNullable<Entry>[],
): ScoreQuestion {
  if (criteria.length < 2 || criteria.length > 10) {
    throw new Error(`score() needs 2–10 levels, got ${criteria.length}`);
  }
  return { type: 'score', instructions, criteria };
}

/** A yes/no judgment returned as the probability of yes. */
export function noul(
  instructions: NonNullable<Entry>,
  criteria?: NoulQuestion['criteria'],
): NoulQuestion {
  return criteria === undefined
    ? { type: 'noul', instructions }
    : { type: 'noul', instructions, criteria };
}

export interface ChoiceAnswer<K extends string = string> {
  readonly type: 'choice';
  readonly choice: K;
  readonly probabilities: Readonly<Record<K, number>>;
  readonly confidence: number;
}

export interface ScoreAnswer {
  readonly type: 'score';
  /** Probability-weighted position; can land between levels. */
  readonly score: number;
  readonly legend: Readonly<Record<string, string>>;
  readonly probabilities: Readonly<Record<string, number>>;
  readonly confidence: number;
}

export interface NoulAnswer {
  readonly type: 'noul';
  /** Probability the answer is yes. */
  readonly noul: number;
}

export type Answer = ChoiceAnswer | ScoreAnswer | NoulAnswer;

export type AnswerFor<Q extends Question> =
  Q extends ChoiceQuestion<infer K>
    ? ChoiceAnswer<K>
    : Q extends ScoreQuestion
      ? ScoreAnswer
      : NoulAnswer;

export type AnswersFor<Qs extends Questions> = { readonly [K in keyof Qs]: AnswerFor<Qs[K]> };

export const answerSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('choice'),
    choice: z.string(),
    probabilities: z.record(z.string(), z.number()),
    confidence: z.number(),
  }),
  z.object({
    type: z.literal('score'),
    score: z.number(),
    legend: z.record(z.string(), z.string()),
    probabilities: z.record(z.string(), z.number()),
    confidence: z.number(),
  }),
  z.object({ type: z.literal('noul'), noul: z.number() }),
]);

/** Validate a decoded answer against the question that produced it. */
export function assertAnswerMatches(id: string, question: Question, answer: Answer): void {
  if (answer.type !== question.type) {
    throw new Error(`answer "${id}" is type ${answer.type}, question is ${question.type}`);
  }
  if (
    answer.type === 'choice' &&
    question.type === 'choice' &&
    !(answer.choice in question.criteria)
  ) {
    throw new Error(`answer "${id}" chose "${answer.choice}", not one of the declared options`);
  }
}
