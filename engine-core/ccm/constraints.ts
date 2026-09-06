/**
 * Staged narrative-constraint planner (CCM spec §15).
 *
 * The engine does NOT take orders — it does not "try" to satisfy constraints.
 * Instead, constraints apply pressure: unsatisfied destinations bias the
 * probability of candidates that involve the target actors, making the engine
 * more likely to drift toward the plot. Deadline escalation pushes harder.
 *
 * Satisfaction is detected automatically: when a constraint's target conditions
 * all match the current world state, it is marked satisfied and recorded.
 */

import type { World, NarrativeConstraint, Condition } from "./types";
import { evaluateCondition } from "./state";
import { actorRecord, environmentRecord } from "./rules";

/** Constraint classes that support automatic satisfaction detection. */
const SATISFIABLE_CLASSES = ["hard", "soft", "temporal"];

/**
 * Check whether a constraint's satisfaction conditions are met by the current
 * world state. A constraint is satisfied when ALL of its target conditions
 * match for at least one target entity (actor or environment).
 *
 * Returns `false` for forbidden/range constraints (they are never "satisfied"
 * in the destination sense — only violated).
 */
export function isConstraintSatisfied(
  world: World,
  constraint: NarrativeConstraint
): boolean {
  if (constraint.satisfied) return true;
  if (!SATISFIABLE_CLASSES.includes(constraint.class)) return false;

  const target = constraint.target as {
    actors?: string[];
    environments?: string[];
    conditions?: Condition[];
  };
  const conditions = target.conditions;
  if (!conditions || conditions.length === 0) return false;

  // Collect candidate records: named actors (or all actors) + named environments.
  const candidates: Record<string, unknown>[] = [];
  const targetActors =
    Array.isArray(target.actors) && target.actors.length > 0
      ? target.actors
      : world.actors.map((a) => a.name);
  for (const name of targetActors) {
    const actor = world.actors.find((a) => a.name === name);
    if (actor) candidates.push(actorRecord(actor));
  }
  const targetEnvs = Array.isArray(target.environments) ? target.environments : [];
  for (const name of targetEnvs) {
    const env = world.environments.find((e) => e.name === name);
    if (env) candidates.push(environmentRecord(env));
  }

  if (candidates.length === 0) return false;

  return candidates.some((c) =>
    conditions.every((cond) => evaluateCondition(c, cond))
  );
}

/**
 * Run after each tick: check all unsatisfied constraints and mark satisfied
 * ones. Returns the names of newly satisfied constraints.
 */
export function checkConstraintSatisfaction(world: World): string[] {
  const newlySatisfied: string[] = [];
  for (const constraint of world.constraints) {
    if (constraint.satisfied) continue;
    if (isConstraintSatisfied(world, constraint)) {
      constraint.satisfied = true;
      // Epoch-seconds, consistent with the `updateConstraint` convention.
      constraint.satisfiedAt = Math.floor(Date.now() / 1000);
      newlySatisfied.push(constraint.name);
    }
  }
  return newlySatisfied;
}

/**
 * Compute a pressure bias multiplier from active narrative constraints.
 * Returns 1.0 (no effect) when no constraints target the entity.
 *
 * Each unsatisfied hard/soft constraint aimed at this actor pushes
 * probability up by 0.25. Deadline escalation adds another 0.5 if the
 * deadline is past.
 */
export function constraintPressure(
  world: World,
  entityName: string
): number {
  let boost = 0;
  const now = world.clock.day * 1440 + world.clock.minute;

  for (const constraint of world.constraints) {
    if (constraint.satisfied) continue;
    if (!SATISFIABLE_CLASSES.includes(constraint.class)) continue;

    const target = constraint.target as { actors?: string[] };
    const targetActors = Array.isArray(target.actors) ? target.actors : [];
    const involvesEntity =
      targetActors.length === 0 || targetActors.includes(entityName);
    if (!involvesEntity) continue;

    // Base boost: the engine should move toward this destination.
    boost += 0.25;

    // Deadline escalation: if the deadline is past, push harder.
    if (constraint.deadline != null && now >= constraint.deadline) {
      boost += 0.5;
    }
  }

  return 1.0 + boost;
}