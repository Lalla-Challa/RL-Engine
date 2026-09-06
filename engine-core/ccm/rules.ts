import type {
  Condition,
  EvaluatedCandidate,
  RuleDef,
  StateChange,
  World,
  Actor,
  Environment,
  SystemDef,
  Relationship,
  EntityRef,
} from "./types";
import { evaluateCondition } from "./state";

/**
 * Gather every entity a rule should be evaluated against, based on its scope.
 * - actor       → every actor in the world
 * - environment → every environment
 * - system      → every system (once each)
 * - narrative   → none (handled separately by the simulator)
 */
export function entitiesForRule(
  world: World,
  rule: RuleDef
): EntityRef[] {
  switch (rule.scope) {
    case "actor":
      return world.actors.map((a) => ({
        kind: "actor",
        name: a.name,
        record: actorRecord(a),
      }));
    case "environment":
      return world.environments.map((e) => ({
        kind: "environment",
        name: e.name,
        record: environmentRecord(e),
      }));
    case "system":
      return world.systems.map((s) => ({
        kind: "system",
        name: s.name,
        record: systemRecord(s),
      }));
    case "relationship":
      return world.relationships.map((r) => ({
        kind: "relationship",
        name: relationshipName(world, r),
        record: relationshipRecord(world, r),
      }));
    default:
      return [];
  }
}

/**
 * Deterministic label for a relationship: the two actor names joined by ":".
 * Actor ids are ordered ascending so the label is stable regardless of the
 * direction the relationship row was created in.
 */
export function relationshipName(world: World, rel: Relationship): string {
  const [lo, hi] = [rel.actorAId, rel.actorBId].sort((a, b) => a - b);
  return `${actorName(world, lo)}:${actorName(world, hi)}`;
}

export function actorRecord(actor: Actor): Record<string, unknown> {
  const goals: string[] = [];
  for (const layer of Object.values(actor.goals)) {
    for (const g of layer) goals.push(g);
  }
  const beliefStrings: string[] = [];
  for (const arr of Object.values(actor.beliefs)) beliefStrings.push(...arr);
  return {
    attributes: { ...actor.attributes },
    state: { ...actor.state },
    goals,
    drives: [...actor.drives],
    habits: [...actor.habits],
    constraints: [...actor.constraints],
    capabilities: [...actor.capabilities],
    knowledge: [...actor.knowledge],
    resources: { ...actor.resources },
    plans: [...actor.plans],
    beliefs: { ...actor.beliefs },
    _beliefsFlat: beliefStrings,
  };
}

export function environmentRecord(env: Environment): Record<string, unknown> {
  return {
    attributes: { ...env.attributes },
    state: { ...env.state },
    resources: { ...env.resources },
    activeProcesses: [...env.activeProcesses],
    constraints: [...env.constraints],
    inhabitants: [...env.inhabitants],
    accessibility: { ...env.accessibility },
  };
}

export function systemRecord(system: SystemDef): Record<string, unknown> {
  return {
    rules: [...system.rules],
    constraints: [...system.constraints],
    activeConditions: [...system.activeConditions],
    effects: [...system.effects],
    exceptions: [...system.exceptions],
  };
}

/** Relationship fields exposed to condition evaluation (CCM §8 bond model). */
export function relationshipRecord(world: World, rel: Relationship): Record<string, unknown> {
  return {
    actorA: actorName(world, rel.actorAId),
    actorB: actorName(world, rel.actorBId),
    familiarity: rel.familiarity,
    trust: rel.trust,
    affection: rel.affection,
    resentment: rel.resentment,
    dependence: rel.dependence,
    fear: rel.fear,
    obligation: rel.obligation,
    respect: rel.respect,
    knowledge: rel.knowledge,
    expectations: { ...rel.expectations },
    history: [...rel.history],
  };
}

/**
 * Check whether all of a rule's WHEN conditions hold against a record,
 * AND (if `requiresPressure` is set) whether the entity is under that
 * pressure — the keyword must appear in the entity's drives, goals, habits,
 * or plans. This is the CCE v1.1 "action emerges from pressure" gate: a rule
 * only offers its actions while the matching pressure is actually active.
 */
