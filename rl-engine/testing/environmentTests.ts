/**
 * Environment tests — spec §45
 */

import type { EnvironmentSpecification } from "../core/types";
import { createEnvironment } from "../environment/environment";

export function testEnvironment(spec: EnvironmentSpecification): { pass: boolean; errors: string[] } {
  const errors: string[] = [];
  const env = createEnvironment(spec, 42);

  const reset = env.reset(42);
  if (!reset.observation) errors.push("reset must return observation");

  const actions = env.getActionSpace();
  if (actions.length === 0) errors.push("action space must not be empty");

  const obsSpace = env.getObservationSpace();
  if (!obsSpace) errors.push("observation space must be defined");

  // Action legality: invalid action must not mutate state
  const before = JSON.stringify(env.getState());
  env.step({ type: "__invalid_action__" });
  const after = JSON.stringify(env.getState());
  if (before !== after) errors.push("invalid action mutated state");

  return { pass: errors.length === 0, errors };
}
