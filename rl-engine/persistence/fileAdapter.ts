/**
 * File-based persistence adapter (§29) — directory tree of JSON documents.
 * Layout: <root>/specs/<id>.json · <root>/trajectories/<id>.json ·
 *         <root>/snapshots/<id>/<stepCount>-<hash8>.json
 */

import fs from "node:fs";
import path from "node:path";

import type { EnvironmentSpecification } from "../core/types";
import type { EngineSnapshot } from "../environment/snapshot";
import type { TrajectoryStep } from "../episode/trajectory";
import type { PersistenceAdapter, SnapshotMeta } from "./adapter";

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as T;
  } catch {
    return null;
  }
}

export class FilePersistenceAdapter implements PersistenceAdapter {
  readonly name = "file";

  constructor(private readonly root: string) {
    for (const d of ["specs", "trajectories", "snapshots", "artifacts"]) {
      fs.mkdirSync(path.join(root, d), { recursive: true });
    }
  }

  private specFile(id: string): string {
    return path.join(this.root, "specs", `${id.replace(/[^a-z0-9-_.]/gi, "_")}.json`);
  }
  private trajFile(id: string): string {
    return path.join(this.root, "trajectories", `${id.replace(/[^a-z0-9-_.]/gi, "_")}.json`);
  }
  private snapshotDir(id: string): string {
    return path.join(this.root, "snapshots", id.replace(/[^a-z0-9-_.]/gi, "_"));
  }

  saveSpec(spec: EnvironmentSpecification): void {
    fs.writeFileSync(this.specFile(spec.environment.id), JSON.stringify(spec, null, 2), "utf-8");
  }
  loadSpec(id: string, _version?: string): EnvironmentSpecification | null {
    return readJson<EnvironmentSpecification>(this.specFile(id));
  }

  saveTrajectory(id: string, steps: TrajectoryStep[]): void {
    fs.writeFileSync(this.trajFile(id), JSON.stringify(steps, null, 2), "utf-8");
  }
  loadTrajectory(id: string): TrajectoryStep[] | null {
    return readJson<TrajectoryStep[]>(this.trajFile(id));
  }

  saveSnapshot(id: string, snapshot: EngineSnapshot): void {
    const dir = this.snapshotDir(id);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${snapshot.stepCount}-${snapshot.stateHash.slice(0, 8)}.json`);
    fs.writeFileSync(file, JSON.stringify(snapshot, null, 2), "utf-8");
  }
  loadSnapshot(id: string): EngineSnapshot | null {
    const dir = this.snapshotDir(id);
    if (!fs.existsSync(dir)) return null;
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
    if (files.length === 0) return null;
    return readJson<EngineSnapshot>(path.join(dir, files[files.length - 1]));
  }
  listSnapshots(id: string): SnapshotMeta[] {
    const dir = this.snapshotDir(id);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((f) => {
      const snap = readJson<EngineSnapshot>(path.join(dir, f))!;
      return { stepCount: snap.stepCount, stateHash: snap.stateHash, specId: snap.specId, savedAt: fs.statSync(path.join(dir, f)).mtime.toISOString() };
    });
  }

  saveArtifact(id: string, artifact: unknown): void {
    const file = path.join(this.root, "artifacts", `${id.replace(/[^a-z0-9-_.]/gi, "_")}.json`);
    fs.writeFileSync(file, JSON.stringify(artifact, null, 2), "utf-8");
  }
  loadArtifact(id: string): unknown | null {
    return readJson(path.join(this.root, "artifacts", `${id.replace(/[^a-z0-9-_.]/gi, "_")}.json`));
  }
}
