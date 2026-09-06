import type {
  World,
  EngineEvent,
  EvaluatedCandidate,
  StateChangeResult,
  RunResult,
  DecisionOpportunity,
  EntityRef,
} from "./types";
import { mulberry32, hashSeed, roll } from "./rng";
import { clockToMinutes, addMinutes } from "./time";
import { entitiesForRule, ruleMatches, candidatesForRule, renderSummary, resolveStateChangeTarget, actorLocation, conditionFields, actorRecord, relationshipName } from "./rules";
import { computePressure } from "./pressure";
import { validateCandidate } from "./validation";
import { applyStateChange, getByPath } from "./state";
import { linkCausalParents, applyDeferredLoad } from "./causality";
import { constraintPressure, checkConstraintSatisfaction } from "./constraints";
import { applyObservation } from "./observation";

/**
 * The Generator (CCM spec §12): gathers candidate events from rules across
 * all five sources (actor / state / environment / system / interaction —
 * interaction candidates are covered by relationship rules), applies pressure,
 * validates, and emits accepted events as atomic records.
 */

/** Per-tick cap on emitted events, to keep timelines readable. */
const MAX_EVENTS_PER_TICK = 4;

/** Multi-actor interaction boost (CCE v1.1 §24). */
const INTERACTION_BOOST = 1.15;

/**
 * Determine whether a candidate's state changes would all be no-ops
 * (current value already equals proposed value). Used for transition-only
 * repeat control (§23) — candidates that change nothing are skipped.
 */
function allChangesNoop(world: World, candidate: EvaluatedCandidate): boolean {
  const entityName = candidate.entityName;
  const changes = [...candidate.rule.effects, ...candidate.candidate.stateChanges];
  if (changes.length === 0) return true;
  for (const change of changes) {
    const resolved = resolveStateChangeTarget(world, change.target, entityName);
    if (!resolved) return false; // will be caught by validation L2
    const current = getByPath(resolved.obj, change.field);
    if (change.op === "set") {
      if (current !== change.value) {
        // Deep compare for objects.
        if (typeof current !== "object" || typeof change.value !== "object" ||
            JSON.stringify(current) !== JSON.stringify(change.value)) return false;
      }
    } else if (change.op === "increment" && change.value !== 0) return false;
    else if (change.op === "append") {
      if (!Array.isArray(current) || !current.includes(change.value)) return false;
    } else if (change.op === "remove") {
      if (Array.isArray(current) && current.includes(change.value)) return false;
    } else {
      return false; // unknown op → not a noop
    }
  }
  return true;
}

/**
 * Check whether an EvaluatedCandidate involves actors other than its own
 * entity (cross-actor interaction). Used for the interaction priority boost.
 */
function hasCrossActorTargets(candidate: EvaluatedCandidate): boolean {
  if (candidate.entityKind === "relationship") return true;
  const changes = [...candidate.rule.effects, ...candidate.candidate.stateChanges];
  for (const c of changes) {
    if (c.target.startsWith("actor:") || c.target.startsWith("relationship:")) return true;
  }
  return false;
}

/**
 * Derive an event category from the entity kind and state-change targets.
 * Metadata only (CCE v1.1 §21) — never gates truth or extraction.
 */
function deriveCategory(candidate: EvaluatedCandidate): string {
  if (candidate.candidate.narrativeWeight === "high") return "critical";
  if (candidate.entityKind === "relationship") return "relationship";
  if (hasCrossActorTargets(candidate)) return "interaction";
  if (candidate.entityKind === "environment") return "environment";
  if (candidate.entityKind === "system") return "system";
  if (candidate.entityKind === "actor") return "decision";
  return "routine";
}

/**
 * Build a Decision Opportunity (CCE v1.1 §6) for one actor: gather all
 * actor-scoped rule candidates that match the actor's current state, apply
 * pressure and constraint bias, and return the full opportunity structure.
 *
 * Used by the simulator to select actor actions and by tests/report to
 * demonstrate the concept of "actor has multiple legitimate actions."
 */
