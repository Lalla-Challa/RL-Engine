/**
 * Reference trainer (Phase F) — tabular Q-learning.
 *
 * The single inspectable RL algorithm permitted by the Phase F charter. It
 * sits entirely behind the §34–35 seams: the engine (`core/`) never knows
 * Q-learning exists — the trainer consumes the generic `Environment` API
 * (reset/step/observation) and drives a `Policy`. Chosen over REINFORCE
 * because it is tabular, exact, and fully replayable offline.
 *
 * Pieces:
 *   - makeDiscretizer: generic numeric-observation bucketing → state key
 *   - discreteActionCatalog: generic discrete-action extraction from a spec
 *   - TabularQPolicy: ε-greedy `Policy` over a Q table (seeded RNG, exact
 *     checkpoint via internal state capture)
 *   - QLearningTrainer: online Q updates + prioritized replay (Phase E/F
 *     ReplayBuffer), with a checkpoint() covering Q table, epsilon schedule
 *     position, buffer (incl. sampling RNG), and episode counter
 */

import { createRandomService } from "../core/randomness";
import type { RandomService } from "../core/randomness";
import { canonicalJson } from "../core/state";
import type { Action, EnvironmentSpecification, Observation, StepResult } from "../core/types";
import { ReplayBuffer, type ReplayBufferJSON } from "./replayBuffer";
import type { EnvironmentFactory, TrainContext, Trainer } from "./trainer";
import type { Policy } from "./policy";

// ── generic helpers (domain-agnostic) ────────────────────────────────────────

/** Extract the discrete action envelope from a spec's action space (§5). */
export function discreteActionCatalog(actions: EnvironmentSpecification["actions"]): Action[] {
  const out: Action[] = [];
  for (const a of actions ?? []) {
    if (a.kind === "discrete") {
      for (const t of a.actions) out.push({ type: t });
    }
  }
  return out;
}

export type DiscretizerField = { name: string; buckets: number; min?: number; max?: number };
export type DiscretizerConfig = { fields: DiscretizerField[] };

/** Generic numeric/boolean observation bucketing → deterministic state key. */
export function makeDiscretizer(cfg: DiscretizerConfig): (obs: Observation) => string {
  return (obs: Observation): string => {
    const parts: string[] = [];
    for (const f of cfg.fields) {
      const raw = (obs as Record<string, unknown>)[f.name];
      let idx: number;
      if (typeof raw === "number" && Number.isFinite(raw)) {
        const min = f.min ?? 0;
        const max = f.max ?? Math.max(min + 1, f.buckets - 1);
        const clamped = Math.min(max, Math.max(min, raw));
        idx = Math.min(f.buckets - 1, Math.floor(((clamped - min) / (max - min + 1e-9)) * f.buckets));
      } else if (typeof raw === "boolean") {
        idx = raw ? 1 : 0;
      } else {
        idx = 0;
      }
      parts.push(`${f.name}:${idx}`);
    }
    return parts.join("|");
  };
}

// ── Tabular Q policy ─────────────────────────────────────────────────────────

export type TabularQCheckpoint = {
  q: [string, number[]][];
  epsilon: number;
  rngState: number;
};

export class TabularQPolicy implements Policy {
  private q = new Map<string, number[]>();
  private rng: RandomService;
  epsilon: number;
  /** Public so the trainer can key transitions without reaching into privates. */
  readonly discretize: (obs: Observation) => string;
  readonly actions: Action[];

  constructor(
    actions: Action[],
    discretize: (obs: Observation) => string,
    seed: number | string = 7,
    epsilon = 0.1
  ) {
    this.actions = actions.map((a) => ({ ...a }));
    this.discretize = discretize;
    this.rng = createRandomService(seed);
    this.epsilon = epsilon;
  }

  private qRow(key: string): number[] {
    let row = this.q.get(key);
    if (!row) {
      row = new Array(this.actions.length).fill(0);
      this.q.set(key, row);
    }
    return row;
  }

  getQ(key: string): number[] {
    return this.qRow(key);
  }

  /** Deterministic argmax with lowest-index tie-break (replayable). */
  greedyIndex(key: string): number {
    const row = this.qRow(key);
    let best = 0;
    for (let i = 1; i < row.length; i++) {
      if (row[i] > row[best]) best = i;
    }
    return best;
  }

