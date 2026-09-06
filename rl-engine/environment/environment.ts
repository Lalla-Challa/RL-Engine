/**
 * Generic Environment — spec §21, §23 (step pipeline), §16 (atomic),
 * §28 (RandomService), §44 (determinism).
 *
 * reset(seed?) → step(action)* → StepResult{observation, reward, terminated, truncated, info}
 * Invalid actions never mutate state; rejected transitions are discarded.
 */

import type {
  Action,
  Effect,
  Environment,
  EngineEvent,
  EnvironmentSpecification,
  ResetResult,
  RewardResult,
  StateDefinition,
  StepResult,
} from "../core/types";
import { createRandomService } from "../core/randomness";
import type { RandomService } from "../core/randomness";
import { cloneState, evaluateCondition, evaluateConditionNode, setByPath } from "../core/state";
import { applyTransition } from "../core/transitions";
import { validateActionAgainstSpace } from "../core/validation";
import { compileObservation } from "../observation/observation";
import { evaluateReward } from "../reward/reward";
import { findCauses } from "../events/causalGraph";
import type { EngineSnapshot, SnapshottableEnvironment } from "./snapshot";
import { SNAPSHOT_VERSION, sha256Canonical } from "./snapshot";

export function createEnvironment(spec: EnvironmentSpecification, seed: number | string = 42): SnapshottableEnvironment {
  const rng: RandomService = createRandomService(seed);
  let state: Record<string, unknown> = {};
  let stepCount = 0;
  let terminated = false;
  let truncated = false;
  let currentSeed: number | string = seed;
  const lastFired = new Map<string, number>();
  const events: EngineEvent[] = [];
  let episodeIndex = 0;

  function recordEvent(action: Action, effects: Effect[], transition: { committed: boolean; validation: { layer?: unknown }; changes: { target: string; field: string; from: unknown; to: unknown }[] }): void {
    const evt: EngineEvent = {
      id: `evt-${events.length + 1}`,
      timestep: stepCount,
      timestamp: stepCount,
      source: "env",
      action,
      effects,
      stateChanges: transition.changes,
      causes: findCauses(events, { source: "env", action, stateChanges: transition.changes, effects }),
      metadata: {
        committed: transition.committed,
        layer: (transition.validation.layer as string | undefined) ?? null,
        episode: episodeIndex,
      },
    };
    events.push(evt);
  }

  function buildInitialState(): Record<string, unknown> {
    const s: Record<string, unknown> = {};
    for (const [field, def] of Object.entries(spec.state ?? {})) {
      if (def.default !== undefined) setByPath(s, field, def.default);
    }
    for (const e of spec.entities ?? []) {
      s[`entity:${e.id}`] = cloneState((e.state ?? {}) as Record<string, unknown>);
    }
    // Relationships are first-class mutable state so rel:<id> effect targets resolve.
    for (const r of spec.relationships ?? []) {
      s[`rel:${r.id}`] = cloneState((r.state ?? {}) as Record<string, unknown>);
    }
    return s;
  }

  function checkTermination(): { terminated: boolean; truncated: boolean } {
    for (const t of spec.termination ?? []) {
      if (t.kind === "truncated" && t.maxSteps !== undefined && stepCount >= t.maxSteps) {
        return { terminated: false, truncated: true };
      }
      if (t.kind === "terminated" && t.field) {
        if (evaluateCondition(state as Record<string, unknown>, { field: t.field, op: t.op, value: t.value })) {
          return { terminated: true, truncated: false };
        }
      }
    }
    return { terminated: false, truncated: false };
  }

  function allowedActionTypes(): string[] {
    const types: string[] = [];
    for (const a of spec.actions ?? []) {
      if (a.kind === "discrete") types.push(...a.actions);
      else if (a.kind === "parameterized" || a.kind === "continuous" || a.kind === "multiDiscrete") types.push(a.type);
      else if (a.kind === "conditional") {
        const base = a.base;
        if (base.kind === "discrete") types.push(...base.actions);
        else types.push(base.type);
      }
    }
    return types;
  }

  function findContinuousDef(type: string): (typeof spec.actions)[number] & { kind: "continuous" } | undefined {
    for (const a of spec.actions ?? []) {
      if (a.kind === "continuous" && a.type === type) return a;
      if (a.kind === "conditional" && a.base.kind === "continuous" && a.base.type === type) return a.base;
    }
    return undefined;
  }

  function collectEffects(action: Action): Effect[] {
    const effects: Effect[] = [];
    // Continuous pathway (GAP-1c): the clamped value is written to the declared
    // state field BEFORE rule effects apply, so rule conditions and $field
    // effect references see it (e.g. a trading fill sized by the action).
    const continuousDef = findContinuousDef(action.type);
    if (continuousDef && typeof action.value === "number" && Number.isFinite(action.value)) {
      const clamped = Math.min(continuousDef.max, Math.max(continuousDef.min, action.value));
      effects.push({ target: "state", field: continuousDef.field, op: "set", value: clamped });
    }
    const continuousField = continuousDef?.field;
    const continuousValue = effects.length > 0 ? (effects[0].value as number) : undefined;
    const record: Record<string, unknown> = {
      ...state,
      action: action.type,
      ...(action.params ?? {}),
      ...(continuousField !== undefined && continuousValue !== undefined ? { [continuousField]: continuousValue } : {}),
    };
    for (const rule of spec.rules ?? []) {
      if (!rule.enabled) continue;
      const fired = lastFired.get(rule.id);
      if (rule.cooldown > 0 && fired !== undefined && stepCount - fired < rule.cooldown) continue;
      if (rule.conditions.length > 0 && !rule.conditions.every((c) => evaluateConditionNode(record, c))) continue;
      if (rng.nextFloat() > rule.probability) continue;
      effects.push(...rule.effects);
      if (rule.outcomes && rule.outcomes.length > 0) {
        const chosen = rng.weightedChoice(rule.outcomes.map((o) => ({ item: o, weight: o.probability })));
        effects.push(...chosen.effects);
      }
      lastFired.set(rule.id, stepCount);
    }
    // Agent action parameters are explicit state writes (e.g. move.direction).
    if (action.params) {
      for (const [k, v] of Object.entries(action.params)) {
        effects.push({ target: "state", field: k, op: "set", value: v });
      }
    }
    return effects;
  }

  /**
   * Phase H (F2): agent-visible projection. Fields declared
   * `visibility: "hidden"` in the spec participate in transitions and replay
   * but are stripped from everything the agent can read — the agent cannot
   * plan offline over them. The grader's replay verification compares the
   * same stripped projection, so hidden fields never need to be revealed to
   * verify a dossier.
   */
  function agentVisibleState(): Record<string, unknown> {
    const full = cloneState(state);
    for (const [field, def] of Object.entries(spec.state ?? {})) {
      if (def.visibility !== "hidden") continue;
      const parts = field.split(".");
      let cur: Record<string, unknown> = full;
      for (let i = 0; i < parts.length - 1; i++) {
        const p = parts[i];
        if (cur[p] === null || typeof cur[p] !== "object") { cur = null as never; break; }
        cur = cur[p] as Record<string, unknown>;
      }
      if (cur && typeof cur === "object") delete cur[parts[parts.length - 1]];
    }
    return full;
  }

  const env: SnapshottableEnvironment = {
    reset(seedOverride?: number | string): ResetResult {
      if (seedOverride !== undefined) {
        currentSeed = seedOverride;
        rng.seed(seedOverride);
      }
      state = buildInitialState();
      stepCount = 0;
      terminated = false;
      truncated = false;
      lastFired.clear();
      episodeIndex++;
      return { observation: compileObservation(state, spec.observations), info: { seed: currentSeed } };
    },

    step(action: Action): StepResult {
      if (terminated || truncated) {
        return {
          observation: compileObservation(state, spec.observations),
          reward: 0,
          rewardComponents: {},
          terminated,
          truncated,
          info: { error: "episode already terminated; call reset()" },
          state: agentVisibleState(),
        };
      }

      const actionValidation = validateActionAgainstSpace(action, spec.actions ?? []);
      if (!actionValidation.valid) {
        // Invalid action must never modify the environment (§4, §16).
        return {
          observation: compileObservation(state, spec.observations),
          reward: 0,
          rewardComponents: {},
          terminated: false,
          truncated: false,
          info: { valid: false, reason: actionValidation.reason, layer: actionValidation.layer },
          state: agentVisibleState(),
        };
      }

      const prevState = cloneState(state);
      const effects = collectEffects(action);
      const transition = applyTransition(
        state,
        effects,
        spec.state as Record<string, StateDefinition>,
        spec.constraints ?? []
      );
      recordEvent(action, effects, transition);
      if (transition.committed) state = transition.newState;

      stepCount++;
      const term = checkTermination();
      terminated = term.terminated;
      truncated = term.truncated;

      const rewardResult: RewardResult = evaluateReward(prevState, action, state, spec.rewards);

      const info: Record<string, unknown> = {};
      if (!transition.committed) {
        info.valid = false;
        info.layer = transition.validation.layer;
        info.reason = transition.validation.reason;
      }
      if (terminated) info.terminated = true;
      if (truncated) info.truncated = true;

      return {
        observation: compileObservation(state, spec.observations),
        reward: rewardResult.reward,
        rewardComponents: rewardResult.components,
        terminated,
        truncated,
        info,
        state: agentVisibleState(),
      };
    },

    getActionSpace() {
      return spec.actions;
    },

    getObservationSpace() {
      return spec.observations;
    },

    /**
     * Phase H (F2): agent-visible state. Fields declared `visibility: "hidden"`
     * in the spec participate in transitions and replay but are stripped here —
     * the agent cannot read them to plan offline. The grader's replay
     * verification compares the same stripped projection, so hidden fields
     * never need to be revealed to verify a dossier.
     */
    getState() {
      const full = cloneState(state);
      const hidden = Object.entries(spec.state ?? {})
        .filter(([, def]) => def.visibility === "hidden")
        .map(([field]) => field);
      if (hidden.length === 0) return full;
      for (const field of hidden) {
        const parts = field.split(".");
        let cur: Record<string, unknown> = full;
        for (let i = 0; i < parts.length - 1; i++) {
          const p = parts[i];
          if (cur[p] === null || typeof cur[p] !== "object") { cur = null as never; break; }
          cur = cur[p] as Record<string, unknown>;
        }
        if (cur && typeof cur === "object") delete cur[parts[parts.length - 1]];
      }
      return full;
    },

    getSpecification() {
      return spec;
    },

    getEvents() {
      return events.map((e) => JSON.parse(JSON.stringify(e)) as EngineEvent);
    },

    /** Phase E: capture the full mid-episode execution state (§29/§45). */
    snapshot(): EngineSnapshot {
      return {
        version: SNAPSHOT_VERSION,
        specId: spec.environment.id,
        specVersion: spec.environment.version,
        specHash: sha256Canonical(spec),
        seed: currentSeed,
        stepCount,
        episodeIndex,
        terminated,
        truncated,
        lastFired: Object.fromEntries(lastFired),
        rngState: rng.snapshotState(),
        state: cloneState(state),
        stateHash: sha256Canonical(state),
        events: events.map((e) => JSON.parse(JSON.stringify(e)) as EngineEvent),
      };
    },

    /** Phase E: restore a snapshot; the episode continues seamlessly afterwards. */
    restore(snap: EngineSnapshot): void {
      if (snap.specId !== spec.environment.id || snap.specVersion !== spec.environment.version) {
        throw new Error(`snapshot belongs to ${snap.specId}@${snap.specVersion}, not ${spec.environment.id}@${spec.environment.version}`);
      }
      if (snap.specHash !== sha256Canonical(spec)) {
        throw new Error("snapshot spec hash mismatch — the specification has changed since capture");
      }
      if (snap.version !== SNAPSHOT_VERSION) {
        throw new Error(`unsupported snapshot version ${snap.version}`);
      }
      state = snap.state;
      stepCount = snap.stepCount;
      episodeIndex = snap.episodeIndex;
      terminated = snap.terminated;
      truncated = snap.truncated;
      lastFired.clear();
      for (const [k, v] of Object.entries(snap.lastFired)) lastFired.set(k, v);
      rng.seed(snap.seed);
      rng.restoreState(snap.rngState);
      currentSeed = snap.seed;
      events.length = 0;
      events.push(...snap.events.map((e) => JSON.parse(JSON.stringify(e)) as EngineEvent));
      if (sha256Canonical(state) !== snap.stateHash) {
        throw new Error("restored state hash mismatch — snapshot corrupted");
      }
    },
  };

  state = buildInitialState();
  return env;
}
