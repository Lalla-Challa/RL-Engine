/**
 * Dotted-path helpers for reading/writing nested records, and applying
 * `StateChange` operations to entities. Used by rules (condition matching),
 * validation (state compatibility), and the state mutator.
 */

export type PathValue = Record<string, unknown> | unknown[] | string | number | boolean | null;

/**
 * Traverse a dotted path into an object.
 * Returns `undefined` if any segment is missing.
 */
export function getByPath(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * Set a value at a dotted path, creating intermediate objects if needed.
 * Mutates `obj` in place. Returns the previous value at that path.
 */
export function setByPath(
  obj: Record<string, unknown>,
  path: string,
  value: unknown
): { previous: unknown } {
  const parts = path.split(".");
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (!(part in current) || current[part] === null || typeof current[part] !== "object") {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }
  const last = parts[parts.length - 1];
  const previous = current[last];
  current[last] = value;
  return { previous };
}

/**
 * Evaluate a condition against a record.
 */
export function evaluateCondition(
  record: Record<string, unknown>,
  condition: { field: string; op: string; value?: unknown }
): boolean {
  const actual = getByPath(record, condition.field);
  switch (condition.op) {
    case "eq":
      return actual === condition.value;
    case "ne":
      return actual !== condition.value;
    case "gt":
      return typeof actual === "number" && typeof condition.value === "number" && actual > condition.value;
    case "gte":
      return typeof actual === "number" && typeof condition.value === "number" && actual >= condition.value;
    case "lt":
      return typeof actual === "number" && typeof condition.value === "number" && actual < condition.value;
    case "lte":
      return typeof actual === "number" && typeof condition.value === "number" && actual <= condition.value;
    case "in": {
      if (!Array.isArray(condition.value)) return false;
      // actual may be a scalar or an array; match if any element is contained.
      const values = condition.value;
      if (Array.isArray(actual)) return actual.some((a) => values.includes(a));
      return values.includes(actual);
    }
    case "not_in": {
      if (!Array.isArray(condition.value)) return false;
      const values = condition.value;
      if (Array.isArray(actual)) return !actual.some((a) => values.includes(a));
      return !values.includes(actual);
    }
    case "exists":
      return actual !== undefined && actual !== null;
    case "absent":
      return actual === undefined || actual === null;
    default:
      return false;
  }
}

/**
 * Apply a StateChange operation to a target record.
 * Returns the change record { from, to }.
 */
export function applyStateChange(
  target: Record<string, unknown>,
  field: string,
  op: string,
  value: unknown
): { from: unknown; to: unknown } {
  const { previous } = setByPath(target, field, value);
  const from = previous;
  let to: unknown;

  // For set, we already set the value.
  if (op === "set") {
    to = value;
  } else if (op === "increment") {
    const current = typeof previous === "number" ? previous : 0;
    const inc = typeof value === "number" ? value : 0;
    to = current + inc;
    setByPath(target, field, to);
  } else if (op === "append") {
    const arr = Array.isArray(previous) ? [...previous] : [];
    arr.push(value);
    to = arr;
    setByPath(target, field, to);
  } else if (op === "remove") {
    const arr = Array.isArray(previous) ? previous : [];
    const idx = arr.indexOf(value);
    to = idx >= 0 ? [...arr.slice(0, idx), ...arr.slice(idx + 1)] : arr;
    setByPath(target, field, to);
  } else {
    to = value;
  }

  return { from, to };
}

/**
 * Build a merged record from an actor's attributes + state + goals + drives + habits + constraints + capabilities + knowledge.
 * This is the entity record used for rule condition matching.
 */
export function buildActorRecord(actor: {
  attributes: Record<string, unknown>;
  state: Record<string, unknown>;
  goals: Record<string, string[]>;
  drives: string[];
  habits: string[];
  constraints: string[];
  capabilities: string[];
  knowledge: string[];
}): Record<string, unknown> {
  return {
    attributes: { ...actor.attributes },
    state: { ...actor.state },
    goals: flattenGoals(actor.goals),
    drives: [...actor.drives],
    habits: [...actor.habits],
    constraints: [...actor.constraints],
    capabilities: [...actor.capabilities],
    knowledge: [...actor.knowledge],
  };
}

function flattenGoals(goals: Record<string, string[]>): string[] {
  const result: string[] = [];
  for (const layer of Object.values(goals)) {
    for (const g of layer) result.push(g);
  }
  return result;
}

/**
 * Build a merged record for an environment.
 */
export function buildEnvironmentRecord(env: {
  attributes: Record<string, unknown>;
  state: Record<string, unknown>;
  resources: Record<string, unknown>;
  activeProcesses: string[];
  constraints: string[];
}): Record<string, unknown> {
  return {
    attributes: { ...env.attributes },
    state: { ...env.state },
    resources: { ...env.resources },
    activeProcesses: [...env.activeProcesses],
    constraints: [...env.constraints],
  };
}