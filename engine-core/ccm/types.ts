import type {
  CcmClock,
  CcmCausalLoad,
  CcmSimulationSettings,
} from "../../drizzle/schema";

export type { CcmClock, CcmCausalLoad, CcmSimulationSettings };

/**
 * CCM domain types — the in-memory model the symbolic engine operates on.
 * The engine is a pure module: it never touches the DB. The loader hydrates
 * a `World` from the ccm_* tables, the simulator steps it, and the persister
 * writes the delta back. Everything is deterministic given the seeds.
 */

// ─── Rule DSL ───────────────────────────────────────────────────────────────

export type ConditionOp =
  | "eq"
  | "ne"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "in"
  | "not_in"
  | "exists"
  | "absent";

/** A single predicate against a dotted path into an entity's merged record. */
export type Condition = {
  /** Dotted path, e.g. "state.exertion", "attributes.condition", "drives". */
  field: string;
  op: ConditionOp;
  value?: unknown;
};

export type StateChangeOp = "set" | "increment" | "append" | "remove";

/**
 * A structured state transition proposed by a rule candidate. `target`
 * resolves at evaluation time:
 * - "self" — the entity the rule fired on (actor or environment)
 * - "environment:Name" — a named environment
 * - "actor:Name" — a named actor (e.g. the other side of an interaction)
 * - "relationship:A:B" — the relationship between two actors
 */
export type StateChange = {
  target: string;
  /** Dotted path into the target's attributes/state (or relationship fields). */
  field: string;
  op: StateChangeOp;
  value?: unknown;
};

/** A possible event a rule can generate (CCM spec §10: possibilities, not inevitabilities). */
export type CandidateEventDef = {
  id: string;
  /** Human-readable summary; "{name}" is substituted with the entity name. */
  summary: string;
  level: "micro" | "event";
  narrativeWeight: "low" | "medium" | "high";
  /** Base probability 0..1; multiplied by rule.probability and pressure. */
  probability: number;
  /** Structured transitions applied if this candidate is selected. */
  stateChanges: StateChange[];
  /** Optional knowledge gate: actor must know this to choose the event. */
  requiresKnowledge?: string;
  /** Optional capability gate: actor must be capable of this. */
  requiresCapability?: string;
  /**
   * Repeat control (CCE v1.1 §23): when true, the candidate only fires if its
   * state changes would actually transition state (no-op changes are skipped).
   * Prevents always-active rules from re-emitting identical events every tick.
   */
  transitionOnly?: boolean;
};

export type RuleWhen = {
  conditions: Condition[];
  /** If set, only fires when the entity's drives/goals/habits contain this keyword. */
  requiresPressure?: string;
};

export type RuleScope = "actor" | "environment" | "system" | "relationship" | "narrative";

export type RuleDef = {
  id: number;
  name: string;
  family: string;
  scope: RuleScope;
  when: RuleWhen;
  candidates: CandidateEventDef[];
  /** Rule-level effects applied when any candidate fires. */
  effects: StateChange[];
  priority: number;
  /** Global probability multiplier for all candidates of this rule. */
  probability: number;
  /** Ticks to wait before this rule can fire again. */
  cooldown: number;
  enabled: boolean;
  /** Tick index of last fire (runtime). */
  lastFiredTick: number;
};

// ─── World entities ─────────────────────────────────────────────────────────

export type ActorGoals = {
  survival: string[];
  functional: string[];
  social: string[];
  emotional: string[];
  longTerm: string[];
  /** System-only narrative goals — the actor does NOT know these. */
  narrative: string[];
};

export type ActorBeliefs = {
  known: string[];
  believed: string[];
  uncertain: string[];
  misconceptions: string[];
};

export type Actor = {
  id: number;
  name: string;
  type: string;
  /** Stable traits (age, condition…). */
  attributes: Record<string, unknown>;
  /** Constantly changing (location, fatigue, emotional_state…). */
  state: Record<string, unknown>;
  goals: ActorGoals;
  drives: string[];
  beliefs: ActorBeliefs;
  knowledge: string[];
  capabilities: string[];
  constraints: string[];
  resources: Record<string, unknown>;
  habits: string[];
  plans: string[];
};

export type Environment = {
  id: number;
  name: string;
  type: string;
  attributes: Record<string, unknown>;
  state: Record<string, unknown>;
  resources: Record<string, unknown>;
  inhabitants: string[];
  accessibility: Record<string, unknown>;
  activeProcesses: string[];
  constraints: string[];
};

export type SystemDef = {
  id: number;
  name: string;
  type: string;
  rules: string[];
  constraints: string[];
  activeConditions: string[];
  effects: string[];
  exceptions: string[];
};

export type Relationship = {
  id: number;
  actorAId: number;
  actorBId: number;
  familiarity: string;
  trust: string;
  affection: string;
  resentment: string;
  dependence: string;
  fear: string;
  obligation: string;
  respect: string;
  knowledge: string;
  expectations: Record<string, unknown>;
  history: string[];
};

export type NarrativeConstraint = {
  id: number;
  name: string;
  class: "hard" | "soft" | "forbidden" | "range" | "temporal";
  target: Record<string, unknown>;
  description: string | null;
  /** World minutes; null = no deadline. */
  deadline: number | null;
  priority: number;
  satisfied: boolean;
  /** World-minutes tick when the constraint was automatically satisfied (or null). */
  satisfiedAt: number | null;
};

/**
 * Documented shape of the `target` record for narrative constraints.
 * The engine reads these fields to detect satisfaction and violations.
 */
