/**
 * Environment API — spec §21
 * Minimum interface: reset, step, getActionSpace, getObservationSpace, getState, getSpecification
 */

export type { Environment, StepResult, ResetResult } from "../core/types";
export { createEnvironment } from "../environment/environment";
