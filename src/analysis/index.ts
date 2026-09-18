/**
 * src/analysis/index.ts — public surface of the analysis module.
 */
export {
  type Calibration,
  calibrate,
  type QuestionCalibration,
  type ReliabilityBin,
  renderCalibration,
  type Truth,
  truthLineSchema,
} from './calibration.ts';
export { type QuestionStability, renderStability, stability } from './stability.ts';