export type ConstraintTarget = {
  /** Actors this constraint applies to (empty = all). */
  actors?: string[];
  /** Environments this constraint applies to. */
  environments?: string[];
  /** Satisfaction conditions: when ALL match for any target entity, the constraint is satisfied. */
  conditions?: Condition[];
  /** Forbidden keywords (forbidden class). */
  forbidden?: string[];
  /** Field name to check (range / forbidden). */
  field?: string;
  /** Min value (range class). */
  min?: number;
  /** Max value (range class). */
  max?: number;
};

export type QueueItem = {
  id: number;
  scheduledAt: number;
  type: string;
  payload: Record<string, unknown>;
  status: "pending" | "processed" | "cancelled";
};

// ─── Events ─────────────────────────────────────────────────────────────────

export type StateChangeResult = {
  target: string;
  field: string;
  from: unknown;
  to: unknown;
};

export type EngineEvent = {
  /** Negative temp ids are assigned in-memory; remapped to DB ids on persist. */
  id: number;
  level: "micro" | "event";
  eventType: string;
  participants: string[];
  location: string | null;
  /** World minutes (day * 1440 + minute). */
  timestamp: number;
  trigger: Record<string, unknown>;
  /** Metadata classification (CCE v1.1 §21): routine/background/reactive/interaction/decision/discovery/relationship/environment/system/critical. Never gates truth. */
  category?: string;
  preconditions: Record<string, unknown>;
  action: Record<string, unknown>;
  transition: Record<string, unknown>;
  consequences: Record<string, unknown>;
  causalLoad: CcmCausalLoad;
  narrativeWeight: "low" | "medium" | "high";
  certainty: number;
  visibility: "private" | "observed" | "public";
  stateChanges: StateChangeResult[];
  /** Temp ids of parent events (causal graph). */
  parentEventIds: number[];
};

// ─── World & results ────────────────────────────────────────────────────────

export type World = {
  /** Owning project (world model is project-scoped). */
  projectId: number;
  simulationId: number;
  worldSeed: number;
  simulationSeed: number;
  clock: CcmClock;
  settings: CcmSimulationSettings;
  actors: Actor[];
  environments: Environment[];
  systems: SystemDef[];
  rules: RuleDef[];
  relationships: Relationship[];
  constraints: NarrativeConstraint[];
  queue: QueueItem[];
  /** Full event history (temp ids for unpersisted, real ids for persisted). */
  events: EngineEvent[];
  /** Runtime: next temp event id to allocate (starts at -1). */
  nextTempId: number;
};

export type RunResult = {
  newEvents: EngineEvent[];
  finalClock: CcmClock;
  /** Causal load escalations applied to EARLIER (possibly persisted) events. */
  loadEscalations: { eventId: number; newLoad: CcmCausalLoad }[];
  /** Actor attributes+state captured at run start (for skeleton entryState). */
  startActorStates: Record<string, { attributes: Record<string, unknown>; state: Record<string, unknown> }>;
  summary: {
    ticks: number;
    candidates: number;
    selected: number;
    rejected: number;
    queueProcessed: number;
    /** Bounded log of validation rejections (most recent first, max ~20). */
    rejections?: Array<{
      layer: number;
      reason: string;
      candidateId: string;
      rule: string;
      entity: string;
    }>;
  };
};

export type Episode = {
  id: number; // 0 until persisted
  simulationId: number;
  title: string;
  theme: string | null;
  description: string;
  eventIds: number[]; // temp ids, remapped on persist
};

export type SceneSkeleton = {
  id: number; // 0 until persisted
  simulationId: number;
  episodeId: number; // temp id, remapped on persist
  title: string;
  purpose: string | null;
  location: string | null;
  time: CcmClock;
  participants: string[];
  entryState: Record<string, unknown>;
  activePressures: Record<string, unknown>;
  beats: string[];
  turningPoint: string | null;
  exitState: Record<string, unknown>;
  unresolvedThreads: string[];
  importantInformation: string[];
  continuityNotes: string[];
};

export type ExtractionResult = {
  episodes: Episode[];
  skeletons: SceneSkeleton[];
};

/** A resolved entity reference used during rule evaluation. */
export type EntityRef = {
  kind: "actor" | "environment" | "system" | "relationship";
  name: string;
  record: Record<string, unknown>;
};

/** A fully evaluated rule candidate, ready for selection. */
export type EvaluatedCandidate = {
  rule: RuleDef;
  candidate: CandidateEventDef;
  entityKind: "actor" | "environment" | "system" | "relationship" | "narrative";
  entityName: string;
  /** Pressure multiplier applied to probability (from goals/drives/habits/env). */
  pressure: number;
  /** Final selection probability 0..1. */
  probability: number;
  /** Causal parents gathered during evaluation (temp event ids). */
  parents: number[];
};

/**
 * A Decision Opportunity (CCE v1.1 §6): one Actor currently has one or more
 * plausible actions available because of its state and active pressures.
 *
 * Internal, engine-only representation — not persisted. Built by
 * `gatherActorOpportunity` in simulator.ts and used to drive actor selection.
 */
export type DecisionOpportunity = {
  actorName: string;
  /** The actor's merged record (attributes/state/goals/drives/habits/knowledge/beliefs/plans…). */
  state: Record<string, unknown>;
  /** Active pressure sources: goal/drive/habit/plan keywords the actor is under. */
  activePressures: string[];
  /** Restraints the actor cannot or will not do. */
  constraints: string[];
  /** Bonds this actor participates in ("A:B" labels). */
  relationships: string[];
  /** Available actions (EvaluatedCandidates, probability already pressure-scaled). */
  actions: EvaluatedCandidate[];
};
