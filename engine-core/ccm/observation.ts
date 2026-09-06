/**
 * Observation & information transfer (CCE v1.1 §13).
 *
 * The engine's events already carry a `visibility` label ("private" when no
 * other actor is present, "observed" when another actor shares the location,
 * "public" for queue/town-crier events). This module is the missing link that
 * turns that label into a symbolic information flow:
 *
 *   Actor A acts → event at location L → Actor B at L observes
 *   → B's knowledge gains the event → B's available actions change
 *
 * World truth stays separate from actor knowledge: observers learn *that*
 * something happened and its summary, not hidden world details. Knowledge is
 * written deterministically (fixed actor iteration order, dedup), so the
 * simulation remains reproducible.
 */

import type { World, EngineEvent } from "./types";

/** Max knowledge entries per actor — bounded so long runs stay lean. */
const MAX_KNOWLEDGE_PER_ACTOR = 60;

/**
 * Apply observation effects for one tick's new events.
 *
 * - `observed`: every actor at `event.location` who is NOT a participant
 *   gains `event.eventType` + summary into `knowledge` and `beliefs.known`.
 * - `public`: all actors gain it (rumor / town crier / system notice).
 * - `private`: nobody learns anything.
 *
 * Deterministic: iterates `world.actors` in loader order, appends deduped.
 */
export function applyObservation(world: World, newEvents: EngineEvent[]): void {
  for (const event of newEvents) {
    if (event.visibility === "private") continue;
    if (!event.eventType) continue;

    const knowledge = event.eventType;
    const summary = typeof event.action?.summary === "string" ? event.action.summary : null;
    const participantSet = new Set(event.participants);

    for (const actor of world.actors) {
      if (participantSet.has(actor.name)) continue; // doers already know
      if (event.visibility === "observed") {
        if (!event.location) continue;
        if (actor.state.location !== event.location) continue;
      }
      addKnowledge(actor, knowledge);
      if (summary) addKnowledge(actor, summary);
    }
  }
}

function addKnowledge(actor: { knowledge: string[]; beliefs: { known: string[] } }, entry: string): void {
  if (!entry || entry.length === 0) return;
  if (!actor.knowledge.includes(entry)) {
    actor.knowledge.push(entry);
    if (actor.knowledge.length > MAX_KNOWLEDGE_PER_ACTOR) {
      actor.knowledge.splice(0, actor.knowledge.length - MAX_KNOWLEDGE_PER_ACTOR);
    }
  }
  if (actor.beliefs && Array.isArray(actor.beliefs.known) && !actor.beliefs.known.includes(entry)) {
    actor.beliefs.known.push(entry);
  }
}
