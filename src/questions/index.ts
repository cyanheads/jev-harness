/**
 * src/questions/index.ts — public surface of the questions module.
 */
export {
  type Answer,
  type AnswerFor,
  type AnswersFor,
  answerSchema,
  assertAnswerMatches,
  type ChoiceAnswer,
  type ChoiceQuestion,
  choice,
  type Entry,
  entrySchema,
  type NoulAnswer,
  type NoulQuestion,
  noul,
  type Question,
  type Questions,
  type ScoreAnswer,
  type ScoreQuestion,
  score,
} from './questions.ts';
