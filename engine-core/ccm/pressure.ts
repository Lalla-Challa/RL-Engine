import type { World, EvaluatedCandidate, EntityRef } from "./types";
import { relationshipName } from "./rules";

/**
 * Causal Pressure Engine (CCM spec §11): computes how strongly the world is
 * currently trying to push each candidate event into existence. Sources of
 * pressure — actor goals, drives, habits, environment processes — add to the
 * multiplier; constraints (restraints) subtract from it.
 *
 * This is keyword-based and fully deterministic: it boosts candidates that
 * rhyme with the entity's active pressures and damps candidates its
 * constraints forbid. The Kaden example ("wants autonomy + morning running
 * habit + hill available + doctor prohibition") naturally produces a
 * high-pressure zone around running the hill.
 */
export function computePressure(
  world: World,
  entity: EntityRef,
  candidate: EvaluatedCandidate
): number {
  const entityName = candidate.entityName;
  const haystack = `${candidate.candidate.id} ${candidate.candidate.summary}`.toLowerCase();

  const pressureKeywords: string[] = [];
  const restraintKeywords: string[] = [];

  if (entity.kind === "actor") {
    const actor = world.actors.find((a) => a.name === entityName);
    if (actor) {
      for (const layer of Object.values(actor.goals)) pressureKeywords.push(...layer);
      pressureKeywords.push(...actor.drives, ...actor.habits, ...actor.plans);
      restraintKeywords.push(...actor.constraints);
      // Environment processes at the actor's current location press too.
      const loc = actor.state.location;
      if (typeof loc === "string") {
        const env = world.environments.find((e) => e.name === loc);
        if (env) pressureKeywords.push(...env.activeProcesses);
      }
    }
  } else if (entity.kind === "environment") {
    const env = world.environments.find((e) => e.name === entityName);
    if (env) {
      pressureKeywords.push(...env.activeProcesses);
      restraintKeywords.push(...env.constraints);
    }
  } else if (entity.kind === "relationship") {
    // Relationship bond states (trust, affection, resentment…) press on
    // relationship-scoped candidates; a fraught bond amplifies tension
    // candidates and damps warm ones.
    const rel = world.relationships.find((r) => relationshipName(world, r) === entityName);
    if (rel) {
      pressureKeywords.push(rel.familiarity, rel.trust, rel.affection, rel.dependence, rel.obligation, rel.respect, rel.knowledge);
      restraintKeywords.push(rel.resentment, rel.fear);
      pressureKeywords.push(...Object.values(rel.expectations).map(String));
      pressureKeywords.push(...rel.history);
    }
  }

  let positives = 0;
  for (const kw of pressureKeywords) {
    const k = String(kw).toLowerCase();
    if (k.length >= 3 && haystack.includes(k)) positives++;
  }
  let negatives = 0;
  for (const kw of restraintKeywords) {
    const k = String(kw).toLowerCase();
    if (k.length >= 3 && haystack.includes(k)) negatives++;
  }

  // 1.0 base; +0.22 per active pressure; −0.35 per restraint. Clamp 0.1..2.5.
  const multiplier = 1.0 + 0.22 * positives - 0.35 * negatives;
  return Math.max(0.1, Math.min(2.5, multiplier));
}
