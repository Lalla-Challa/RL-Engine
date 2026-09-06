import type { World, EngineEvent, Episode, SceneSkeleton, ExtractionResult, RunResult } from "./types";
import { clockToMinutes, minutesToClock } from "./time";

/**
 * Story extractor (CCM spec §28–29). The simulation might generate hundreds of
 * events; the extractor asks: "What actually deserves to become narrative
 * material?" It evaluates causal load, narrative weight, character relevance,
 * relationship change, and unresolved consequences, then selects material and
 * groups it into Episodes, each of which is described by a neutral Scene
 * Skeleton (CCM spec §30–31).
 */

/** Events farther apart than this (world-minutes) start a new episode. */
const EPISODE_GAP_MINUTES = 360; // 6 hours

/**
 * Cluster the given events (already sorted by timestamp) into episodes.
 * A new episode opens when:
 *  - there is no prior episode, OR
 *  - the time gap to the last event in the prior episode > EPISODE_GAP_MINUTES, OR
 *  - no participant overlap AND no shared location with the prior event.
 */
function clusterEvents(events: EngineEvent[]): EngineEvent[][] {
  if (events.length === 0) return [];
  const sorted = [...events].sort((a, b) => a.timestamp - b.timestamp);
  const clusters: EngineEvent[][] = [[sorted[0]]];

  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    const lastCluster = clusters[clusters.length - 1];
    const gap = cur.timestamp - prev.timestamp;

    const sharesParticipant = cur.participants.some((p) => prev.participants.includes(p));
    const sharesLocation = cur.location !== null && cur.location === prev.location;

    if (gap > EPISODE_GAP_MINUTES || (!sharesParticipant && !sharesLocation)) {
      clusters.push([cur]);
    } else {
      lastCluster.push(cur);
    }
  }
  return clusters;
}

/** Determine if an event is "notable" for narrative purposes. */
function isNotable(event: EngineEvent): boolean {
  if (event.narrativeWeight === "medium" || event.narrativeWeight === "high") return true;
  if (event.causalLoad.class === "load_bearing") return true;
  if (event.stateChanges.some((sc) => sc.target.startsWith("relationship:"))) return true;
  if (event.stateChanges.some((sc) => sc.target.startsWith("actor:"))) return true;
  if (event.level === "event" && event.stateChanges.length > 0) return true;
  return false;
}

/** Summarize state changes from a set of events into readable continuity notes. */
function continuityFrom(events: EngineEvent[]): string[] {
  const notes: string[] = [];
  for (const event of events) {
    for (const sc of event.stateChanges) {
      notes.push(`${sc.target} ${sc.field} changed from ${JSON.stringify(sc.from)} to ${JSON.stringify(sc.to)}`);
    }
  }
  return notes;
}

/**
 * Extract episodes and scene skeletons from a simulation run.
 *
 * @param world  — the world *after* the run (current state).
 * @param runEvents — new events generated during this run.
 * @param startActorStates — actor attributes+state as they were before the run.
 */
