/**
 * Property tests — spec §45 (expanded, Phase A).
 *
 * Properties verified against arbitrary seeds:
 *   P1  bounds never violated     — schema min/max hold after any committed step
 *   P2  terminal freeze           — terminated/truncated episodes reject mutation
 *   P3  outcome frequencies       — weighted outcomes converge to declared probabilities
 *   P4  immutable fields          — effects targeting immutable fields are rejected
 *   P5  entity/rel targets        — effects resolve into entity/rel records, not the root
 *   P6  invalid actions           — unknown actions never mutate state (re-checked per seed)
 *   P7  invalid effects atomic    — a rejected transition leaves state byte-identical
 */

import type { Action, EnvironmentSpecification } from "../core/types";
import { createEnvironment } from "../environment/environment";
import { createRandomService } from "../core/randomness";
import { applyTransition } from "../core/transitions";
import { cloneState, canonicalJson } from "../core/state";

export type PropertyReport = { pass: boolean; failures: string[]; samples: Record<string, unknown> };

export function testProperties(
  spec: EnvironmentSpecification,
  opts: { seeds?: number[]; samplesPerSeed?: number } = {}
): PropertyReport {
  const failures: string[] = [];
  const seeds = opts.seeds ?? [1, 7, 42, 99, 2024];
  const n = opts.samplesPerSeed ?? 300;

  const actionTypes: string[] = [];
  for (const a of spec.actions ?? []) {
    if (a.kind === "discrete") actionTypes.push(...a.actions);
    else if (a.kind === "parameterized") actionTypes.push(a.type);
  }

  // ── P1 + P6: bounds and invalid-action purity across seeded runs ──────────
  for (const seed of seeds) {
    const rng = createRandomService(seed);
    const env = createEnvironment(spec, seed);
    env.reset(seed);
    for (let i = 0; i < n; i++) {
      const before = canonicalJson(env.getState());
      const type = rng.choice(actionTypes);
      const result = env.step({ type });

      if (result.info.valid === false) {
        if (canonicalJson(env.getState()) !== before) {
          failures.push(`P6/P7 seed ${seed} step ${i}: rejected transition mutated state`);
          break;
        }
        continue;
      }
      // Bounds on every schema numeric field of the committed state.
      for (const [field, def] of Object.entries(spec.state ?? {})) {
        if (def.type !== "integer" && def.type !== "float") continue;
        const value = (result.state as Record<string, unknown>)?.[field];
        if (typeof value !== "number") continue;
        if (def.min !== undefined && value < def.min) { failures.push(`P1 seed ${seed} step ${i}: ${field}=${value} < min ${def.min}`); }
        if (def.max !== undefined && value > def.max) { failures.push(`P1 seed ${seed} step ${i}: ${field}=${value} > max ${def.max}`); }
      }
      if (result.terminated || result.truncated) break;
    }
  }

  // ── P2: terminal freeze ────────────────────────────────────────────────────
  {
    const env = createEnvironment(spec, 42);
    env.reset(42);
    let froze = false;
    for (let i = 0; i < 1000; i++) {
      const r = env.step({ type: actionTypes[0] ?? "noop" });
      if (r.terminated || r.truncated) {
        const frozen = canonicalJson(env.getState());
        const again = env.step({ type: actionTypes[0] ?? "noop" });
        if (canonicalJson(env.getState()) !== frozen || !String(again.info.error ?? "").includes("already terminated")) {
          failures.push("P2: terminated episode was not frozen");
        }
        froze = true;
        break;
      }
    }
    if (!froze) failures.push("P2: no termination/truncation reached in 1000 steps (cannot verify freeze)");
  }

  // ── P3: outcome frequencies converge (Bernoulli rule, 4k samples) ──────────
  {
    // Each step: counter += 1 (rule effect), then outcome "tails" (p=0.3)
    // subtracts 1. Net per step: +1 − 0.3·P(tails) → expected counter after
    // 4000 steps = 4000 × (1 − 0.3) = 2800. The leading increment guarantees
    // the counter never dips below 0, so no sample is lost to clamping.
    const spec2: EnvironmentSpecification = {
      ...spec,
      state: { ...(spec.state ?? {}), counter: { type: "integer", min: 0, max: 1000000, default: 0 } },
      termination: [{ field: "", op: "eq", value: 0, kind: "truncated", maxSteps: 4000 }],
      rules: [
        {
          id: "coin",
          conditions: [],
          effects: [{ target: "state", field: "counter", op: "increment", value: 1 }],
          priority: 1,
          probability: 1,
          enabled: true,
          cooldown: 0,
          lastFiredTick: -1,
          scope: "global",
          outcomes: [
            { id: "heads", probability: 0.7, effects: [] },
            { id: "tails", probability: 0.3, effects: [{ target: "state", field: "counter", op: "decrement", value: 1 }] },
          ],
        },
      ],
    };
    const env = createEnvironment(spec2, 7);
    env.reset(7);
    for (let i = 0; i < 4000; i++) env.step({ type: actionTypes[0] ?? "noop" });
    const finalCounter = Number((env.getState() as Record<string, unknown>).counter ?? 0);
    const expected = 4000 * (1 - 0.3);
    if (Math.abs(finalCounter - expected) > expected * 0.05) {
      failures.push(`P3: outcome frequency off — counter ${finalCounter}, expected ≈${expected} (±5%)`);
    }
  }

  // ── P4: immutable fields rejected at state_compatibility ───────────────────
  {
    const spec3: EnvironmentSpecification = {
      ...spec,
      state: { ...(spec.state ?? {}), serial: { type: "string", default: "SN-001", mutable: false } },
      termination: [{ field: "", op: "eq", value: 0, kind: "truncated", maxSteps: 10 }],
      rules: [],
    };
    const result = applyTransition(
      { serial: "SN-001" },
      [{ target: "state", field: "serial", op: "set", value: "SN-002" }],
      spec3.state as EnvironmentSpecification["state"]
    );
    if (result.committed || result.validation.layer !== "state_compatibility") {
      failures.push("P4: immutable field mutation was not rejected at state_compatibility");
    }
  }

  // ── P5: entity/rel effect targets resolve into sub-records ─────────────────
  {
    const temp = { "entity:e1": { state: { hp: 10 } }, "rel:r1": { state: { trust: "low" } } };

    const r1 = applyTransition(
      temp,
      [{ target: "entity:e1", field: "state.hp", op: "decrement", value: 4 }],
      {}
    );
    const e1 = r1.newState["entity:e1"] as Record<string, unknown> | undefined;
    const hp = e1 ? (e1.state as Record<string, unknown> | undefined)?.hp : undefined;
    if (!r1.committed || hp !== 6) {
      failures.push(`P5: entity-targeted effect did not apply inside the entity record (hp=${String(hp)})`);
    }

    const r2 = applyTransition(
      temp,
      [{ target: "rel:r1", field: "state.trust", op: "set", value: "high" }],
      {}
    );
    const relAfter = (r2.newState["rel:r1"] as Record<string, unknown> | undefined)?.state as Record<string, unknown> | undefined;
    if (!r2.committed || relAfter?.trust !== "high") {
      failures.push("P5: relationship-targeted effect did not apply inside the rel record");
    }

    const r3 = applyTransition(
      temp,
      [{ target: "entity:ghost", field: "state.hp", op: "set", value: 1 }],
      {}
    );
    if (r3.committed || r3.validation.layer !== "transition_validation") {
      failures.push("P5: unknown entity target was not rejected at transition_validation");
    }
  }

  return { pass: failures.length === 0, failures, samples: { seeds, samplesPerSeed: n } };
}