export function gatherActorOpportunity(world: World, actor: World["actors"][0]): DecisionOpportunity {
  const record = actorRecord(actor);
  const actions: EvaluatedCandidate[] = [];

  for (const rule of world.rules) {
    if (!rule.enabled) continue;
    if (rule.scope !== "actor") continue;
    if (rule.lastFiredTick >= 0) continue; // fired this run; cooldown handled per tick

    if (!ruleMatches(rule, record)) continue;

    const entity: EntityRef = { kind: "actor", name: actor.name, record };
    const pressureCandidates = candidatesForRule(rule, entity, 1.0);
    const ccp = constraintPressure(world, entity.name);
    for (const candidate of pressureCandidates) {
      candidate.pressure = computePressure(world, entity, candidate);
      candidate.probability = Math.max(0, Math.min(1, candidate.probability * candidate.pressure * ccp));
      // Interaction priority boost (§24): multi-actor candidates get a small edge.
      if (hasCrossActorTargets(candidate)) {
        candidate.probability = Math.min(1, candidate.probability * INTERACTION_BOOST);
      }
      actions.push(candidate);
    }
  }

  return {
    actorName: actor.name,
    state: record,
    activePressures: [...actor.drives, ...actor.habits, ...actor.plans, ...Object.values(actor.goals).flat()],
    constraints: [...actor.constraints],
    relationships: world.relationships
      .filter((r) => r.actorAId === actor.id || r.actorBId === actor.id)
      .map((r) => relationshipName(world, r)),
    actions,
  };
}

type GenerationResult = {
  newEvents: EngineEvent[];
  candidates: number;
  rejected: number;
  rejections: RunResult["summary"]["rejections"];
  /** Per-actor Decision Opportunities built during this tick (v1.1 §6). */
  opportunities: DecisionOpportunity[];
};

/**
 * Run one tick: evaluate every enabled rule against its scope, apply pressure,
 * sort by priority, and roll for selection. Selected candidates pass through
 * the validation engine; accepted ones are applied and recorded.
 */
function generateForTick(
  world: World,
  rng: () => number,
  tickIndex: number
): GenerationResult {
  const newEvents: EngineEvent[] = [];
  let candidates = 0;
  let rejected = 0;
  const rejections: RunResult["summary"]["rejections"] = [];

  const gathered: EvaluatedCandidate[] = [];

  // Per-actor Decision Opportunities (v1.1 §6): each actor's plausible
  // actions for this tick, recorded in rule-major order so the selection
  // ordering (and determinism) is unchanged.
  const opportunities: DecisionOpportunity[] = world.actors.map((actor) => ({
    actorName: actor.name,
    state: actorRecord(actor),
    activePressures: [...actor.drives, ...actor.habits, ...actor.plans, ...Object.values(actor.goals).flat()],
    constraints: [...actor.constraints],
    relationships: world.relationships
      .filter((r) => r.actorAId === actor.id || r.actorBId === actor.id)
      .map((r) => relationshipName(world, r)),
    actions: [],
  }));
  const opportunityByName = new Map(opportunities.map((o) => [o.actorName, o]));

  for (const rule of world.rules) {
    if (!rule.enabled) continue;
    if (rule.lastFiredTick >= 0 && tickIndex - rule.lastFiredTick < rule.cooldown) continue;

    for (const entity of entitiesForRule(world, rule)) {
      if (!ruleMatches(rule, entity.record)) continue;

      // Pressure engine modulates probability per entity.
      const pressureCandidates = candidatesForRule(rule, entity, 1.0);
      // Narrative-constraint bias (L1): unsatisfied destinations aimed at this
      // entity nudge its candidates toward the plot.
      const ccp = constraintPressure(world, entity.name);
      for (const candidate of pressureCandidates) {
        candidate.pressure = computePressure(world, entity, candidate);
        candidate.probability = Math.max(
          0,
          Math.min(1, candidate.probability * candidate.pressure * ccp)
        );
        // Multi-actor interaction priority (v1.1 §24): candidates that reach
        // other actors compete a little harder against background events.
        if (hasCrossActorTargets(candidate)) {
          candidate.probability = Math.min(1, candidate.probability * INTERACTION_BOOST);
        }
      }
      gathered.push(...pressureCandidates);

      // Record the entity's actions into its actor opportunity (v1.1 §6).
      if (entity.kind === "actor") {
        const opp = opportunityByName.get(entity.name);
        if (opp) opp.actions.push(...pressureCandidates);
      }
    }
  }

  // Deterministic ordering: rule priority desc, then probability desc, then id.
  gathered.sort((a, b) => {
    if (b.rule.priority !== a.rule.priority) return b.rule.priority - a.rule.priority;
    if (b.probability !== a.probability) return b.probability - a.probability;
    return a.rule.id - b.rule.id;
  });

  candidates = gathered.length;

  let significantThisTick = 0;
  for (const candidate of gathered) {
    // Micro-events (low narrative weight) don't consume the per-tick or
    // per-run event budget — always-on environment rules (ferry/ward churn)
    // must not starve the actor chain (CCE audit, L4).
    const isSignificant = candidate.candidate.narrativeWeight !== "low";
    if (isSignificant && significantThisTick >= MAX_EVENTS_PER_TICK) break;

    // Transition-only repeat control (v1.1 §23): a candidate that would not
    // actually change any state is skipped, breaking always-on churn like
    // ward_crowded → ward_crowded → ward_crowded.
    if (candidate.candidate.transitionOnly && allChangesNoop(world, candidate)) continue;

    if (!roll(rng, candidate.probability)) continue;

    const verdict = validateCandidate(world, candidate);
    if (!verdict.ok) {
      rejected++;
      if (rejections.length < 20) {
        rejections.push({
          layer: verdict.layer ?? 0,
          reason: verdict.reason ?? "validation failed",
          candidateId: candidate.candidate.id,
          rule: candidate.rule.name,
          entity: candidate.entityName,
        });
      }
      continue;
    }

    const event = emitCandidate(world, candidate);
    newEvents.push(event);
    world.events.push(event);
    candidate.rule.lastFiredTick = tickIndex;
    if (isSignificant) significantThisTick++;
  }

  return { newEvents, candidates, rejected, rejections, opportunities };
}

