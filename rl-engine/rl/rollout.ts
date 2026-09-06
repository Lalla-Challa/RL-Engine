/**
 * Rollout — spec §34
 */

import type { Environment, Action } from "../core/types";
import type { Policy } from "./policy";
import type { TrajectoryStep } from "../episode/trajectory";

export function rollout(env: Environment, policy: Policy, maxSteps = 100): TrajectoryStep[] {
  const trajectory: TrajectoryStep[] = [];
  let result = env.reset();
  let observation = result.observation;

  for (let i = 0; i < maxSteps; i++) {
    const action: Action = policy.act(observation);
    const step = env.step(action);
    trajectory.push({
      observation,
      action,
      reward: step.reward,
      rewardComponents: step.rewardComponents,
      nextObservation: step.observation,
      terminated: step.terminated,
      truncated: step.truncated,
      state: step.state ?? {},
    });
    observation = step.observation;
    if (step.terminated || step.truncated) break;
  }

  return trajectory;
}
