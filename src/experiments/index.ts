/**
 * src/experiments/index.ts — public surface of the experiments module.
 */
export {
  defineExperiment,
  type Experiment,
  type QuestionsBuilder,
  questionsFor,
} from './experiment.ts';
export {
  EXPERIMENTS_DIR,
  listExperiments,
  loadExperiment,
  resolveExperimentPath,
} from './load-experiment.ts';
