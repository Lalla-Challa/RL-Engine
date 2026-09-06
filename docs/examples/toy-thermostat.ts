/**
 * Tutorial companion (Phase G, DoD #2): the exact toy environment built in
 * docs/tutorial.md — a thermostat with a heater. Runs green when the tutorial
 * is correct.
 *
 * Run: node --import tsx docs/examples/toy-thermostat.ts
 */
import { compileEnvironment, createEnvironment, validateEnvironment, gate } from "../../rl-engine/index";

const spec = {
  environment: { id: "toy-thermostat", version: "1.0.0", specVersion: "1.0" },
  state: {
    temperature: { type: "float", min: -20, max: 40, default: 15 },
    heater: { type: "boolean", default: false },
    energy: { type: "float", min: 0, max: 1000, default: 0 },
  },
  entities: [],
  actions: [{ kind: "discrete", actions: ["warmer", "cooler"] }],
  rules: [
    {
      id: "apply_heater",
      conditions: [{ field: "heater", op: "eq", value: true }],
      effects: [
        { target: "state", field: "temperature", op: "add", value: 1 },
        { target: "state", field: "energy", op: "add", value: 0.5 },
      ],
      priority: 5, probability: 1, enabled: true, cooldown: 0, scope: "global",
    },
    { id: "cool_down", conditions: [{ field: "heater", op: "eq", value: false }], effects: [{ target: "state", field: "temperature", op: "subtract", value: 0.5 }], priority: 5, probability: 1, enabled: true, cooldown: 0, scope: "global" },
    { id: "set_heater_on", conditions: [{ field: "action", op: "eq", value: "warmer" }], effects: [{ target: "state", field: "heater", op: "set", value: true }], priority: 10, probability: 1, enabled: true, cooldown: 0, scope: "global" },
    { id: "set_heater_off", conditions: [{ field: "action", op: "eq", value: "cooler" }], effects: [{ target: "state", field: "heater", op: "set", value: false }], priority: 10, probability: 1, enabled: true, cooldown: 0, scope: "global" },
  ],
  observations: { fields: [{ field: "temperature", source: "temperature" }], fullyObservable: false },
  rewards: {
    components: [
      { id: "comfort", expression: "0 - abs(state.temperature - 20)", weight: 1.0 },
      { id: "energy_cost", expression: "state.energy - prevState.energy", weight: -0.1 },
    ],
  },
  constraints: [{ id: "temp_band", type: "range", target: { field: "temperature", min: -20, max: 40 }, priority: 1, satisfied: false }],
  termination: [
    { field: "temperature", op: "gte", value: 40, kind: "terminated" },
    { field: "", op: "eq", value: 0, kind: "truncated", maxSteps: 50 },
  ],
} as const;

const compiled = compileEnvironment(spec as unknown as Parameters<typeof compileEnvironment>[0]);
if (!compiled.ok) {
  console.error(compiled.errors.map((e) => e.message).join("\n"));
  process.exit(1);
}
const validated = validateEnvironment(spec as unknown as Parameters<typeof validateEnvironment>[0]);
if (!validated.valid) {
  console.error(validated.errors.map((e) => e.message).join("\n"));
  process.exit(1);
}

const env = createEnvironment(spec as never, 42);
env.reset(42);

// A tiny bang-bang controller: heat below 20, cool at/above 20.
let total = 0;
for (let i = 0; i < 50; i++) {
  const obs = env.getState() as { temperature: number };
  const r = env.step({ type: obs.temperature < 20 ? "warmer" : "cooler" });
  total += r.reward;
  if (r.terminated || r.truncated) break;
}
const final = env.getState() as { temperature: number };
const comfortHeld = Math.abs(final.temperature - 20) < 1;

const g = gate(spec as never, [1, 2, 3], (_s, i) => ({ type: i % 2 === 0 ? "warmer" : "cooler" }), 30);

console.log(`compiled: ok · final temperature: ${final.temperature.toFixed(1)}° · comfort held: ${comfortHeld} · return: ${total.toFixed(1)}`);
console.log(`determinism gate: ${g.pass ? "pass" : "FAIL " + JSON.stringify(g.failures)}`);

if (!comfortHeld || !g.pass) {
  console.error("toy environment broken — see docs/tutorial.md");
  process.exit(1);
}
console.log("TUTORIAL EXAMPLE PASSES");
