/**
 * Observation engine — spec §17
 * Internal State → Observation Rules → Observation (fully or partially observable)
 *
 * Field forms:
 *   { field, source }                       → copy state[source] into observation
 *   { field, source: "entities", filter? }  → collect all entity records, optional predicate
 *   { field, source, filter? }              → if source resolves to an array, filter elements
 *
 * Filters are sandboxed single predicates: "<path> <op> <value>" — parsed and
 * evaluated with the same condition semantics as rules; no eval, no code.
 */

import type { Condition, ConditionOp, Observation, ObservationSpaceDef } from "../core/types";
import { getByPath, evaluateCondition } from "../core/state";

const OP_ALIASES: Record<string, ConditionOp> = {
  "==": "eq", "!=": "ne", ">": "gt", ">=": "gte", "<": "lt", "<=": "lte", includes: "contains",
};

export function parseFilter(filter: string): Condition | null {
  const m = /^\s*([\w.:-]+)\s*(==|!=|>=|<=|>|<|includes)\s*(.+?)\s*$/.exec(filter);
  if (!m) return null;
  const [, field, op, rawValue] = m;
  let value: unknown;
  if (rawValue === "true") value = true;
  else if (rawValue === "false") value = false;
  else if (rawValue === "null") value = null;
  else if (/^-?\d+(\.\d+)?$/.test(rawValue)) value = Number(rawValue);
  else value = rawValue.replace(/^["']|["']$/g, "");
  return { field, op: OP_ALIASES[op] ?? (op as ConditionOp), value };
}

function filtered(value: unknown, condition: Condition): unknown {
  if (Array.isArray(value)) return value.filter((entry) => entry !== null && typeof entry === "object" && evaluateCondition(entry as Record<string, unknown>, condition));
  return value;
}

export function compileObservation(state: Record<string, unknown>, obsSpace: ObservationSpaceDef): Observation {
  if (!obsSpace || obsSpace.fields.length === 0) return { ...state };

  const obs: Observation = {};
  for (const field of obsSpace.fields) {
    if (field.source === "entities") {
      // Collect every entity record into a list, optionally filtered.
      const entries: Record<string, unknown>[] = [];
      for (const [key, value] of Object.entries(state)) {
        if (!key.startsWith("entity:") || value === null || typeof value !== "object") continue;
        const record = { id: key.slice("entity:".length), ...(value as Record<string, unknown>) };
        entries.push(record);
      }
      const condition = field.filter ? parseFilter(field.filter) : null;
      obs[field.field] = condition ? entries.filter((e) => evaluateCondition(e, condition)) : entries;
      continue;
    }

    const value = getByPath(state, field.source);
    if (value === undefined) continue;
    const condition = field.filter ? parseFilter(field.filter) : null;
    obs[field.field] = condition ? filtered(value, condition) : value;
  }
  return obs;
}
