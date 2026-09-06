/**
 * Replay system — spec §27
 * spec + initial state + seed + action sequence → identical trajectory (when deterministic)
 */

import { createHash } from "node:crypto";

import type { Action, EnvironmentSpecification } from "../core/types";
import { canonicalJson } from "../core/state";
import { createEnvironment } from "../environment/environment";
import type { TrajectoryStep } from "./trajectory";

export function replay(
  spec: EnvironmentSpecification,
  seed: number | string,
  actions: Action[]
): TrajectoryStep[] {
  const env = createEnvironment(spec, seed);
  env.reset(seed);
  const trajectory: TrajectoryStep[] = [];

  for (const action of actions) {
    const before = env.getState();
    const result = env.step(action);
    const after = env.getState();
    trajectory.push({
      observation: result.observation,
      action,
      reward: result.reward,
      rewardComponents: result.rewardComponents,
      nextObservation: result.observation,
      terminated: result.terminated,
      truncated: result.truncated,
      state: after,
    });
    if (result.terminated || result.truncated) break;
  }

  return trajectory;
}

/**
 * Deterministic digest of a trajectory (§44): steps the spec from `seed`
 * through `actions` and hashes the canonical JSON of every StepResult.
 * Same spec + seed + actions → same hash, regardless of key insertion order.
 * Post-terminal steps are included: stepping a terminated environment is
 * itself deterministic (frozen result), so trailing no-ops never break replay
 * verification — only real mid-run divergence does.
 */
export function computeTrajectoryHash(
  spec: EnvironmentSpecification,
  seed: number | string,
  actions: Action[]
): string {
  const env = createEnvironment(spec, seed);
  env.reset(seed);
  const parts: string[] = [];
  for (const action of actions) {
    const r = env.step(action);
    parts.push(canonicalJson({ o: r.observation, r: r.reward, c: r.rewardComponents ?? {}, t: r.terminated, x: r.truncated, s: r.state ?? {} }));
  }
  return createHash("sha256").update(parts.join("\n")).digest("hex");
}