  greedyAct(obs: Observation): Action {
    return this.actions[this.greedyIndex(this.discretize(obs))];
  }

  /** ε-greedy selection returning both the envelope and the action index. */
  select(obs: Observation): { action: Action; index: number } {
    if (this.rng.nextFloat() < this.epsilon) {
      const index = Math.floor(this.rng.nextFloat() * this.actions.length);
      return { action: this.actions[index], index };
    }
    const index = this.greedyIndex(this.discretize(obs));
    return { action: this.actions[index], index };
  }

  act(obs: Observation): Action {
    return this.select(obs).action;
  }

  update(_batch: unknown): void {
    // The trainer drives Q updates directly; the Policy seam stays passive.
  }

  checkpoint(): TabularQCheckpoint {
    return { q: [...this.q.entries()].map(([k, v]) => [k, [...v]]), epsilon: this.epsilon, rngState: this.rng.snapshotState() };
  }

  restore(c: TabularQCheckpoint): void {
    this.q = new Map(c.q.map(([k, v]) => [k, [...v]]));
    this.epsilon = c.epsilon;
    this.rng.restoreState(c.rngState);
  }

  save(path: string): void {
    fsWrite(path, JSON.stringify(this.checkpoint(), null, 2));
  }
  load(path: string): void {
    this.restore(JSON.parse(fsRead(path)) as TabularQCheckpoint);
  }

  canonical(): string {
    return canonicalJson(this.checkpoint());
  }
}

// fs helpers kept local so this module stays dependency-light
import { readFileSync, writeFileSync } from "node:fs";
function fsWrite(p: string, data: string): void {
  writeFileSync(p, data, "utf-8");
}
function fsRead(p: string): string {
  return readFileSync(p, "utf-8");
}

// ── Q-learning trainer ───────────────────────────────────────────────────────

export type QLearningConfig = {
  alpha?: number;                 // initial learning rate (default 0.5)
  gamma?: number;                 // discount (default 0.99)
  epsilonStart?: number;          // default 1.0
  epsilonEnd?: number;            // default 0.05
  epsilonDecayEpisodes?: number;  // linear decay span (default 150)
  replayBatch?: number;           // default 16
  replayAlpha?: number;           // replay learning-rate multiplier (default 0.5)
  bufferCapacity?: number;        // default 20000
  /** |TD error| is clipped to this before becoming a priority (default 1.0).
   *  Without clipping, high-value environments (V ≈ 1000) let terminal
   *  transitions dominate sampling forever and destabilize the Q table. */
  priorityClip?: number;          // default 1.0
  seed?: number | string;         // buffer sampling RNG seed (default 7)
};

export type QLearningCheckpoint = {
  episodesDone: number;
  policy: TabularQCheckpoint;
  buffer: ReplayBufferJSON;
  /** Per-(state,action) visit counts driving the learning-rate decay. */
  visits: Record<string, number>;
  cfg: Required<QLearningConfig>;
};

export class QLearningTrainer implements Trainer {
  private buffer: ReplayBuffer;
  private episodesDone = 0;
  private readonly cfg: Required<QLearningConfig>;
  /** Per-(state,action) visit counts — drive α = α₀/√N (Robbins-Monro), the
   *  condition that makes tabular Q-learning on a stochastic environment
   *  converge instead of oscillating (Phase F: verified empirically). */
  private visits = new Map<string, number>();
  /** Registered during train()/attach() so checkpoint()/restore() cover the Q table. */
  private registeredPolicy: TabularQPolicy | null = null;

  constructor(cfg: QLearningConfig = {}) {
    this.cfg = {
      alpha: cfg.alpha ?? 0.5,
      gamma: cfg.gamma ?? 0.99,
      epsilonStart: cfg.epsilonStart ?? 1.0,
      epsilonEnd: cfg.epsilonEnd ?? 0.05,
      epsilonDecayEpisodes: cfg.epsilonDecayEpisodes ?? 150,
      replayBatch: cfg.replayBatch ?? 16,
      replayAlpha: cfg.replayAlpha ?? 0.5,
      bufferCapacity: cfg.bufferCapacity ?? 20000,
      priorityClip: cfg.priorityClip ?? 1.0,
      seed: cfg.seed ?? 7,
    };
    this.buffer = new ReplayBuffer(this.cfg.bufferCapacity, this.cfg.seed);
  }

