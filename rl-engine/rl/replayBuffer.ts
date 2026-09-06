/**
 * Replay buffer — spec §41 rl/replayBuffer.ts (Phase F upgrade).
 *
 * - Proportional priority sampling (priority = |TD error| + ε at insertion),
 *   O(n) prefix pass per sample + O(log n) binary search per draw,
 *   without replacement.
 * - Capacity eviction: ring-buffer FIFO overflow.
 * - Serialization: toJSON/fromJSON including the sampling RNG state, so a
 *   checkpointed buffer resumes its exact sampling stream (§28/§45).
 *
 * GAP-4 (Phase F): the previous implementation sampled with `Math.random`,
 * violating the §28 determinism rule — training was not replayable.
 */

import { createRandomService } from "../core/randomness";
import type { RandomService } from "../core/randomness";

export type ReplayEntry = {
  /** Discretized state key. */
  key: string;
  actionIndex: number;
  reward: number;
  /** Discretized next-state key. */
  nextKey: string;
  terminal: boolean;
  /** Sampling priority (|TD error| + ε at insertion time). */
  priority: number;
  /** Insertion sequence number (provenance only; eviction is ring order). */
  seq: number;
};

export type ReplayBufferJSON = {
  capacity: number;
  entries: ReplayEntry[];
  nextIndex: number;
  totalSeen: number;
  rngState: number;
};

export class ReplayBuffer {
  private entries: ReplayEntry[] = [];
  private nextIndex = 0;
  private totalSeen = 0;
  private rng: RandomService;

  constructor(
    private readonly capacity = 20000,
    seed: number | string = 7
  ) {
    this.rng = createRandomService(seed);
  }

  get size(): number {
    return this.entries.length;
  }
  get capacityUsed(): number {
    return this.capacity;
  }
  get seen(): number {
    return this.totalSeen;
  }

  add(entry: Omit<ReplayEntry, "seq">): void {
    const full: ReplayEntry = { ...entry, seq: this.totalSeen++ };
    if (this.entries.length < this.capacity) {
      this.entries.push(full);
      // Ring head only matters once we are at capacity.
      if (this.entries.length === this.capacity) this.nextIndex = 0;
    } else {
      this.entries[this.nextIndex] = full;
      this.nextIndex = (this.nextIndex + 1) % this.capacity;
    }
  }

  /** Proportional-priority sampling without replacement. */
  sample(n: number): ReplayEntry[] {
    const m = this.entries.length;
    if (m === 0) return [];
    const want = Math.min(n, m);

    const prefix = new Float64Array(m);
    let acc = 0;
    for (let i = 0; i < m; i++) {
      acc += Math.max(this.entries[i].priority, 1e-6);
      prefix[i] = acc;
    }
    const total = acc;

    const out: ReplayEntry[] = [];
    const used = new Set<number>();
    let attempts = 0;
    const maxAttempts = want * 60;
    while (out.length < want && attempts < maxAttempts) {
      attempts++;
      const u = this.rng.nextFloat() * total;
      let lo = 0;
      let hi = m - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (prefix[mid] >= u) hi = mid;
        else lo = mid + 1;
      }
      if (!used.has(lo)) {
        used.add(lo);
        out.push(this.entries[lo]);
      }
    }
    return out;
  }

  clear(): void {
    this.entries = [];
    this.nextIndex = 0;
    this.totalSeen = 0;
  }

  toJSON(): ReplayBufferJSON {
    return {
      capacity: this.capacity,
      entries: this.entries.map((e) => ({ ...e })),
      nextIndex: this.nextIndex,
      totalSeen: this.totalSeen,
      rngState: this.rng.snapshotState(),
    };
  }

  static fromJSON(data: ReplayBufferJSON): ReplayBuffer {
    const buf = new ReplayBuffer(data.capacity, 7);
    buf.entries = data.entries.map((e) => ({ ...e }));
    buf.nextIndex = data.nextIndex;
    buf.totalSeen = data.totalSeen;
    buf.rng.restoreState(data.rngState);
    return buf;
  }
}
