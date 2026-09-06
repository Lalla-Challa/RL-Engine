/**
 * EnvironmentSpecification — declarative JSON per spec §9.
 * Example: { environment:{id,version}, state, entities, actions, rules, observations, rewards, constraints, termination }
 */

import type { EnvironmentSpecification } from "../core/types";

/** Spec-format versions this engine understands (§32 forward-compat). */
export const SUPPORTED_SPEC_VERSION = "1.0";

export function specId(spec: EnvironmentSpecification): string {
  return `${spec.environment.id}@${spec.environment.version}`;
}

export type SpecVersionCheck = {
  compatible: boolean;
  /** true when the document cannot be interpreted safely (newer major). */
  fatal: boolean;
  reason?: string;
};

/**
 * Compare a spec's declared `environment.specVersion` against
 * SUPPORTED_SPEC_VERSION. Same major → compatible; newer major → fatal
 * (the engine would misinterpret the document); older/missing/different
 * minor → compatible but flagged as a warning.
 */
export function checkSpecVersion(spec: EnvironmentSpecification): SpecVersionCheck {
  const declared = spec.environment.specVersion;
  if (!declared) return { compatible: true, fatal: false, reason: "no specVersion declared" };

  const parse = (v: string): [number, number] | null => {
    const m = /^(\d+)\.(\d+)$/.exec(v.trim());
    return m ? [Number(m[1]), Number(m[2])] : null;
  };
  const want = parse(SUPPORTED_SPEC_VERSION);
  const got = parse(declared);
  if (!want || !got) {
    return { compatible: false, fatal: true, reason: `malformed specVersion "${declared}" (expected e.g. "${SUPPORTED_SPEC_VERSION}")` };
  }
  if (got[0] > want[0]) {
    return { compatible: false, fatal: true, reason: `specVersion ${declared} is newer than the engine supports (${SUPPORTED_SPEC_VERSION})` };
  }
  if (got[0] < want[0] || got[1] !== want[1]) {
    return { compatible: true, fatal: false, reason: `specVersion ${declared} differs from engine default ${SUPPORTED_SPEC_VERSION}` };
  }
  return { compatible: true, fatal: false };
}