export function extractStory(
  world: World,
  runEvents: EngineEvent[],
  startActorStates: RunResult["startActorStates"]
): ExtractionResult {
  const episodes: Episode[] = [];
  const skeletons: SceneSkeleton[] = [];

  if (runEvents.length === 0) return { episodes, skeletons };

  // Non-notable events still cluster; they just won't produce skeletons.
  const allEvents = runEvents.filter((e) => e.level === "event");
  const clusters = clusterEvents(allEvents);

  let episodeTempId = 0;
  const epId = (): number => --episodeTempId;

  for (const cluster of clusters) {
    if (cluster.length === 0) continue;

    const notableEvents = cluster.filter(isNotable);
    const firstEvent = cluster[0];
    const lastEvent = cluster[cluster.length - 1];

    // Episode title: highest-weight event summary (truncated), or location.
    const topEvent = [...cluster].sort((a, b) => {
      const w = { high: 3, medium: 2, low: 1 };
      return (w[b.narrativeWeight] ?? 0) - (w[a.narrativeWeight] ?? 0);
    })[0];
    const title = topEvent
      ? (topEvent.action.summary as string ?? topEvent.eventType).slice(0, 60)
      : firstEvent.location ?? "Untitled episode";

    const theme = topEvent?.narrativeWeight ?? "low";

    // Collect participant names from all events in the cluster.
    const participantSet = new Set<string>();
    for (const e of cluster) {
      for (const p of e.participants) participantSet.add(p);
    }
    const participants = Array.from(participantSet).filter((p) =>
      world.actors.some((a) => a.name === p)
    );

    const episode: Episode = {
      id: epId(),
      simulationId: world.simulationId,
      title,
      theme,
      description: `${cluster.length} events: ${cluster.map((e) => (e.action.summary as string) ?? e.eventType).join("; ")}`,
      eventIds: cluster.map((e) => e.id),
    };
    episodes.push(episode);

    // Only build a skeleton when there's notable narrative material.
    if (notableEvents.length === 0) continue;

    // Participants' entry state (from run-start snapshot, approximated).
    const entryState: Record<string, unknown> = {};
    const exitState: Record<string, unknown> = {};
    for (const name of participants) {
      const start = startActorStates[name];
      if (start) {
        entryState[name] = { attributes: start.attributes, state: { ...start.state } };
      }
      const actor = world.actors.find((a) => a.name === name);
      if (actor) {
        exitState[name] = { attributes: { ...actor.attributes }, state: { ...actor.state } };
      }
    }

    // Active pressures: drives and goals of participating actors.
    const activePressures: Record<string, unknown> = {};
    for (const name of participants) {
      const actor = world.actors.find((a) => a.name === name);
      if (actor) {
        const allGoals: string[] = [];
        for (const layer of Object.values(actor.goals)) allGoals.push(...layer);
        activePressures[name] = {
          drives: actor.drives,
          goals: allGoals,
          habits: actor.habits,
        };
      }
    }

    // Beats: summaries of notable events.
    const beats = notableEvents.map((e) => (e.action.summary as string) ?? e.eventType);

    // Turning point: the event with the highest weight.
    const turningPoint = topEvent ? (topEvent.action.summary as string) ?? null : null;

    // Unresolved threads: unsatisfied constraints involving these participants.
    const unresolvedThreads: string[] = [];
    for (const constraint of world.constraints) {
      if (constraint.satisfied) continue;
      const target = constraint.target;
      const targetActors = Array.isArray(target.actors) ? target.actors : [];
      if (targetActors.length === 0 || targetActors.some((a: string) => participants.includes(a))) {
        const deadline = constraint.deadline != null
          ? ` (deadline: ${constraint.deadline})`
          : "";
        unresolvedThreads.push(`${constraint.name}: ${constraint.description ?? ""}${deadline}`);
      }
    }

// Important information: high-weight event summaries.
	    const importantInformation = cluster
	      .filter((e) => e.narrativeWeight === "high")
	      .map((e) => (e.action.summary as string) ?? e.eventType);

	    // Resolved threads: constraints that are now satisfied, with a note.
	    const resolvedNotes: string[] = [];
	    for (const c of world.constraints) {
	      if (c.satisfied) {
	        resolvedNotes.push(`Constraint satisfied: ${c.name}${c.description ? ` — ${c.description}` : ""}`);
	      }
	    }

	    const skeleton: SceneSkeleton = {
      id: 0, // assigned by persister
      simulationId: world.simulationId,
      episodeId: episode.id,
      title,
      purpose: null,
      location: firstEvent.location,
      time: minutesToClock(firstEvent.timestamp),
      participants,
      entryState,
      activePressures,
      beats,
      turningPoint,
      exitState,
      unresolvedThreads,
      importantInformation,
      continuityNotes: [...continuityFrom(cluster), ...resolvedNotes],
    };
    skeletons.push(skeleton);
  }

  return { episodes, skeletons };
}