/**
 * Persistence adapter interface (§29) — Phase E.
 *
 * The kernel never touches storage (§29): it produces `EngineSnapshot`s and
 * trajectories; an adapter decides where they live. Adapters are synchronous
 * by design (better-sqlite3 and fs are both synchronous; no I/O concurrency
 * inside the engine boundary).
 */

import type { EnvironmentSpecification } from "../core/types";
import type { EngineSnapshot } from "../environment/snapshot";
import type { TrajectoryStep } from "../episode/trajectory";

export type SnapshotMeta = {
  stepCount: number;
  stateHash: string;
  specId: string;
  savedAt: string;
};

export interface PersistenceAdapter {
  readonly name: string;

  saveSpec(spec: EnvironmentSpecification): void;
  loadSpec(id: string, version?: string): EnvironmentSpecification | null;

  saveTrajectory(id: string, steps: TrajectoryStep[]): void;
  loadTrajectory(id: string): TrajectoryStep[] | null;

  saveSnapshot(id: string, snapshot: EngineSnapshot): void;
  loadSnapshot(id: string): EngineSnapshot | null;
  listSnapshots(id: string): SnapshotMeta[];

  /** Phase F: opaque JSON artifacts (trainer checkpoints, metrics, …). */
  saveArtifact(id: string, artifact: unknown): void;
  loadArtifact(id: string): unknown | null;

  close?(): void;
}