export function ruleMatches(rule: RuleDef, record: Record<string, unknown>): boolean {
  if (!rule.when.conditions.every((c) => conditionMatches(record, c))) return false;
  const required = rule.when.requiresPressure;
  if (required) {
    const haystack = [
      ...(Array.isArray(record.drives) ? record.drives : []),
      ...(Array.isArray(record.goals) ? record.goals : []),
      ...(Array.isArray(record.habits) ? record.habits : []),
      ...(Array.isArray(record.plans) ? record.plans : []),
    ]
      .map(String)
      .join(" ");
    if (!haystack.toLowerCase().includes(required.toLowerCase())) return false;
  }
  return true;
}

export function conditionMatches(record: Record<string, unknown>, c: Condition): boolean {
  return evaluateCondition(record, c);
}

/**
 * Evaluate a rule against a single entity and produce candidate events.
 * `pressure` is the probability multiplier from the pressure engine.
 * Returns one EvaluatedCandidate per candidate definition (pre-roll).
 */
export function candidatesForRule(
  rule: RuleDef,
  entity: EntityRef,
  pressure: number
): EvaluatedCandidate[] {
  const results: EvaluatedCandidate[] = [];
  for (const candidate of rule.candidates) {
    const probability = Math.max(
      0,
      Math.min(1, candidate.probability * rule.probability * pressure)
    );
    results.push({
      rule,
      candidate,
      entityKind: entity.kind,
      entityName: entity.name,
      pressure,
      probability,
      parents: [],
    });
  }
  return results;
}

/**
 * Render a candidate's summary template: {name} → entity name.
 */
export function renderSummary(candidateSummary: string, entityName: string): string {
  return candidateSummary.replaceAll("{name}", entityName);
}

/**
 * Resolve a StateChange target string into the actual object + display label.
 * Returns null when the target doesn't exist in the world (validation layer 2).
 */
export function resolveStateChangeTarget(
  world: World,
  target: string,
  selfName: string
): { obj: Record<string, unknown>; label: string } | null {
  if (target === "self") {
    const self =
      world.actors.find((a) => a.name === selfName) ??
      world.environments.find((e) => e.name === selfName);
    if (self) return { obj: self as unknown as Record<string, unknown>, label: `${selfName}` };
    // Relationship self: selfName is "ActorA:ActorB".
    const rel = world.relationships.find((r) => relationshipName(world, r) === selfName);
    if (rel) return { obj: rel as unknown as Record<string, unknown>, label: `relationship:${selfName}` };
    return null;
  }
  if (target.startsWith("actor:")) {
    const name = target.slice("actor:".length);
    const actor = world.actors.find((a) => a.name === name);
    if (!actor) return null;
    return { obj: actor as unknown as Record<string, unknown>, label: `actor:${name}` };
  }
  if (target.startsWith("environment:")) {
    const name = target.slice("environment:".length);
    const env = world.environments.find((e) => e.name === name);
    if (!env) return null;
    return { obj: env as unknown as Record<string, unknown>, label: `environment:${name}` };
  }
  if (target.startsWith("relationship:")) {
    const [a, b] = target.slice("relationship:".length).split(":");
    const rel = world.relationships.find(
      (r) =>
        (actorName(world, r.actorAId) === a && actorName(world, r.actorBId) === b) ||
        (actorName(world, r.actorAId) === b && actorName(world, r.actorBId) === a)
    );
    if (!rel) return null;
    return { obj: rel as unknown as Record<string, unknown>, label: `relationship:${a}:${b}` };
  }
  // Bare actor/environment name fallback.
  const byName =
    world.actors.find((a) => a.name === target) ??
    world.environments.find((e) => e.name === target);
  if (!byName) return null;
  return { obj: byName as unknown as Record<string, unknown>, label: target };
}

export function actorName(world: World, actorId: number): string {
  return world.actors.find((a) => a.id === actorId)?.name ?? `#${actorId}`;
}

/** Get an actor's state.location if it resolves to an environment name. */
export function actorLocation(world: World, actor: Actor): string | null {
  const loc = actor.state.location;
  if (typeof loc !== "string") return null;
  return world.environments.some((e) => e.name === loc) ? loc : null;
}

/** Collect the field paths this rule's conditions read (for causal linking). */
export function conditionFields(rule: RuleDef): string[] {
  return rule.when.conditions.map((c) => c.field);
}

export function stateChangesOf(candidate: EvaluatedCandidate): StateChange[] {
  return [...candidate.rule.effects, ...candidate.candidate.stateChanges];
}