  private epsilonFor(episode: number): number {
    const { epsilonStart, epsilonEnd, epsilonDecayEpisodes } = this.cfg;
    if (episode >= epsilonDecayEpisodes) return epsilonEnd;
    return epsilonStart + ((epsilonEnd - epsilonStart) * episode) / Math.max(1, epsilonDecayEpisodes);
  }

  /** α = α₀/√N per (state,action) — Robbins-Monro decay; guarantees tabular
   *  Q-learning convergence where constant α oscillates on large value scales. */
  private alphaFor(key: string, actionIndex: number): number {
    const k = `${key}|${actionIndex}`;
    const n = (this.visits.get(k) ?? 0) + 1;
    this.visits.set(k, n);
    return this.cfg.alpha / Math.sqrt(n);
  }

  async train(envFactory: EnvironmentFactory, policy: Policy, ctx: TrainContext): Promise<void> {
    if (!(policy instanceof TabularQPolicy)) {
      throw new Error("QLearningTrainer requires a TabularQPolicy");
    }
    const p = policy;
    this.registeredPolicy = p;
    const maxSteps = ctx.maxSteps ?? 200;

    for (let e = 0; e < ctx.episodes; e++) {
      const episodeIndex = this.episodesDone++;
      const seed = ctx.seeds[episodeIndex % ctx.seeds.length];
      const env = envFactory();
      env.reset(seed);
      let result: StepResult;
      let obs: Observation = env.getState() as Observation;
      p.epsilon = this.epsilonFor(episodeIndex);

      let total = 0;
      let steps = 0;

      for (let t = 0; t < maxSteps; t++) {
        const key = p.discretize(obs);
        const { action, index } = p.select(obs);
        result = env.step(action);
        const terminal = result.terminated || result.truncated;
        const reward = result.reward;
        total += reward;
        steps++;

        const nextKey = p.discretize(result.observation);
        const row = p.getQ(key);
        const nextMax = terminal ? 0 : Math.max(...p.getQ(nextKey));
        const target = reward + this.cfg.gamma * nextMax;
        const tdError = target - row[index];
        row[index] += this.alphaFor(key, index) * tdError;

        this.buffer.add({
          key,
          actionIndex: index,
          reward,
          nextKey,
          terminal,
          priority: Math.min(Math.abs(tdError), this.cfg.priorityClip) + 1e-3,
        });

        obs = result.observation;
        if (terminal) break;
      }

      // Prioritized replay pass (gated: every 4th episode; entries whose
      // sampled outcome is stale are re-applied with a decaying step size).
      if (this.cfg.replayBatch > 0 && episodeIndex % 4 === 3) {
        const batch = this.buffer.sample(this.cfg.replayBatch);
        for (const entry of batch) {
          const row = p.getQ(entry.key);
          const nextMax = entry.terminal ? 0 : Math.max(...p.getQ(entry.nextKey));
          const target = entry.reward + this.cfg.gamma * nextMax;
          row[entry.actionIndex] += this.alphaFor(entry.key, entry.actionIndex) * this.cfg.replayAlpha * (target - row[entry.actionIndex]);
        }
      }

      ctx.onEpisode?.({
        episode: episodeIndex,
        seed,
        steps,
        return: total,
        epsilon: p.epsilon,
      });
    }
  }

  checkpoint(): QLearningCheckpoint {
    if (!this.registeredPolicy) throw new Error("no policy registered — call train() first or attach(policy)");
    return {
      episodesDone: this.episodesDone,
      policy: this.registeredPolicy.checkpoint(),
      buffer: this.buffer.toJSON(),
      visits: Object.fromEntries(this.visits),
      cfg: this.cfg,
    };
  }

  restore(state: QLearningCheckpoint): void {
    if (!this.registeredPolicy) throw new Error("no policy registered — pass the policy to train() or attach(policy) before restore");
    this.registeredPolicy.restore(state.policy);
    this.buffer = ReplayBuffer.fromJSON(state.buffer);
    this.visits = new Map(Object.entries(state.visits ?? {}));
    this.episodesDone = state.episodesDone;
  }

  /** Register the policy so checkpoint()/restore() can manage its state. */
  attach(policy: TabularQPolicy): void {
    this.registeredPolicy = policy;
  }

  get bufferObject(): ReplayBuffer {
    return this.buffer;
  }
  get episodes(): number {
    return this.episodesDone;
  }
}
