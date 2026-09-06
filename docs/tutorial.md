# Engine Tutorial — Build a Toy Environment in ~60 Lines

This tutorial builds a complete, deterministic, graded RL environment — a **thermostat with a heater** — and verifies it with the same gates production packs use. Companion file (runs green, exercised in CI): [`examples/toy-thermostat.ts`](examples/toy-thermostat.ts).

Everything is declarative: **you write one JSON object, the engine does the rest.** You never call `core/`.

## 0. Prerequisites

- Node ≥ 22. From the repo root, the only command you need:

```bash
node --import tsx docs/examples/toy-thermostat.ts   # the finished result
```

## 1. The spec skeleton (§9)

An environment is an `EnvironmentSpecification`. Start with identity and a typed state schema (§6):

```ts
const spec = {
  environment: { id: "toy-thermostat", version: "1.0.0", specVersion: "1.0" },
  state: {
    temperature: { type: "float", min: -20, max: 40, default: 15 },
    heater:      { type: "boolean", default: false },
    energy:      { type: "float", min: 0, max: 1000, default: 0 },
  },
  entities: [],            // §7 — none needed here
  actions: [],             // §5 — next step
  rules: [],               // §10–14 — next steps
  observations: { fields: [], fullyObservable: false },
  rewards: { components: [] },
  constraints: [],
  termination: [],
};
```

`min`/`max` on state fields are **hard physics**: every transition is validated against them and a violating transition is rejected atomically (the world stays unchanged).

## 2. Actions (§5)

Discrete actions the agent can request:

```ts
actions: [{ kind: "discrete", actions: ["warmer", "cooler"] }],
```

The agent sends `{ type: "warmer" }`. Unknown types are rejected at `action_validation` — state never mutates. (Other kinds: `parameterized`, `continuous`, `multiDiscrete`, `conditional` — see `rl-engine/domain-packs/README.md`.)

## 3. Rules — how the world responds (§10–12)

Rules fire when their conditions match the live state plus the pending action:

```ts
rules: [
  { id: "apply_heater",
    conditions: [{ field: "heater", op: "eq", value: true }],
    effects: [
      { target: "state", field: "temperature", op: "add", value: 1 },
      { target: "state", field: "energy", op: "add", value: 0.5 },
    ],
    priority: 5, probability: 1, enabled: true, cooldown: 0, scope: "global" },
  { id: "cool_down",      conditions: [{ field: "heater", op: "eq", value: false }], effects: [{ target: "state", field: "temperature", op: "subtract", value: 0.5 }], priority: 5, probability: 1, enabled: true, cooldown: 0, scope: "global" },
  { id: "set_heater_on",  conditions: [{ field: "action", op: "eq", value: "warmer" }], effects: [{ target: "state", field: "heater", op: "set", value: true }],  priority: 10, probability: 1, enabled: true, cooldown: 0, scope: "global" },
  { id: "set_heater_off", conditions: [{ field: "action", op: "eq", value: "cooler" }], effects: [{ target: "state", field: "heater", op: "set", value: false }], priority: 10, probability: 1, enabled: true, cooldown: 0, scope: "global" },
],
```

Notes: `probability: 1` = deterministic; use e.g. `0.7` plus `outcomes: [{id, probability, effects}]` (summing to 1) for stochastic worlds — all randomness flows through the seeded RNG (§28), never `Math.random`. Condition field `action` is the requested action's type.

## 4. Observations — what the agent may see (§17)

```ts
observations: { fields: [{ field: "temperature", source: "temperature" }], fullyObservable: false },
```

`fullyObservable: false` + a field list = partial observability: `Observation ⊂ State`. The agent sees the temperature but not the heater flag or the energy meter.

## 5. Rewards — the score (§18–19)

```ts
rewards: { components: [
  { id: "comfort",     expression: "0 - abs(state.temperature - 20)", weight: 1.0 },
  { id: "energy_cost", expression: "state.energy - prevState.energy",  weight: -0.1 },
] },
```

Expressions are sandboxed arithmetic over `state.*` / `prevState.*` / `nextState.*` / `action.value` — compiled by a shunting-yard parser, no eval. **Reward design is the whole game**: this component set rewards holding 20° while charging for energy, which makes "heat then coast" optimal.

## 6. Termination + constraints (§20)

```ts
constraints: [{ id: "temp_band", type: "range", target: { field: "temperature", min: -20, max: 40 }, priority: 1, satisfied: false }],
termination: [
  { field: "temperature", op: "gte", value: 40, kind: "terminated" },
  { field: "", op: "eq", value: 0, kind: "truncated", maxSteps: 50 },
],
```

## 7. Compile → run

```ts
const compiled = compileEnvironment(spec);           // §32 — catches defects before running
if (!compiled.ok) throw new Error(compiled.errors.map(e => e.message).join("; "));
const env = createEnvironment(spec, 42);             // deterministic seed
env.reset(42);

let total = 0;
for (let i = 0; i < 50; i++) {
  const obs = env.getState() as { temperature: number };
  const r = env.step({ type: obs.temperature < 20 ? "warmer" : "cooler" });  // bang-bang control
  total += r.reward;
  if (r.terminated || r.truncated) break;
}
// → final temperature 20.0°, comfort held, return ≈ -1.0 (one warmup energy cost)
```

Every `step()` ran the 6-layer pipeline (§15) atomically (§16): validate action → pre-flight effects → apply to a temp copy → check constraints → validate result → **commit or discard**.

## 8. Prove determinism (§44)

```ts
const g = gate(spec, [1, 2, 3], (_s, i) => ({ type: i % 2 === 0 ? "warmer" : "cooler" }), 30);
// g.pass === true — same spec + seed + actions → identical trajectory hash
```

## Where to go next

- `rl-engine/domain-packs/README.md` — the full authoring contract (all five action kinds, effect-value `$field/$mul` references, outcomes, entity targets).
- `rl-engine/domain-packs/trading-market/spec.json` — continuous actions + reward shaping in a real pack.
- `rl-engine/testing/learning-demo.ts` — train an agent on your environment and prove the reward is informative.
- `docs/benchmark-guide.md` — turn an environment into a graded benchmark.
