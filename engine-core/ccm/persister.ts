import type { World, RunResult, ExtractionResult, EngineEvent } from "./types";
import { getRawDb, getDb } from "../db";
import { eq } from "drizzle-orm";
import { ccmActors, ccmEnvironments, ccmRelationships, ccmEvents, ccmEventCauses, ccmEventQueue, ccmNarrativeConstraints } from "../../drizzle/schema";

/**
 * Persist a simulation run's delta back to the DB in ONE transaction:
 *  - new events + causal edges (temp negative ids → real ids)
 *  - mutated actor / environment / relationship state
 *  - load escalations on earlier (persisted) events
 *  - processed queue items
 *  - episodes + scene skeletons (from the extractor)
 *  - updated simulation clock
 */
export function persistRun(
  world: World,
  run: RunResult,
  extraction: ExtractionResult
): void {
  const raw = getRawDb();
  const db = getDb();
  if (!raw || !db) throw new Error("Database not available");

  const tx = raw.transaction(() => {
    // 1. Persist new events, remapping temp ids → real ids.
    const idMap = new Map<number, number>(); // temp id → real id
    for (const event of run.newEvents) {
      const insert = raw.prepare(`
        INSERT INTO ccm_events
          (simulationId, level, eventType, participants, location, timestamp,
           trigger, preconditions, action, transition, consequences,
           causalLoad, narrativeWeight, certainty, visibility, stateChanges)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const result = insert.run(
        world.simulationId,
        event.level,
        event.eventType,
        JSON.stringify(event.participants),
        event.location,
        event.timestamp,
        JSON.stringify(event.trigger),
        JSON.stringify(event.preconditions),
        JSON.stringify(event.action),
        JSON.stringify(event.transition),
        JSON.stringify(event.consequences),
        JSON.stringify(event.causalLoad),
        event.narrativeWeight,
        event.certainty,
        event.visibility,
        JSON.stringify(event.stateChanges)
      );
      idMap.set(event.id, Number(result.lastInsertRowid));
    }

    // 2. Causal edges (parents remapped; only persisted parents matter).
    for (const event of run.newEvents) {
      const realId = idMap.get(event.id);
      if (realId === undefined) continue;
      for (const parentTemp of event.parentEventIds) {
        const parentReal = parentTemp < 0 ? idMap.get(parentTemp) : parentTemp;
        if (parentReal === undefined || parentReal === realId) continue;
        raw
          .prepare("INSERT OR IGNORE INTO ccm_event_causes (eventId, parentEventId) VALUES (?, ?)")
          .run(realId, parentReal);
      }
    }

    // 3. Load escalations on earlier persisted events.
    for (const escalation of run.loadEscalations) {
      raw
        .prepare("UPDATE ccm_events SET causalLoad = ? WHERE id = ?")
        .run(JSON.stringify(escalation.newLoad), escalation.eventId);
    }

    // 4. Mutated actor state (attributes stay; state/goals/etc. may change).
    const actorUpdate = raw.prepare(`
      UPDATE ccm_actors
      SET state = ?, goals = ?, drives = ?, beliefs = ?, knowledge = ?,
          capabilities = ?, constraints = ?, resources = ?, habits = ?, plans = ?,
          updatedAt = ?
      WHERE id = ?
    `);
    for (const actor of world.actors) {
      actorUpdate.run(
        JSON.stringify(actor.state),
        JSON.stringify(actor.goals),
        JSON.stringify(actor.drives),
        JSON.stringify(actor.beliefs),
        JSON.stringify(actor.knowledge),
        JSON.stringify(actor.capabilities),
        JSON.stringify(actor.constraints),
        JSON.stringify(actor.resources),
        JSON.stringify(actor.habits),
        JSON.stringify(actor.plans),
        Math.floor(Date.now() / 1000),
        actor.id
      );
    }

    // 5. Mutated environment state.
    const envUpdate = raw.prepare(`
      UPDATE ccm_environments
      SET state = ?, resources = ?, inhabitants = ?, activeProcesses = ?, constraints = ?, updatedAt = ?
      WHERE id = ?
    `);
    for (const env of world.environments) {
      envUpdate.run(
        JSON.stringify(env.state),
        JSON.stringify(env.resources),
        JSON.stringify(env.inhabitants),
        JSON.stringify(env.activeProcesses),
        JSON.stringify(env.constraints),
        Math.floor(Date.now() / 1000),
        env.id
      );
    }

    // 6. Mutated relationships.
    const relUpdate = raw.prepare(`
      UPDATE ccm_relationships
      SET familiarity = ?, trust = ?, affection = ?, resentment = ?, dependence = ?,
          fear = ?, obligation = ?, respect = ?, knowledge = ?, expectations = ?, history = ?, updatedAt = ?
      WHERE id = ?
    `);
    for (const rel of world.relationships) {
      relUpdate.run(
        rel.familiarity,
        rel.trust,
        rel.affection,
        rel.resentment,
        rel.dependence,
        rel.fear,
        rel.obligation,
        rel.respect,
        rel.knowledge,
        JSON.stringify(rel.expectations),
        JSON.stringify(rel.history),
        Math.floor(Date.now() / 1000),
        rel.id
      );
    }

    // 7. Processed queue items.
    for (const item of world.queue) {
      if (item.status !== "pending") {
        raw.prepare("UPDATE ccm_event_queue SET status = ? WHERE id = ?").run(item.status, item.id);
      }
    }

    // 8. Episodes (event ids remapped) + skeletons.
    const episodeIdMap = new Map<number, number>();
    for (const episode of extraction.episodes) {
      const eventIds = episode.eventIds.map((id) => idMap.get(id) ?? id).filter((id) => id > 0);
      if (eventIds.length === 0) continue;
      const result = raw
        .prepare("INSERT INTO ccm_episodes (simulationId, title, theme, description, eventIds) VALUES (?, ?, ?, ?, ?)")
        .run(world.simulationId, episode.title, episode.theme, episode.description, JSON.stringify(eventIds));
      episodeIdMap.set(episode.id, Number(result.lastInsertRowid));
    }
    for (const skeleton of extraction.skeletons) {
      const episodeId = skeleton.episodeId < 0 ? episodeIdMap.get(skeleton.episodeId) : skeleton.episodeId;
      raw
        .prepare(`
          INSERT INTO ccm_scene_skeletons
            (simulationId, episodeId, title, purpose, location, time, participants,
             entryState, activePressures, beats, turningPoint, exitState,
             unresolvedThreads, importantInformation, continuityNotes, rendered)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
        `)
        .run(
          world.simulationId,
          episodeId ?? null,
          skeleton.title,
          skeleton.purpose,
          skeleton.location,
          JSON.stringify(skeleton.time),
          JSON.stringify(skeleton.participants),
          JSON.stringify(skeleton.entryState),
          JSON.stringify(skeleton.activePressures),
          JSON.stringify(skeleton.beats),
          skeleton.turningPoint ? JSON.stringify(skeleton.turningPoint) : null,
          JSON.stringify(skeleton.exitState),
          JSON.stringify(skeleton.unresolvedThreads),
          JSON.stringify(skeleton.importantInformation),
          JSON.stringify(skeleton.continuityNotes)
        );
    }

    // 9. Simulation clock + status.
    raw
      .prepare("UPDATE ccm_simulations SET clock = ?, updatedAt = ? WHERE id = ?")
      .run(JSON.stringify(run.finalClock), Math.floor(Date.now() / 1000), world.simulationId);

    // 10. Constraint satisfaction flags (the planner sets these per tick).
    for (const constraint of world.constraints) {
      db.update(ccmNarrativeConstraints)
        .set({
          satisfied: constraint.satisfied,
          satisfiedAt: constraint.satisfied && constraint.satisfiedAt != null
            ? new Date(constraint.satisfiedAt * 1000)
            : null,
          updatedAt: new Date(),
        })
        .where(eq(ccmNarrativeConstraints.id, constraint.id))
        .run();
    }
  });

  tx();
}

/** Clear a simulation's generated history (events, causes, queue, episodes, skeletons, snapshots). */
export function resetSimulationHistory(simulationId: number): void {
  const raw = getRawDb();
  if (!raw) return;
  const tx = raw.transaction(() => {
    raw.prepare("DELETE FROM ccm_event_causes WHERE eventId IN (SELECT id FROM ccm_events WHERE simulationId = ?)").run(simulationId);
    raw.prepare("DELETE FROM ccm_events WHERE simulationId = ?").run(simulationId);
    raw.prepare("DELETE FROM ccm_event_queue WHERE simulationId = ?").run(simulationId);
    raw.prepare("DELETE FROM ccm_scene_skeletons WHERE simulationId = ?").run(simulationId);
    raw.prepare("DELETE FROM ccm_episodes WHERE simulationId = ?").run(simulationId);
    raw.prepare("DELETE FROM ccm_snapshots WHERE simulationId = ?").run(simulationId);
    raw.prepare("UPDATE ccm_simulations SET clock = ?, status = 'idle', updatedAt = ? WHERE id = ?")
      .run(JSON.stringify({ day: 0, minute: 360 }), Math.floor(Date.now() / 1000), simulationId);
  });
  tx();
}