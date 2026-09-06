/**
 * Trainer — spec §34–35 (thin interface, engine knows no algorithm).
 *
 * GAP-4 (Phase F, seam fix — rl/ layer, outside the hash-checked core set but
 * ledgered in domain-packs/core-manifest.json): the original seam was
 * `train(policy, episodes)`, which gave a trainer NO environment access —
 * §34's diagram has the Trainer orchestrating Environment ↔ Policy, so no
 * conceivable trainer could generate a transition. The seam now receives an
 * environment factory + episode context. The algorithm itself still lives
 * entirely in the trainer implementation.
 */

import type { Environment } from "../core/types";
import type { Policy } from "./policy";

export type EpisodeResult = {
  /** Absolute episode index across the whole training run. */
  episode: number;
  seed: number | string;
  steps: number;
  /** Undiscounted return (Σ rewards) for the episode. */
  return: number;
  epsilon: number;
};

export type TrainContext = {
  episodes: number;
  /** Episode i runs on seeds[i % seeds.length] — deterministic seed stream. */
  seeds: (number | string)[];
  /** Per-episode step cap (default 200). */
  maxSteps?: number;
  onEpisode?: (result: EpisodeResult) => void;
};

export type EnvironmentFactory = () => Environment;

export interface Trainer {
  train(envFactory: EnvironmentFactory, policy: Policy, ctx: TrainContext): Promise<void>;
}

export class NoopTrainer implements Trainer {
  async train(_envFactory: EnvironmentFactory, _policy: Policy, _ctx: TrainContext): Promise<void> {}
}