/** Build the atomic event record for an accepted candidate and apply its state changes. */
function emitCandidate(world: World, candidate: EvaluatedCandidate): EngineEvent {
  const entityName = candidate.entityName;
  const timestamp = clockToMinutes(world.clock);
  const id = world.nextTempId--;
  const changes: StateChangeResult[] = [];
  const participants = new Set<string>([entityName]);

  // Relationship-scoped candidates: the entity is the bond itself — its two
  // actors are the real participants.
  if (candidate.entityKind === "relationship") {
    const [a, b] = entityName.split(":");
    participants.delete(entityName);
    if (a) participants.add(a);
    if (b) participants.add(b);
  }

  for (const change of [...candidate.rule.effects, ...candidate.candidate.stateChanges]) {
    const resolved = resolveStateChangeTarget(world, change.target, entityName);
    if (!resolved) continue;

    // Collect participants named by relationship/actor targets.
    if (change.target.startsWith("relationship:")) {
      const [a, b] = change.target.slice("relationship:".length).split(":");
      participants.add(a);
      participants.add(b);
    } else if (change.target.startsWith("actor:")) {
      participants.add(change.target.slice("actor:".length));
    }

    const { from, to } = applyStateChange(resolved.obj, change.field, change.op, change.value);
    changes.push({ target: resolved.label, field: change.field, from, to });
  }

  // Location: actor kind → their current environment; environment kind → itself.
  let location: string | null = null;
  if (candidate.entityKind === "environment") {
    location = entityName;
  } else if (candidate.entityKind === "actor") {
    const actor = world.actors.find((a) => a.name === entityName);
    if (actor) location = actorLocation(world, actor);
  }

  // Visibility: observed when another actor shares the location.
  let visibility: EngineEvent["visibility"] = "private";
  if (location) {
    const othersHere = world.actors.some(
      (a) => a.name !== entityName && a.state.location === location
    );
    if (othersHere) visibility = "observed";
  }

  const summary = renderSummary(candidate.candidate.summary, entityName);
  const category = deriveCategory(candidate);
  const event: EngineEvent = {
    id,
    level: candidate.candidate.level,
    eventType: candidate.candidate.id,
    participants: Array.from(participants),
    location,
    timestamp,
    trigger: { source: "rule", ruleId: candidate.rule.id, ruleName: candidate.rule.name, category },
    category,
    preconditions: Object.fromEntries(
      conditionFields(candidate.rule).map((f) => [f, true])
    ),
    action: { summary },
    transition: { applied: changes.length },
    consequences: {},
    causalLoad: { class: "connective", magnitude: "none" },
    narrativeWeight: candidate.candidate.narrativeWeight,
    certainty: Math.round((0.4 + candidate.probability * 0.6) * 100) / 100,
    visibility,
    stateChanges: changes,
    parentEventIds: [],
  };
  event.parentEventIds = linkCausalParents(
    world,
    event,
    conditionFields(candidate.rule),
    candidate.candidate.requiresKnowledge
  );
  return event;
}

