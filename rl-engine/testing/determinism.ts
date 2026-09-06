/**
 * Determinism gate — spec §44 as a repeatable check.
 *
 * Same spec + seed + action sequence → byte-identical trajectory, where
 * "identical" means equal canonical-JSON hashes (key order can never flake).
 * `gate(spec, seeds, actionFactory)` runs every seed twice and fails on any
 * divergence; `trajectoryHash` exposes the stable hash for fixtures/CI.
 */

import type { Action, EnvironmentSpecification } from "../core/types";
import { createEnvironment } from "../environment/environment";
import { computeTrajectoryHash } from "../episode/replay";

export { computeTrajectoryHash as trajectoryHash };

export type GateResult = {
  pass: boolean;
  failures: { seed: number | string; reason: string }[];
  /** Hash per seed from the first run (the canonical trajectory digest). */
  hashes: Record<string, string>;
};

export function gate(
  spec: EnvironmentSpecification,
  seeds: (number | string)[],
  actionFactory: (seed: number | string, stepIndex: number) => Action,
  maxSteps = 200
): GateResult {
  const failures: GateResult["failures"] = [];
  const hashes: Record<string, string> = {};

  for (const seed of seeds) {
    const actions: Action[] = [];
    for (let i = 0; i < maxSteps; i++) actions.push(actionFactory(seed, i));

    const h1 = computeTrajectoryHash(spec, seed, actions);
    const h2 = computeTrajectoryHash(spec, seed, actions);
    hashes[String(seed)] = h1;
    if (h1 !== h2) {
      failures.push({ seed, reason: `trajectory hash diverged between two identical runs (${h1.slice(0, 12)}… vs ${h2.slice(0, 12)}…)` });
    }
  }

  return { pass: failures.length === 0, failures, hashes };
}
