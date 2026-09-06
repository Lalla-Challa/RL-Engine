/**
 * Persistence persister — spec §29
 * Run result → storage. Engine never touches persistence.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { TrajectoryStep } from "../episode/trajectory";

export function persistTrajectory(path: string, trajectory: TrajectoryStep[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(trajectory, null, 2), "utf-8");
}

export function persistSpec(path: string, spec: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(spec, null, 2), "utf-8");
}
