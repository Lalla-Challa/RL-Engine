import type { World, EvaluatedCandidate, StateChange, NarrativeConstraint } from "./types";
import { resolveStateChangeTarget, stateChangesOf } from "./rules";
import { getByPath } from "./state";
import { getSectionById } from "./guidance";

export type AdvisoryFlag = {
  type: "semantic_contradiction";
  score: number;
  textA: string;
  textB: string;
};

export type ValidationResult = {
  ok: boolean;
  /** Which of the 6 layers rejected it (1-6), when !ok. */
  layer?: number;
  reason?: string;
  /**
   * Advisory (NON-gating) flags surfaced alongside the symbolic verdict.
   * Never affects `ok` / `layer` — it's a suggestion only, for UI/LLM display.
   */
  advisoryFlags?: AdvisoryFlag[];
  /** Read-only CCM explanation for a rejection; never affects the verdict. */
  guidance?: ValidationGuidance;
};

export type ValidationGuidance = {
  sectionId: string;
  title: string;
  content: string;
};

/** Hand-mapped CCM guidance for validation layers; never inferred from error text. */
export const VALIDATION_GUIDANCE_SECTION_IDS = {
  non_contradiction: "non-contradiction-check",
  system_legality: "system-rules",
  actor_legality: "actor-agency",
  knowledge_legality: "actor-knowledge",
  state_compatibility: "world-state",
  consequence_validity: "event-structure",
  causal_independence: "causal-independence",
} as const;

const layerNames: Record<number, keyof typeof VALIDATION_GUIDANCE_SECTION_IDS> = {
  1: "non_contradiction",
  2: "system_legality",
  3: "actor_legality",
  4: "knowledge_legality",
  5: "state_compatibility",
  6: "consequence_validity",
};

const REJECTION_GUIDANCE_MAX_CHARACTERS = 1600;

export function getValidationGuidance(layer: number): ValidationGuidance | undefined {
  const layerName = layerNames[layer];
  if (!layerName) return undefined;
  const sectionId = VALIDATION_GUIDANCE_SECTION_IDS[layerName];
  const section = getSectionById(sectionId);
  if (!section) return undefined;
  return {
    sectionId,
    title: section.title,
    content: section.content.slice(0, REJECTION_GUIDANCE_MAX_CHARACTERS),
  };
}

function rejected(layer: number, reason: string): ValidationResult {
  return { ok: false, layer, reason, guidance: getValidationGuidance(layer) };
}

/**
 * Collect pairs of free-text (old vs new) values from a candidate's state
 * changes where both sides are non-empty strings and differ. Pure/read-only.
 */
function collectTextPairs(world: World, candidate: EvaluatedCandidate): { textA: string; textB: string }[] {
  const entityName = candidate.entityName;
  const pairs: { textA: string; textB: string }[] = [];
  for (const change of stateChangesOf(candidate)) {
    const resolved = resolveStateChangeTarget(world, change.target, entityName);
    if (!resolved) continue;
    const current = getByPath(resolved.obj, change.field);
    const proposed = change.value;
    if (typeof current !== "string" || typeof proposed !== "string") continue;
    const a = current.trim();
    const b = proposed.trim();
    if (a.length > 0 && b.length > 0 && a !== b) pairs.push({ textA: a, textB: b });
  }
  return pairs;
}

/**
 * Populate `result.advisoryFlags` by running the CPU NLI model over any
 * relevant free-text pairs (old vs proposed) in the candidate. Advisory only:
 * never throws, never changes pass/fail, and it is never called by the
 * deterministic simulator — the semantics module is loaded lazily here so
 * simulator.ts's module graph stays free of it.
 */
export async function attachSemanticAdvisory(
  result: { advisoryFlags?: AdvisoryFlag[] },
  world: World,
  candidate: EvaluatedCandidate
): Promise<void> {
  const pairs = collectTextPairs(world, candidate);
  if (pairs.length === 0) return;
  let checkContradiction: (a: string, b: string) => Promise<{ label: "contradiction" | "entailment" | "neutral"; score: number }>;
  try {
    const mod = await import("./semantics");
    checkContradiction = mod.checkContradiction;
  } catch {
    return; // model unavailable → advisory is skipped, never blocks
  }
  const flags: AdvisoryFlag[] = [];
  for (const { textA, textB } of pairs) {
    try {
      const verdict = await checkContradiction(textA, textB);
      if (verdict.label === "contradiction") {
        flags.push({ type: "semantic_contradiction", score: verdict.score, textA, textB });
      }
    } catch {
      // advisory only — a single failed inference never breaks the verdict
    }
  }
  if (flags.length > 0) result.advisoryFlags = flags;
}

/**
 * Validation Engine (CCM spec §18) — the physics/logic firewall. Six layers:
 *  1. Non-contradiction   — does it violate known facts / forbidden constraints?
 *  2. System legality     — do the Systems allow it? (targets must resolve)
 *  3. Actor legality      — can the Actor do this? (capability + restraint)
 *  4. Knowledge legality  — would the Actor know enough to choose it?
 *  5. State compatibility — is it compatible with current state?
 *  6. Consequence validity— can the resulting state actually exist?
 */
