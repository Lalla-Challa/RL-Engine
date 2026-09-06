/**
 * Causal graph — spec §25 (generic, no domain assumptions)
 */

import type { EngineEvent } from "../core/types";
import type { Effect, Action } from "../core/types";

export function linkCauses(events: EngineEvent[], maxParents = 2): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  for (let i = 0; i < events.length; i++) {
    const parents: string[] = [];
    for (let j = i - 1; j >= 0 && parents.length < maxParents; j--) {
      const a = events[j];
      const b = events[i];
      const sharesSource = a.source === b.source;
      const sharesField = a.stateChanges.some((sc) => b.effects.some((e) => e.field === sc.field));
      if (sharesSource || sharesField) parents.push(a.id);
    }
    graph.set(events[i].id, parents);
  }
  return graph;
}

/**
 * Incremental causal linking (§25): attach the most plausible ancestors of a
 * fresh event. Deterministic newest→oldest scan; an earlier event causes this
 * one when it shares a mutated field with this event's effects/state changes,
 * or when it is the same kind of action. Max `maxParents` links.
 */
export function findCauses(
  prevEvents: EngineEvent[],
  evt: { source: string; action?: Action; stateChanges: { field: string }[]; effects?: Effect[] },
  maxParents = 2
): string[] {
  const causes: string[] = [];
  const myFields = new Set<string>([
    ...(evt.stateChanges ?? []).map((sc) => sc.field),
    ...(evt.effects ?? []).map((e) => e.field),
  ]);
  for (let i = prevEvents.length - 1; i >= 0 && causes.length < maxParents; i--) {
    const p = prevEvents[i];
    const sharesField = p.stateChanges.some((sc) => myFields.has(sc.field));
    const sameAction = evt.action !== undefined && p.action !== undefined && p.action.type === evt.action.type;
    if (sharesField || sameAction) causes.push(p.id);
  }
  return causes;
}

/** Longest ancestor chain (depth) in the causes DAG, memoized. */
export function maxChainDepth(events: EngineEvent[]): number {
  const byId = new Map(events.map((e) => [e.id, e]));
  const memo = new Map<string, number>();
  const depth = (id: string, seen: Set<string>): number => {
    if (memo.has(id)) return memo.get(id)!;
    if (seen.has(id)) return 0; // cycle guard (should not happen)
    seen.add(id);
    const evt = byId.get(id);
    const parents = evt?.causes ?? [];
    const d = parents.length === 0 ? 1 : 1 + Math.max(...parents.map((p) => depth(p, seen)));
    memo.set(id, d);
    return d;
  };
  let max = 0;
  for (const e of events) max = Math.max(max, depth(e.id, new Set()));
  return max;
}

/** Count of events with ≥ k parents (multi-parent convergence, §37). */
export function countMultiParent(events: EngineEvent[], k = 2): number {
  return events.filter((e) => (e.causes ?? []).length >= k).length;
}

/** Every edge (child ← parent) as "parentId->childId" strings. */
export function edgeSet(events: EngineEvent[]): Set<string> {
  const edges = new Set<string>();
  for (const e of events) for (const p of e.causes ?? []) edges.add(`${p}->${e.id}`);
  return edges;
}
