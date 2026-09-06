/**
 * Transition engine — atomic per spec §16, layered per spec §15.
 *
 *   current state
 *     → temp clone
 *     → state_compatibility pre-check (target resolution, op/type fit, immutable fields)
 *     → apply effects to temp
 *     → constraint_validation (forbidden/range)
 *     → result_validation (full record vs state schema)
 *     → commit, or discard with the failing layer
 *
 * A rejected transition never mutates the caller's state.
 */

import { cloneState, applyEffect, getByPath, validateStateDefinition, resolveEffectValue } from "./state";
import { validateConstraints, validateResultState } from "./validation";
import type { Constraint, Effect, StateDefinition, ValidationResult } from "./types";

export type TransitionResult = {
  committed: boolean;
  newState: Record<string, unknown>;
  validation: ValidationResult;
  changes: { target: string; field: string; from: unknown; to: unknown }[];
};

const NUMERIC_OPS = new Set(["add", "subtract", "multiply", "divide", "increment", "decrement"]);
const ARRAY_OPS = new Set(["append", "remove"]);

function rejected(state: Record<string, unknown>, layer: ValidationResult["layer"], reason: string): TransitionResult {
  return { committed: false, newState: state, validation: { valid: false, layer, reason }, changes: [] };
}

/**
 * Resolve an effect target to the object it mutates inside the temp state.
 * "state" → root; "entity:<id>" / "rel:<id>" → the stored sub-record.
 */
export function resolveEffectTarget(
  temp: Record<string, unknown>,
  effect: Effect
): { obj?: Record<string, unknown>; error?: string } {
  if (effect.target === "state") return { obj: temp };
  if (effect.target.startsWith("entity:") || effect.target.startsWith("rel:")) {
    const obj = temp[effect.target];
    if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
      return { error: `unknown target "${effect.target}" at runtime` };
    }
    return { obj: obj as Record<string, unknown> };
  }
  return { error: `unresolvable target "${effect.target}" (expected "state", "entity:<id>" or "rel:<id>")` };
}

function failure(state: Record<string, unknown>, layer: NonNullable<ValidationResult["layer"]>, reason: string): TransitionResult {
  return rejected(state, layer, reason);
}

/** Collect the state-field paths referenced by a declarative effect value
 *  ({$field: "a.b"}, {$mul: [...]} etc.) so the pre-flight can tell whether
 *  the runtime value depends on other effects in the same batch (GAP-5). */
function collectFieldRefs(value: unknown, out: string[]): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length !== 1) return;
  const key = keys[0];
  if (key === "$field") {
    if (typeof obj[key] === "string") out.push(obj[key] as string);
    return;
  }
  if (key === "$mul" || key === "$add" || key === "$sub" || key === "$div") {
    for (const part of obj[key] as unknown[]) collectFieldRefs(part, out);
  }
}

export function applyTransition(
  state: Record<string, unknown>,
  effects: Effect[],
  schema: Record<string, StateDefinition>,
  constraints: Constraint[] = []
): TransitionResult {
  const temp = cloneState(state);

  // ── state_compatibility (§15 layer 4): pre-flight on every effect ─────────
  for (const effect of effects) {
    const resolved = resolveEffectTarget(temp, effect);
    if (resolved.error) return failure(state, "transition_validation", resolved.error);

    const rootField = effect.field.split(".")[0];
    const def = schema[rootField];
    if (def && def.mutable === false) {
      return failure(state, "state_compatibility", `field "${effect.field}" is immutable`);
    }

    const current = getByPath(resolved.obj!, effect.field);
    if (NUMERIC_OPS.has(effect.op) && current !== undefined && typeof current !== "number") {
      return failure(state, "state_compatibility", `cannot ${effect.op} non-number field "${effect.field}"`);
    }
    if (ARRAY_OPS.has(effect.op) && current !== undefined && !Array.isArray(current)) {
      return failure(state, "state_compatibility", `cannot ${effect.op} on non-array field "${effect.field}"`);
    }
    if (effect.op === "set" && def) {
      // GAP-5 (Phase I): declarative effect values ({$field}, {$mul}, …) are
      // descriptors, not runtime values — resolve before type validation or
      // every `set` with a reference is rejected as a type error. When the
      // descriptor references fields mutated earlier in the SAME transition
      // batch, the runtime value cannot be predicted here — defer to the
      // post-apply constraint/result validation (which still rejects
      // atomically). Unresolvable references stay runtime no-ops.
      const refs: string[] = [];
      collectFieldRefs(effect.value, refs);
      const mutated = new Set(effects.map((e) => e.field));
      if (!refs.some((r) => mutated.has(r))) {
        const resolvedValue = resolveEffectValue(effect.value, resolved.obj!);
        const typeError = validateStateDefinition(rootField, resolvedValue, def);
        if (typeError) return failure(state, "state_compatibility", `set rejected: ${typeError}`);
      }
    }
  }

  // ── apply to temp ──────────────────────────────────────────────────────────
  const changes: TransitionResult["changes"] = [];
  for (const effect of effects) {
    const resolved = resolveEffectTarget(temp, effect);
    if (!resolved.obj) continue; // already rejected above
    const { from, to } = applyEffect(resolved.obj, effect);
    changes.push({ target: effect.target, field: effect.field, from, to });
  }

  // ── constraint_validation (§15 layer 3) ────────────────────────────────────
  const constraintCheck = validateConstraints(temp, constraints);
  if (!constraintCheck.valid) return rejected(state, constraintCheck.layer, constraintCheck.reason ?? "constraint violated");

  // ── result_validation (§15 layer 6): full record vs schema ────────────────
  const resultCheck = validateResultState(temp, schema);
  if (!resultCheck.valid) return rejected(state, resultCheck.layer, resultCheck.reason ?? "invalid resulting state");

  return { committed: true, newState: temp, validation: { valid: true }, changes };
}