export function validateCandidate(
  world: World,
  candidate: EvaluatedCandidate
): ValidationResult {
  const entityName = candidate.entityName;
  const actor = world.actors.find((a) => a.name === entityName);
  const changes = stateChangesOf(candidate);

  // Layer 4 first (cheap): knowledge legality for actor-scoped candidates.
  if (actor && candidate.candidate.requiresKnowledge) {
    if (!actor.knowledge.includes(candidate.candidate.requiresKnowledge)) {
      return rejected(4, `${entityName} doesn't know "${candidate.candidate.requiresKnowledge}"`);
    }
  }

  // Layer 3: actor legality — capability + personal restraints.
  if (actor && candidate.candidate.requiresCapability) {
    if (!actor.capabilities.includes(candidate.candidate.requiresCapability)) {
      return rejected(3, `${entityName} is not capable of "${candidate.candidate.requiresCapability}"`);
    }
  }
  if (actor && actor.constraints.length > 0) {
    const haystack = `${candidate.candidate.id} ${candidate.candidate.summary}`.toLowerCase();
    for (const restraint of actor.constraints) {
      const r = String(restraint).toLowerCase();
      if (r.length >= 3 && haystack.includes(r)) {
        return rejected(3, `${entityName} is restrained by "${restraint}"`);
      }
    }
  }

  // Layer 2: system legality — every state-change target must resolve.
  for (const change of changes) {
    if (!resolveStateChangeTarget(world, change.target, entityName)) {
      return rejected(2, `target "${change.target}" does not exist in the world`);
    }
  }

  // Layer 5: state compatibility — conditions were evaluated against the live
  // world state during generation (same tick, no interleaving writes), so a
  // re-check here is a no-op; the guarantee comes from generation ordering.

  // Layer 6: consequence validity — resulting values must be sane.
  for (const change of changes) {
    const validity = checkConsequenceValidity(world, change, entityName);
    if (!validity.ok) return rejected(6, validity.reason ?? "invalid consequence");
  }

  // Layer 1: non-contradiction — forbidden/range narrative constraints.
  for (const constraint of world.constraints) {
    if (constraint.satisfied) continue;
    const clash = checkConstraintClash(constraint, candidate, entityName);
    if (clash) {
      return rejected(1, `violates narrative constraint "${constraint.name}": ${clash}`);
    }
  }

  return { ok: true };
}

function checkConsequenceValidity(
  world: World,
  change: StateChange,
  entityName: string
): { ok: boolean; reason?: string } {
  const resolved = resolveStateChangeTarget(world, change.target, entityName);
  if (!resolved) return { ok: true }; // layer 2 already handled
  const obj = resolved.obj;

  const current = getPath(obj, change.field);
  if (change.op === "increment" && current !== undefined && typeof current !== "number") {
    return { ok: false, reason: `cannot increment non-numeric "${change.field}"` };
  }
  if (change.op === "append" && current !== undefined && !Array.isArray(current)) {
    return { ok: false, reason: `cannot append to non-array "${change.field}"` };
  }
  if (change.op === "set" && change.value === undefined) {
    return { ok: false, reason: `set on "${change.field}" has no value` };
  }
  return { ok: true };
}

function constraintTargetsEntity(targetActors: unknown[], entityName: string): boolean {
  if (targetActors.length === 0) return true; // global constraint applies to all
  if (targetActors.includes(entityName)) return true;
  // Relationship-scoped candidates use "ActorA:ActorB" as the entity name;
  // a constraint on either actor still gates the bond's events.
  if (entityName.includes(":")) {
    const [a, b] = entityName.split(":");
    if (targetActors.includes(a) || targetActors.includes(b)) return true;
  }
  return false;
}

function checkConstraintClash(
  constraint: NarrativeConstraint,
  candidate: EvaluatedCandidate,
  entityName: string
): string | null {
  if (constraint.class === "forbidden") {
    const target = constraint.target;
    const targetActors = Array.isArray(target.actors) ? target.actors : [];
    const involvesEntity = constraintTargetsEntity(targetActors, entityName);
    if (!involvesEntity) return null;
    const haystack = `${candidate.candidate.id} ${candidate.candidate.summary}`.toLowerCase();
    const forbiddenList = Array.isArray(target.forbidden) ? (target.forbidden as unknown[]) : [];
    for (const forbidden of forbiddenList) {
      const f = String(forbidden).toLowerCase();
      if (f.length >= 3 && haystack.includes(f)) return `forbidden: ${f}`;
    }
    // Also check state changes: setting a field the constraint names.
    for (const change of stateChangesOf(candidate)) {
      const field = change.field.toLowerCase();
      if (field.includes("relationship") || field.includes("status")) {
        const forbiddenField = String(target.field ?? "").toLowerCase();
        if (forbiddenField && field.includes(forbiddenField)) return `forbidden field: ${forbiddenField}`;
      }
    }
  }
  if (constraint.class === "range") {
    const target = constraint.target;
    const targetActors = Array.isArray(target.actors) ? target.actors : [];
    const involvesEntity = constraintTargetsEntity(targetActors, entityName);
    if (!involvesEntity) return null;
    const field = String(target.field ?? "");
    const min = target.min;
    const max = target.max;
    if (!field) return null;
    for (const change of stateChangesOf(candidate)) {
      if (change.field !== field) continue;
      const value = change.value;
      if (typeof value === "number") {
        if (typeof min === "number" && value < min) return `range min ${min}`;
        if (typeof max === "number" && value > max) return `range max ${max}`;
      }
    }
  }
  return null;
}

function getPath(obj: Record<string, unknown>, path: string): unknown {
  let current: unknown = obj;
  for (const part of path.split(".")) {
    if (current === null || current === undefined || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}
