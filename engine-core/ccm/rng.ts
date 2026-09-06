/**
 * Seeded PRNG (mulberry32) and a hashing helper to derive seeds from
 * deterministic inputs. ALL randomness in the engine flows through this.
 */

/**
 * Mulberry32 — a fast 32-bit PRNG with good distribution. Returns a function
 * that produces 0..1 floats deterministically from the seed.
 */
export function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Simple string hash (djb2 variant) — produces a deterministic 32-bit integer.
 */
function hashString(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
  }
  return hash;
}

/**
 * Hash one or more numbers/strings into a single 32-bit seed for mulberry32.
 * The order matters: hashSeed("a", "b") !== hashSeed("b", "a").
 */
export function hashSeed(...parts: (number | string)[]): number {
  let h = 0;
  for (const part of parts) {
    if (typeof part === "number") {
      h = ((h << 5) - h + part) | 0;
    } else {
      h = ((h << 5) - h + hashString(part)) | 0;
    }
  }
  return h;
}

/**
 * Roll a probability check: returns true if `rng() < probability`.
 * Probability is clamped to [0, 1].
 */
export function roll(rng: () => number, probability: number): boolean {
  return rng() < Math.max(0, Math.min(1, probability));
}

/**
 * Pick a random element from a non-empty array.
 */
export function pick<T>(rng: () => number, items: T[]): T {
  return items[Math.floor(rng() * items.length)];
}