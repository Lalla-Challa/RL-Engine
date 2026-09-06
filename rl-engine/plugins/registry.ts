/**
 * Plugin registry — spec §30–31
 * Function registry: distance_between, clamp, min, max, abs, random, count, sum, average (sandboxed)
 */

import type { Plugin } from "./plugin";

const SAFE_FUNCTIONS: Record<string, (...args: number[]) => number> = {
  clamp: (v, lo, hi) => Math.max(lo, Math.min(hi, v)),
  min: (...args) => Math.min(...args),
  max: (...args) => Math.max(...args),
  abs: (v) => Math.abs(v),
  count: (...args) => args.length,
  sum: (...args) => args.reduce((a, b) => a + b, 0),
  average: (...args) => args.reduce((a, b) => a + b, 0) / args.length,
  distance_between: (a, b) => Math.abs(a - b),
};

/** Phase G security audit: the exact callable allowlist (§31, §40).
 *  Deliberately EXCLUDED despite the spec mentioning them: `random`
 *  (determinism requires all stochasticity through the seeded RandomService),
 *  and anything touching scope, eval, or I/O. */
export const ALLOWED_FUNCTIONS: readonly string[] = Object.freeze(Object.keys(SAFE_FUNCTIONS));

export function isAllowedFunction(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(SAFE_FUNCTIONS, name);
}

export class PluginRegistry {
  private plugins = new Map<string, Plugin>();

  register(plugin: Plugin): void {
    this.plugins.set(plugin.name, plugin);
  }

  get(name: string): Plugin | undefined {
    return this.plugins.get(name);
  }

  list(): Plugin[] {
    return [...this.plugins.values()];
  }

  callSafeFunction(name: string, args: number[]): number | null {
    // Prototype-pollution hardening (§40): only own properties of the
    // allowlist are callable — "constructor", "__proto__", "toString" fail.
    if (!isAllowedFunction(name)) return null;
    const fn = SAFE_FUNCTIONS[name];
    return fn(...args);
  }

  hasFunction(name: string): boolean {
    return isAllowedFunction(name);
  }
}

export const safeFunctions = SAFE_FUNCTIONS;
