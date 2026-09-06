/**
 * Seeded PRNG (mulberry32) and a hashing helper to derive seeds from
 * deterministic inputs. ALL randomness in the engine flows through this.
 */

/**
 * Mulberry32 — a fast 32-bit PRNG with good distribution. Returns a draw
 * function that is still a plain `() => number`, with the generator's entire
 * internal state (the single integer `s`) exposed for checkpointing:
 * snapshotState()/restoreState() make mid-episode snapshot/restore exact
 * (GAP-3, Phase E — spec §29/§45 checkpoint restore).
 */
export function mulberry32(seed: number): (() => number) & { snapshotState(): number; restoreState(state: number): void } {
  let s = seed | 0;
  const next = (): number => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  next.snapshotState = (): number => s;
  next.restoreState = (state: number): void => {
    s = state | 0;
  };
  return next;
}

/**
 * Simple string hash (djb2 variant) — produces a deterministic 32-bit integer.
 */
function hashString(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
  return hash;
}

export function hashSeed(...parts: (number | string)[]): number {
  let h = 0;
  for (const part of parts) {
    if (typeof part === "number") h = ((h << 5) - h + part) | 0;
    else h = ((h << 5) - h + hashString(part)) | 0;
  }
  return h;
}

export function roll(rng: () => number, probability: number): boolean {
  return rng() < Math.max(0, Math.min(1, probability));
}

export function pick<T>(rng: () => number, items: T[]): T {
  return items[Math.floor(rng() * items.length)];
}

export interface RandomService {
  seed(seed: number | string): void;
  nextFloat(): number;
  nextInt(min: number, max: number): number;
  choice<T>(items: T[]): T;
  weightedChoice<T>(items: { item: T; weight: number }[]): T;
  /** Capture the generator's exact internal state (GAP-3, Phase E). */
  snapshotState(): number;
  /** Restore a previously captured internal state — the stream continues identically. */
  restoreState(state: number): void;
}

export function createRandomService(seed: number | string): RandomService {
  let rng = mulberry32(typeof seed === "string" ? hashString(seed) : seed);
  return {
    seed(s: number | string) {
      rng = mulberry32(typeof s === "string" ? hashString(s) : s);
    },
    nextFloat() {
      return rng();
    },
    nextInt(min: number, max: number) {
      return Math.floor(rng() * (max - min + 1)) + min;
    },
    choice<T>(items: T[]): T {
      return pick(rng, items);
    },
    weightedChoice<T>(items: { item: T; weight: number }[]): T {
      const total = items.reduce((sum, e) => sum + e.weight, 0);
      let r = rng() * total;
      for (const e of items) {
        r -= e.weight;
        if (r <= 0) return e.item;
      }
      return items[items.length - 1].item;
    },
    snapshotState(): number {
      return rng.snapshotState();
    },
    restoreState(state: number): void {
      rng.restoreState(state);
    },
  };
}
