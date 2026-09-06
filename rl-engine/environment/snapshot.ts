/**
 * Engine snapshots (Phase E) — capture the full execution state of an episode
 * so it can be persisted (§29) and restored into a fresh process, continuing
 * seamlessly: state, step counter, rule cooldowns, RNG stream, terminal flags,
 * and the event log. Restore verifies both the specification identity and the
 * state hash, so a snapshot can never be replayed against the wrong world.
 */

import { createHash } from "node:crypto";

import type { EngineEvent, Environment } from "../core/types";
import { canonicalJson } from "../core/state";

export const SNAPSHOT_VERSION = 1;

/** An Environment with the Phase E checkpoint capability fully typed. */
export type SnapshottableEnvironment = Omit<Environment, "snapshot" | "restore"> & {
  snapshot(): EngineSnapshot;
  restore(snapshot: EngineSnapshot): void;
};

export type EngineSnapshot = {
  version: typeof SNAPSHOT_VERSION;
  /** Which specification this snapshot belongs to. */
  specId: string;
  specVersion: string;
  /** SHA-256 of the canonical spec JSON — restore refuses a different spec. */
  specHash: string;
  seed: number | string;
  stepCount: number;
  episodeIndex: number;
  terminated: boolean;
  truncated: boolean;
  /** Rule cooldown bookkeeping: ruleId → last fired tick. */
  lastFired: Record<string, number>;
  /** mulberry32 internal state — the stream resumes exactly. */
  rngState: number;
  state: Record<string, unknown>;
  /** SHA-256 of canonicalJson(state) at capture time. */
  stateHash: string;
  events: EngineEvent[];
};

export function sha256Canonical(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
