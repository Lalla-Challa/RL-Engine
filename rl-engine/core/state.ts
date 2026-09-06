/**
 * State helpers — dotted-path access, typed schema validation, condition evaluation, effects.
 * Spec §6 (typed state), §11 (composable conditions), §12 (full effect ops), §16 (atomic).
 */

import type { Condition, ConditionGroup, ConditionNode, Effect, StateDefinition } from "./types";

export function isConditionGroup(node: ConditionNode): node is ConditionGroup {
  return typeof node === "object" && node !== null && ("all" in node || "any" in node || "not" in node);
}

export function getByPath(obj: Record<string, unknown>, path: string): unknown {
  let current: unknown = obj;
  for (const part of path.split(".")) {
    if (current === null || current === undefined || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export function setByPath(obj: Record<string, unknown>, path: string, value: unknown): { previous: unknown } {
  const parts = path.split(".");
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (!(part in current) || current[part] === null || typeof current[part] !== "object") current[part] = {};
    current = current[part] as Record<string, unknown>;
  }
  const last = parts[parts.length - 1];
  const previous = current[last];
  current[last] = value;
  return { previous };
}

export function evaluateCondition(record: Record<string, unknown>, condition: { field: string; op: string; value?: unknown }): boolean {
  const actual = getByPath(record, condition.field);
  switch (condition.op) {
    case "eq":
    case "==":
      return actual === condition.value;
    case "ne":
    case "!=":
      return actual !== condition.value;
    case "gt":
    case ">":
      return typeof actual === "number" && typeof condition.value === "number" && actual > condition.value;
    case "gte":
    case ">=":
      return typeof actual === "number" && typeof condition.value === "number" && actual >= condition.value;
    case "lt":
    case "<":
      return typeof actual === "number" && typeof condition.value === "number" && actual < condition.value;
    case "lte":
    case "<=":
      return typeof actual === "number" && typeof condition.value === "number" && actual <= condition.value;
    case "in":
      if (!Array.isArray(condition.value)) return false;
      return Array.isArray(actual) ? actual.some((a) => (condition.value as unknown[]).includes(a)) : (condition.value as unknown[]).includes(actual);
    case "not_in":
      if (!Array.isArray(condition.value)) return false;
      return Array.isArray(actual) ? !actual.some((a) => (condition.value as unknown[]).includes(a)) : !(condition.value as unknown[]).includes(actual);
    case "exists":
      return actual !== undefined && actual !== null;
    case "absent":
      return actual === undefined || actual === null;
    case "contains":
      if (typeof actual === "string" && typeof condition.value === "string") return actual.includes(condition.value);
      if (Array.isArray(actual)) return actual.includes(condition.value);
      if (actual !== null && typeof actual === "object") return Object.keys(actual).includes(String(condition.value));
      return false;
    default:
      return false;
  }
}

export function evaluateConditionNode(record: Record<string, unknown>, node: ConditionNode): boolean {
  if (isConditionGroup(node)) {
    if (node.all !== undefined) return node.all.every((n) => evaluateConditionNode(record, n));
    if (node.any !== undefined) return node.any.some((n) => evaluateConditionNode(record, n));
    if (node.not !== undefined) return !evaluateConditionNode(record, node.not);
    return false;
  }
  return evaluateCondition(record, node as Condition);
}

export function validateStateDefinition(field: string, value: unknown, def: StateDefinition): string | null {
  if (value === undefined || value === null) {
    if (def.default !== undefined) return null;
    return null;
  }
  switch (def.type) {
    case "boolean":
      if (typeof value !== "boolean") return `${field}: expected boolean`;
      break;
    case "integer":
      if (typeof value !== "number" || !Number.isInteger(value)) return `${field}: expected integer`;
      break;
    case "float":
      if (typeof value !== "number") return `${field}: expected float`;
      break;
    case "string":
      if (typeof value !== "string") return `${field}: expected string`;
      break;
    case "enum":
      if (def.allowedValues && !def.allowedValues.includes(value)) return `${field}: value not in allowedValues`;
      break;
    case "array":
      if (!Array.isArray(value)) return `${field}: expected array`;
      break;
    case "object":
      if (typeof value !== "object" || Array.isArray(value)) return `${field}: expected object`;
      break;
  }
  if (typeof value === "number") {
    if (def.min !== undefined && value < def.min) return `${field}: below min ${def.min}`;
    if (def.max !== undefined && value > def.max) return `${field}: above max ${def.max}`;
  }
  return null;
}

export function validateStateRecord(record: Record<string, unknown>, schema: Record<string, StateDefinition>): string[] {
  const errors: string[] = [];
  for (const [field, def] of Object.entries(schema)) {
    const value = getByPath(record, field);
    const err = validateStateDefinition(field, value, def);
    if (err) errors.push(err);
  }
  return errors;
}

export function applyEffect(target: Record<string, unknown>, effect: Effect): { from: unknown; to: unknown } {
  const from = getByPath(target, effect.field);
  // Declarative value resolution (§31 subset): {$field}/{$mul}/{$add}/{$sub}/{$div}.
  // undefined = unresolvable (e.g. $div by zero) → the effect is a no-op.
  const value = resolveEffectValue(effect.value, target);
  if (value === undefined && effect.value !== undefined && effect.value !== null) {
    return { from, to: from };
  }

  const num = (x: unknown, fallback: number): number => (typeof x === "number" && Number.isFinite(x) ? x : fallback);
  let to: unknown;

  switch (effect.op) {
    case "set":
      to = value;
      setByPath(target, effect.field, to);
      break;
    case "add":
    case "increment": {
      to = num(from, 0) + num(value, 0);
      setByPath(target, effect.field, to);
      break;
    }
    case "subtract":
    case "decrement": {
      to = num(from, 0) - num(value, 0);
      setByPath(target, effect.field, to);
      break;
    }
    case "multiply": {
      to = num(from, 0) * num(value, 1);
      setByPath(target, effect.field, to);
      break;
    }
    case "divide": {
      const v = num(value, 1);
      if (v === 0) {
        // divide-by-zero is a validation failure, not a crash — leave the field unchanged
        to = from;
        break;
      }
      to = num(from, 0) / v;
      setByPath(target, effect.field, to);
      break;
    }
    case "append": {
      const arr = Array.isArray(from) ? [...from] : [];
      arr.push(value);
      to = arr;
      setByPath(target, effect.field, to);
      break;
    }
    case "remove": {
      const arr = Array.isArray(from) ? [...from] : [];
      const idx = arr.indexOf(value);
      to = idx >= 0 ? [...arr.slice(0, idx), ...arr.slice(idx + 1)] : arr;
      setByPath(target, effect.field, to);
      break;
    }
    case "create": {
      to = value;
      setByPath(target, effect.field, to);
      break;
    }
    case "delete": {
      const parts = effect.field.split(".");
      let cur: Record<string, unknown> = target;
      for (let i = 0; i < parts.length - 1; i++) {
        const p = parts[i];
        if (cur[p] === null || typeof cur[p] !== "object") break;
        cur = cur[p] as Record<string, unknown>;
      }
      const last = parts[parts.length - 1];
      if (last in cur) delete cur[last];
      to = undefined;
      break;
    }
    default:
      to = value;
  }

  return { from, to };
}

/**
 * Effect-value resolver (§31 subset, GAP-2 Phase D).
 *
 * Effect values may be literals or declarative references/combinations:
 *   { "$field": "market.price" }                    → read from target record
 *   { "$mul": [<value>, <value>, …] }               → numeric product
 *   { "$add": [...] } / { "$sub": [...] } / { "$div": [...] }
 * Nesting is allowed: { "$mul": [{ "$field": "order" }, { "$field": "price" }] }.
 *
 * Deterministic and sandboxed: pure data traversal, no eval, no function calls.
 * `$div` by zero (or any non-finite result) resolves to `undefined`, which
 * applyEffect treats as "leave the field unchanged".
 */
export function resolveEffectValue(value: unknown, record: Record<string, unknown>): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length !== 1) return value;
  const key = keys[0];

  if (key === "$field") {
    if (typeof obj[key] !== "string") return value;
    return getByPath(record, obj[key] as string);
  }

  if (key === "$mul" || key === "$add" || key === "$sub" || key === "$div") {
    const parts = obj[key];
    if (!Array.isArray(parts) || parts.length === 0) return value;
    const nums: number[] = [];
    for (const part of parts) {
      const resolved = resolveEffectValue(part, record);
      if (typeof resolved !== "number" || !Number.isFinite(resolved)) return undefined;
      nums.push(resolved);
    }
    let result = nums[0];
    for (let i = 1; i < nums.length; i++) {
      if (key === "$mul") result *= nums[i];
      else if (key === "$add") result += nums[i];
      else if (key === "$sub") result -= nums[i];
      else {
        if (nums[i] === 0) return undefined; // divide by zero → leave unchanged
        result /= nums[i];
      }
    }
    return Number.isFinite(result) ? result : undefined;
  }

  return value;
}

export function cloneState(state: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(state));
}

/**
 * Deterministic JSON: object keys sorted lexicographically, `undefined`
 * dropped. Use this instead of raw `JSON.stringify` wherever two states are
 * compared or hashed — key insertion order must never affect the result.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const raw = JSON.stringify(value);
    return raw === undefined ? "null" : raw;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export function buildEntityRecord(entity: { attributes: Record<string, unknown>; state: Record<string, unknown> }): Record<string, unknown> {
  return { attributes: { ...entity.attributes }, state: { ...entity.state } };
}

export function clockToMinutes(clock: { day: number; minute: number }): number {
  return clock.day * 1440 + clock.minute;
}

export function minutesToClock(total: number): { day: number; minute: number } {
  return { day: Math.floor(total / 1440), minute: total % 1440 };
}

export function addMinutes(clock: { day: number; minute: number }, mins: number): { day: number; minute: number } {
  return minutesToClock(clockToMinutes(clock) + mins);
}
