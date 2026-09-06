/**
 * Observation compiler — spec §17 + §32
 * Validates observation sources against the state schema and sandboxed filter syntax.
 */

import type { ObservationSpaceDef } from "../core/types";

export type ObservationCompileError = { code: string; message: string };

export function compileObservationSpace(def: ObservationSpaceDef, stateFields: string[]): ObservationCompileError[] {
  const errors: ObservationCompileError[] = [];
  for (const f of def.fields ?? []) {
    if (!f.source) errors.push({ code: "invalid_observation", message: `observation ${f.field}: source required` });
    if (f.source && f.source !== "entities" && !stateFields.some((s) => f.source.startsWith(s) || s.startsWith(f.source))) {
      errors.push({ code: "unknown_source", message: `observation ${f.field}: source ${f.source} not in state schema` });
    }
    if (f.filter) {
      const valid = /^\s*[\w.:-]+\s*(==|!=|>=|<=|>|<|includes)\s*.+?\s*$/.test(f.filter);
      if (!valid) errors.push({ code: "invalid_filter", message: `observation ${f.field}: filter "${f.filter}" must be "<path> <op> <value>"` });
    }
  }
  return errors;
}
