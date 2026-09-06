import type { World, EngineEvent, CcmCausalLoad } from "./types";

/**
 * Causality (CCM spec §13, §15, §21).
 *
 * `linkCausalParents` attaches the most plausible ancestors to a fresh event
 * so the causal graph can be queried ("why did this happen?"). `applyDeferredLoad`
 * implements deferred causal load (CCM spec §21, "Dynamic Causal Load"): when a
 * later event becomes dependent on an earlier one, the earlier event's load
 * escalates — importance can emerge instead of being known at creation time.
 *
 * Threshold note (implementation choice, not verbatim in CCM.md): the doc says
 * an event "acquires greater Causal Load when later Events become dependent
 * upon it" without specifying a weight cutoff. We escalate only when the
 * DEPENDENT (later) event is itself significant — i.e. not low narrative
 * weight, or already load-bearing — so that an early connective event that is
 * merely referenced by trivial connective events does not get promoted on
 * every tick. Medium-weight dependencies DO promote their parents.
 */

const MAX_PARENTS = 2;

/**
 * Find up to `MAX_PARENTS` prior events that plausibly caused `event`.
 * Heuristic (deterministic): prefer events sharing a participant, then
 * events at the same location, then events that touched a field this event's
 * rule conditions read, then — for knowledge-gated actions (CCE v1.1 §13) —
 * the event whose type/summary satisfied the actor's knowledge requirement
 * (i.e. the event the actor observed). Iterates newest → oldest.
 */
export function linkCausalParents(
  world: World,
  event: EngineEvent,
  conditionFields: string[],
  knowledgeKey?: string
): number[] {
  const parents: number[] = [];
  for (let i = world.events.length - 1; i >= 0 && parents.length < MAX_PARENTS; i--) {
    const prior = world.events[i];
    if (prior.id === event.id) continue;
    if (prior.timestamp > event.timestamp) continue;

    const sharesParticipant = prior.participants.some((p) => event.participants.includes(p));
    const sharesLocation = prior.location !== null && prior.location === event.location;
    const sharesField =
      conditionFields.length > 0 &&
      prior.stateChanges.some((sc) => conditionFields.includes(sc.field));
    const isObservedSource =
      knowledgeKey != null &&
      (prior.eventType === knowledgeKey || String(prior.action?.summary ?? "") === knowledgeKey);

    if (sharesParticipant || sharesLocation || sharesField || isObservedSource) {
      parents.push(prior.id);
    }
  }
  return parents;
}

const MAGNITUDE_ORDER: CcmCausalLoad["magnitude"][] = [
  "none",
  "low",
  "moderate",
  "high",
  "critical",
];

function escalateLoad(load: CcmCausalLoad): CcmCausalLoad {
  if (load.class !== "connective") {
    // Already load-bearing: bump magnitude, capped at critical.
    const idx = MAGNITUDE_ORDER.indexOf(load.magnitude);
    return {
      class: "load_bearing",
      magnitude: idx < MAGNITUDE_ORDER.length - 1 ? MAGNITUDE_ORDER[idx + 1] : "critical",
    };
  }
  return { class: "load_bearing", magnitude: "low" };
}

/**
 * Deferred causal load (CCM spec §16). After a run, any new event that is
 * narratively significant promotes its parents to load-bearing. Returns
 * escalations for events that are already persisted (positive ids) so the
 * persister can UPDATE them; negative ids refer to same-run events that are
 * mutated in place.
 */
export function applyDeferredLoad(
  world: World,
  newEvents: EngineEvent[]
): { eventId: number; newLoad: CcmCausalLoad }[] {
  const escalations: { eventId: number; newLoad: CcmCausalLoad }[] = [];
  const byId = new Map(world.events.map((e) => [e.id, e]));

  for (const event of newEvents) {
    const significant =
      event.narrativeWeight !== "low" || event.causalLoad.class === "load_bearing";
    if (!significant) continue;

    for (const parentId of event.parentEventIds) {
      const parent = byId.get(parentId);
      if (!parent) continue;
      const newLoad = escalateLoad(parent.causalLoad);
      if (newLoad.class !== parent.causalLoad.class || newLoad.magnitude !== parent.causalLoad.magnitude) {
        parent.causalLoad = newLoad;
        if (parentId > 0) {
          escalations.push({ eventId: parentId, newLoad });
        }
      }
    }
  }
  return escalations;
}
