import type { World, Actor, Environment, SystemDef, RuleDef, Relationship, NarrativeConstraint, EngineEvent } from "./types";
import { getProjectActors } from "../modules/actors/actor.data";
import { getProjectEnvironments, getProjectSystems, getProjectRules, getProjectRelationships, getProjectConstraints } from "../modules/world/world.data";
import {
  getSimulationById,
  listEvents,
  getEventAncestry,
  listQueueItems,
} from "../modules/simulation/simulation.data";

/**
 * Hydrate an engine `World` from the project-scoped world model tables and
 * a simulation config. The engine is pure — it never touches the DB itself;
 * the loader is the only bridge between the DB and the step loop.
 */
export function loadWorld(projectId: number, simulationId: number): World {
  const sim = getSimulationById(simulationId);
  if (!sim) throw new Error(`Simulation #${simulationId} not found`);
  if (sim.projectId !== projectId) throw new Error(`Simulation #${simulationId} does not belong to project #${projectId}`);

  const actors: Actor[] = (getProjectActors(projectId) ?? []).map((a) => ({
    id: a.id,
    name: a.name,
    type: a.type,
    attributes: (a.attributes ?? {}) as Record<string, unknown>,
    state: (a.state ?? {}) as Record<string, unknown>,
    goals: (a.goals ?? { survival: [], functional: [], social: [], emotional: [], longTerm: [], narrative: [] }) as Actor["goals"],
    drives: (a.drives ?? []) as string[],
    beliefs: (a.beliefs ?? { known: [], believed: [], uncertain: [], misconceptions: [] }) as Actor["beliefs"],
    knowledge: (a.knowledge ?? []) as string[],
    capabilities: (a.capabilities ?? []) as string[],
    constraints: (a.constraints ?? []) as string[],
    resources: (a.resources ?? {}) as Record<string, unknown>,
    habits: (a.habits ?? []) as string[],
    plans: (a.plans ?? []) as string[],
  }));

  const environments: Environment[] = (getProjectEnvironments(projectId) ?? []).map((e) => ({
    id: e.id,
    name: e.name,
    type: e.type,
    attributes: (e.attributes ?? {}) as Record<string, unknown>,
    state: (e.state ?? {}) as Record<string, unknown>,
    resources: (e.resources ?? {}) as Record<string, unknown>,
    inhabitants: (e.inhabitants ?? []) as string[],
    accessibility: (e.accessibility ?? {}) as Record<string, unknown>,
    activeProcesses: (e.activeProcesses ?? []) as string[],
    constraints: (e.constraints ?? []) as string[],
  }));

  const systems: SystemDef[] = (getProjectSystems(projectId) ?? []).map((s) => ({
    id: s.id,
    name: s.name,
    type: s.type,
    rules: (s.rules ?? []) as string[],
    constraints: (s.constraints ?? []) as string[],
    activeConditions: (s.activeConditions ?? []) as string[],
    effects: (s.effects ?? []) as string[],
    exceptions: (s.exceptions ?? []) as string[],
  }));

  const rules: RuleDef[] = (getProjectRules(projectId) ?? []).map((r) => ({
    id: r.id,
    name: r.name,
    family: r.family,
    scope: r.scope as RuleDef["scope"],
    when: r.when as RuleDef["when"],
    candidates: (r.candidateEvents ?? []) as RuleDef["candidates"],
    effects: (r.effects ?? []) as RuleDef["effects"],
    priority: r.priority,
    probability: r.probability,
    cooldown: r.cooldown,
    enabled: r.enabled,
    lastFiredTick: -1,
  }));

  const relationships: Relationship[] = (getProjectRelationships(projectId) ?? []).map((r) => ({
    id: r.id,
    actorAId: r.actorAId,
    actorBId: r.actorBId,
    familiarity: r.familiarity,
    trust: r.trust,
    affection: r.affection,
    resentment: r.resentment,
    dependence: r.dependence,
    fear: r.fear,
    obligation: r.obligation,
    respect: r.respect,
    knowledge: r.knowledge,
    expectations: (r.expectations ?? {}) as Record<string, unknown>,
    history: (r.history ?? []) as string[],
  }));

  const constraints: NarrativeConstraint[] = (getProjectConstraints(projectId) ?? []).map((c) => ({
    id: c.id,
    name: c.name,
    class: c.class as NarrativeConstraint["class"],
    target: (c.target ?? {}) as Record<string, unknown>,
    description: c.description,
    deadline: c.deadline,
    priority: c.priority,
    satisfied: c.satisfied,
    satisfiedAt: c.satisfiedAt ? Math.floor(c.satisfiedAt.getTime() / 1000) : null,
  }));

  // Load persisted events — they have positive ids (temp ids start at -1).
  const persistedEvents: EngineEvent[] = (listEvents(simulationId, { limit: 5000 }) ?? []).map((e) => ({
    id: e.id,
    level: e.level as "micro" | "event",
    eventType: e.eventType,
    participants: (e.participants ?? []) as string[],
    location: e.location,
    timestamp: e.timestamp,
    trigger: (e.trigger ?? {}) as Record<string, unknown>,
    preconditions: (e.preconditions ?? {}) as Record<string, unknown>,
    action: (e.action ?? {}) as Record<string, unknown>,
    transition: (e.transition ?? {}) as Record<string, unknown>,
    consequences: (e.consequences ?? {}) as Record<string, unknown>,
    causalLoad: (e.causalLoad ?? { class: "connective", magnitude: "none" }) as EngineEvent["causalLoad"],
    narrativeWeight: (e.narrativeWeight ?? "low") as "low" | "medium" | "high",
    certainty: e.certainty,
    visibility: (e.visibility ?? "private") as "private" | "observed" | "public",
    stateChanges: (e.stateChanges ?? []) as EngineEvent["stateChanges"],
    parentEventIds: [],
  }));

  const queue = (listQueueItems(simulationId) ?? []).map((q) => ({
    id: q.id,
    scheduledAt: q.scheduledAt,
    type: q.type,
    payload: (q.payload ?? {}) as Record<string, unknown>,
    status: q.status as "pending" | "processed" | "cancelled",
  }));

  const maxPersistedId = persistedEvents.length > 0 ? Math.max(...persistedEvents.map((e) => e.id)) : 0;

  return {
    projectId,
    simulationId,
    worldSeed: sim.worldSeed,
    simulationSeed: sim.simulationSeed,
    clock: (sim.clock ?? { day: 0, minute: 360 }) as { day: number; minute: number },
    settings: (sim.settings ?? { tickMinutes: 10, maxEventsPerRun: 40, granularity: "hour" }) as World["settings"],
    actors,
    environments,
    systems,
    rules,
    relationships,
    constraints,
    queue,
    events: persistedEvents,
    nextTempId: -(maxPersistedId + 1), // negative temp ids, starting after the last persisted id
  };
}