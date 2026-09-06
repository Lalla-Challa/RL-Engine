/**
 * Validation pipeline — 6 layers per spec §15.
 * Every rejection returns { valid:false, layer, reason } with the §15 layer name:
 *   schema_validation | action_validation | constraint_validation |
 *   state_compatibility | transition_validation | result_validation
 *
 * Layer mapping in the step pipeline:
 *   - schema_validation      → compile time (defaults vs bounds) + reset-time record check
 *   - action_validation      → step(), before any mutation
 *   - constraint_validation  → post-transition, forbidden/range constraints on temp state
 *   - state_compatibility    → pre-transition, op/type compatibility + immutable fields
 *   - transition_validation  → target resolution failures at runtime
 *   - result_validation      → post-transition, full record vs state schema
 */

import type { ActionSpaceDef, Constraint, StateDefinition, ValidationLayer, ValidationResult } from "./types";
import { getByPath, validateStateRecord } from "./state";

export function validateAction(
  action: { type: string; params?: Record<string, unknown>; value?: unknown },
  allowedTypes: string[]
): ValidationResult {
  if (!allowedTypes.includes(action.type)) {
    return { valid: false, layer: "action_validation", reason: `unknown action type: ${action.type}` };
  }
  return { valid: true };
}

/**
 * Full action-space validation (§5) — shape + legality for every declared
 * kind. GAP-1 (Phase D): the platform must be able to validate any declared
 * action-space, not just discrete/parameterized; this is the single shared
 * implementation used by the runtime step pipeline and the compiler.
 */
export function validateActionAgainstSpace(
  action: { type: string; params?: Record<string, unknown>; value?: unknown },
  spaces: ActionSpaceDef[]
): ValidationResult {
  let def: ActionSpaceDef | undefined;
  for (const s of spaces) {
    if (s.kind === "discrete") { if ((s.actions as string[]).includes(action.type)) { def = s; break; } }
    else if (action.type === s.type) { def = s; break; }
  }
  if (!def) {
    return { valid: false, layer: "action_validation", reason: `unknown action type: ${action.type}` };
  }

  switch (def.kind) {
    case "discrete":
      return { valid: true };

    case "continuous": {
      const v = action.value;
      if (typeof v !== "number" || !Number.isFinite(v)) {
        return { valid: false, layer: "action_validation", reason: `action "${action.type}" requires a finite numeric value` };
      }
      if (v < def.min || v > def.max) {
        return { valid: false, layer: "action_validation", reason: `action "${action.type}" value ${v} outside [${def.min}, ${def.max}]` };
      }
      return { valid: true };
    }

    case "multiDiscrete": {
      const dims = action.params?.dims;
      if (!Array.isArray(dims) || dims.length !== def.dims.length) {
        return { valid: false, layer: "action_validation", reason: `action "${action.type}" requires params.dims with ${def.dims.length} entries` };
      }
      for (let i = 0; i < def.dims.length; i++) {
        const dim = def.dims[i];
        const choice = dims[i];
        const matches = (dim.values as unknown[]).some((v) => v === choice || String(v) === String(choice));
        if (!matches) {
          return { valid: false, layer: "action_validation", reason: `action "${action.type}" dim[${i}] (${dim.field}): illegal choice ${JSON.stringify(choice)}` };
        }
      }
      return { valid: true };
    }

    case "parameterized": {
      const params = action.params ?? {};
      for (const [name, spec] of Object.entries(def.params)) {
        const v = params[name];
        if (v === undefined) {
          return { valid: false, layer: "action_validation", reason: `action "${action.type}" missing param "${name}"` };
        }
        if (spec.allowedValues && !spec.allowedValues.some((x) => x === v || String(x) === String(v))) {
          return { valid: false, layer: "action_validation", reason: `action "${action.type}" param "${name}": illegal value ${JSON.stringify(v)}` };
        }
        if (spec.type === "number" && typeof v !== "number") {
          return { valid: false, layer: "action_validation", reason: `action "${action.type}" param "${name}": expected number` };
        }
        if (spec.type === "integer" && (typeof v !== "number" || !Number.isInteger(v))) {
          return { valid: false, layer: "action_validation", reason: `action "${action.type}" param "${name}": expected integer` };
        }
      }
      return { valid: true };
    }

    case "conditional":
      return validateActionAgainstSpace(action, [def.base]);
  }
}

/**
 * Range/forbidden constraints on the post-transition state (§15 layer 3).
 * hard/soft/temporal destination constraints are domain-plugin concerns —
 * the kernel only enforces the two validation-shaped classes.
 */
export function validateConstraints(
  state: Record<string, unknown>,
  constraints: Constraint[]
): ValidationResult {
  for (const c of constraints ?? []) {
    const target = (c.target ?? {}) as { field?: string; min?: number; max?: number; forbidden?: unknown[] };
    const field = target.field;
    if (!field) continue;
    const value = getByPath(state, field);
    if (c.type === "range" && typeof value === "number") {
      if (target.min !== undefined && value < target.min) {
        return { valid: false, layer: "constraint_validation", reason: `constraint "${c.id}": ${field} below min ${target.min}` };
      }
      if (target.max !== undefined && value > target.max) {
        return { valid: false, layer: "constraint_validation", reason: `constraint "${c.id}": ${field} above max ${target.max}` };
      }
    }
    if (c.type === "forbidden" && Array.isArray(target.forbidden)) {
      const hit = target.forbidden.some((f) =>
        typeof value === "string" ? value.includes(String(f)) : Array.isArray(value) ? value.includes(f) : value === f
      );
      if (hit) {
        return { valid: false, layer: "constraint_validation", reason: `constraint "${c.id}": forbidden value matched on ${field}` };
      }
    }
  }
  return { valid: true };
}

/** Validate a full state record against the schema (§15 layer 6 / reset §22). */
export function validateResultState(
  state: Record<string, unknown>,
  schema: Record<string, StateDefinition>
): ValidationResult {
  const errors = validateStateRecord(state, schema);
  if (errors.length > 0) {
    return { valid: false, layer: "result_validation", reason: errors.join("; ") };
  }
  return { valid: true };
}

export function layerName(layer: ValidationLayer): string {
  return layer;
}