/**
 * The simulation loop (CCM spec §39): advance the clock, drain due queue
 * items, generate events, stop early when the run cap is reached, then apply
 * deferred causal load. Fully deterministic for a given world + seeds.
 */
export function runSimulation(world: World, ticks: number): RunResult {
  const startActorStates: RunResult["startActorStates"] = {};
  for (const actor of world.actors) {
    startActorStates[actor.name] = {
      attributes: JSON.parse(JSON.stringify(actor.attributes)),
      state: JSON.parse(JSON.stringify(actor.state)),
    };
  }

  const rng = mulberry32(hashSeed(world.simulationSeed, clockToMinutes(world.clock)));
  const newEvents: EngineEvent[] = [];
  let candidates = 0;
  let rejected = 0;
  let queueProcessed = 0;
  const rejections: RunResult["summary"]["rejections"] = [];
  let significantEvents = 0;
  const MAX_TOTAL_EVENTS = (world.settings.maxEventsPerRun ?? 40) * 5;

  for (let tickIndex = 1; tickIndex <= ticks; tickIndex++) {
    world.clock = addMinutes(world.clock, world.settings.tickMinutes);
    const now = clockToMinutes(world.clock);

    // Drain the event queue: scheduled world processes become events.
    for (const item of world.queue) {
      if (item.status !== "pending") continue;
      if (item.scheduledAt > now) continue;
      item.status = "processed";
      queueProcessed++;

      const summary = String(item.payload.summary ?? item.type);
      const event: EngineEvent = {
        id: world.nextTempId--,
        level: "event",
        eventType: item.type,
        participants: Array.isArray(item.payload.participants) ? item.payload.participants : [],
        location: typeof item.payload.location === "string" ? item.payload.location : null,
        timestamp: item.scheduledAt,
        trigger: { source: "queue", queueItemId: item.id },
        preconditions: {},
        action: { summary },
        transition: {},
        consequences: {},
        causalLoad: { class: "connective", magnitude: "none" },
        narrativeWeight: "low",
        certainty: 1,
        visibility: "public",
        stateChanges: [],
        parentEventIds: [],
      };
      newEvents.push(event);
      world.events.push(event);
    }

    const result = generateForTick(world, rng, tickIndex);
    newEvents.push(...result.newEvents);
    candidates += result.candidates;
    rejected += result.rejected;
    if (result.rejections) rejections.push(...result.rejections);

    // Observation → knowledge transfer (v1.1 §13): actors at the same
    // location as a non-participant observer gain knowledge of the event.
    applyObservation(world, result.newEvents);

    // Narrative-constraint planner (L1): after each tick, mark destination
    // constraints whose target conditions now hold as satisfied.
    checkConstraintSatisfaction(world);

    // Count only significant events toward the run budget; micro churn is
    // bounded separately by MAX_TOTAL_EVENTS so it can't balloon the DB.
    significantEvents = newEvents.filter((e) => e.narrativeWeight !== "low").length;
    if (significantEvents >= world.settings.maxEventsPerRun) break;
    if (newEvents.length >= MAX_TOTAL_EVENTS) break;
  }

  const loadEscalations = applyDeferredLoad(world, newEvents);

  return {
    newEvents,
    finalClock: world.clock,
    loadEscalations,
    startActorStates,
    summary: {
      ticks: Math.min(ticks, significantEvents >= world.settings.maxEventsPerRun ? significantEvents : ticks),
      candidates,
      selected: newEvents.length,
      rejected,
      queueProcessed,
      rejections: rejections.slice(-20),
    },
  };
}
