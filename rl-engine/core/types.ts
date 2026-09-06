/**
 * Generic RL Environment Engine — Core Types
 * Spec §3–12, §15, §21, §28, §41
 *
 * Domain-independent primitives. No story concepts (ActorGoals, narrativeWeight, etc.)
 * appear here — those live in domain-packs.
 */

// ─── State schema (§6) ──────────────────────────────────────────────────────

export type StatePrimitiveType = "boolean" | "integer" | "float" | "string" | "enum" | "array" | "object";

export type StateDefinition = {
  type: StatePrimitiveType;
  min?: number;
  max?: number;
  allowedValues?: unknown[];
  default?: unknown;
  mutable?: boolean;
  visibility?: "public" | "private" | "hidden";
};

// ─── Condition (§11) ────────────────────────────────────────────────────────

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
  | "absent"
  | "contains";

export type Condition = {
  field: string;
  op: ConditionOp;
  value?: unknown;
};

export type ConditionGroup = {
  all?: ConditionNode[];
  any?: ConditionNode[];
  not?: ConditionNode;
};

export type ConditionNode = Condition | ConditionGroup;

// ─── Effect (§12) ───────────────────────────────────────────────────────────

export type EffectOp =
  | "set"
  | "add"
  | "subtract"
  | "multiply"
  | "divide"
  | "append"
  | "remove"
  | "increment"
  | "decrement"
  | "create"
  | "delete";

export type Effect = {
  target: string;
  field: string;
  op: EffectOp;
  value?: unknown;
};

// ─── Entity / Relationship (§7–8) ──────────────────────────────────────────

export type Entity = {
  id: string;
  type: string;
  attributes: Record<string, unknown>;
  state: Record<string, unknown>;
  relationships?: string[];
};

export type Relationship = {
  id: string;
  source: string;
  target: string;
  type: string;
  state: Record<string, unknown>;
};

// ─── Rule (§10) ─────────────────────────────────────────────────────────────

export type Rule = {
  id: string;
  conditions: ConditionNode[];
  effects: Effect[];
  priority: number;
  probability: number;
  outcomes?: RuleOutcome[];
  constraints?: string[];
  enabled: boolean;
  cooldown: number;
  lastFiredTick: number;
  scope: string;
  family?: string;
};

export type RuleOutcome = {
  id: string;
  probability: number;
  effects: Effect[];
};

// ─── Constraint (§6 constraints, generic) ───────────────────────────────────

export type Constraint = {
  id: string;
  type: "hard" | "soft" | "forbidden" | "range" | "temporal";
  target: Record<string, unknown>;
  description?: string | null;
  deadline?: number | null;
  priority: number;
  satisfied: boolean;
  satisfiedAt?: number | null;
};

// ─── Action / ActionSpace (§4–5) ───────────────────────────────────────────
//
// Kind = how the value is shaped; `type` = the stable identity an agent uses
// to address the action (spec §5: actions are requested by name and validated
// by the engine). Discrete actions are addressed by their entry in `actions`.
// GAP-1 (Phase D): continuous/multiDiscrete previously had no `type`
// discriminator, making them unaddressable and unvalidatable at runtime.

export type DiscreteActionDef = {
  kind: "discrete";
  actions: string[];
};

export type ContinuousActionDef = {
  kind: "continuous";
  /** Stable identity for the action envelope. */
  type: string;
  /** Dotted state path the continuous value writes to. */
  field: string;
  min: number;
  max: number;
};

export type MultiDiscreteActionDef = {
  kind: "multiDiscrete";
  /** Stable identity for the action envelope. */
  type: string;
  /** One dimension per entry; each carries its own legal values. */
  dims: { field: string; values: (string | number)[] }[];
};

export type ParameterizedActionDef = {
  kind: "parameterized";
  type: string;
  params: Record<string, { type: string; min?: number; max?: number; allowedValues?: unknown[] }>;
};

export type ConditionalActionDef = {
  kind: "conditional";
  type: string;
  base: ActionSpaceDef;
  when: ConditionNode[];
};

export type ActionSpaceDef = DiscreteActionDef | ContinuousActionDef | MultiDiscreteActionDef | ParameterizedActionDef | ConditionalActionDef;

export type Action = {
  type: string;
  params?: Record<string, unknown>;
  /** Scalar payload for continuous/multiDiscrete selections. */
  value?: unknown;
};

// ─── Observation (§17) ──────────────────────────────────────────────────────

export type ObservationDef = {
  field: string;
  source: string;
  filter?: string;
  visibility?: "public" | "private";
};

export type ObservationSpaceDef = {
  fields: ObservationDef[];
  fullyObservable: boolean;
};

export type Observation = Record<string, unknown>;

// ─── Reward (§18–19) ────────────────────────────────────────────────────────

export type RewardComponentDef = {
  id: string;
  expression: string;
  weight: number;
};

export type RewardDef = {
  components: RewardComponentDef[];
};

export type RewardResult = {
  reward: number;
  components: Record<string, number>;
};

// ─── Termination (§6) ───────────────────────────────────────────────────────

export type TerminationCondition = {
  field: string;
  op: string;
  value: unknown;
  kind: "terminated" | "truncated";
  maxSteps?: number;
};

// ─── Validation (§15) ───────────────────────────────────────────────────────

export type ValidationLayer = "schema_validation" | "action_validation" | "constraint_validation" | "state_compatibility" | "transition_validation" | "result_validation";

export type ValidationResult = {
  valid: boolean;
  layer?: ValidationLayer;
  reason?: string;
};

// ─── Environment Spec (§9) ──────────────────────────────────────────────────

export type EnvironmentSpecMeta = {
  id: string;
  version: string;
  /** Engine spec-format version this document targets (e.g. "1.0"). */
  specVersion?: string;
  description?: string;
};

export type EnvironmentSpecification = {
  environment: EnvironmentSpecMeta;
  state: Record<string, StateDefinition>;
  entities: Entity[];
  relationships?: Relationship[];
  actions: ActionSpaceDef[];
  rules: Rule[];
  observations: ObservationSpaceDef;
  rewards: RewardDef;
  constraints: Constraint[];
  termination: TerminationCondition[];
};

// ─── Step / Reset / Environment API (§21) ───────────────────────────────────

export type StepResult = {
  observation: Observation;
  reward: number;
  rewardComponents?: Record<string, number>;
  terminated: boolean;
  truncated: boolean;
  info: Record<string, unknown>;
  state?: Record<string, unknown>;
};

export type ResetResult = {
  observation: Observation;
  info: Record<string, unknown>;
};

export interface Environment {
  reset(seed?: number | string): ResetResult;
  step(action: Action): StepResult;
  getActionSpace(): ActionSpaceDef[];
  getObservationSpace(): ObservationSpaceDef;
  getState(): Record<string, unknown>;
  getSpecification(): EnvironmentSpecification;
  /** Optional event subsystem (§24): every step recorded with causal links. */
  getEvents?(): EngineEvent[];
  /** Phase E (§29/§45): mid-episode checkpoint capture and seamless restore. */
  snapshot?(): unknown;
  restore?(snapshot: unknown): void;
}

// ─── World / Engine internal (generic replacement for ccm World) ────────────

export type Clock = { day: number; minute: number };

export type EngineSettings = {
  tickMinutes: number;
  maxEventsPerRun: number;
  granularity: "minute" | "hour" | "day";
  maxSteps?: number;
};

export type EngineState = {
  spec: EnvironmentSpecification;
  state: Record<string, unknown>;
  entities: Map<string, Entity>;
  relationships: Map<string, Relationship>;
  clock: Clock;
  settings: EngineSettings;
  seed: number;
  stepCount: number;
  terminated: boolean;
  truncated: boolean;
  events: EngineEvent[];
};

export type EngineEvent = {
  id: string;
  timestep: number;
  timestamp: number;
  source: string;
  action?: Action;
  effects: Effect[];
  stateChanges: { target: string; field: string; from: unknown; to: unknown }[];
  causes: string[];
  metadata?: Record<string, unknown>;
};
