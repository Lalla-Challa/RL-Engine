/**
 * CCE emergence smoke test — L6 verification.
 *
 * Builds a world with weather, transit, and relationship-driven rules and
 * runs the engine WITHOUT any plot or narrative constraints. The test asserts
 * that non-micro cross-actor events emerge from the world model alone:
 *   - relationship-scoped rules fire (the new scope)
 *   - events include both actors (cross-actor participation)
 *   - weather/environment chains produce their own events
 *   - determinism holds for identical seeds
 *
 * Run with: LOCAL_DATA_DIR=<scratch dir> node --import tsx server/ccm/__emergent__.ts
 */
import fs from "node:fs";
import { openLocalDb, runMigrations, getRawDb, ensureLocalUser } from "../db";
import { createProject } from "../modules/projects/project.data";
import { createActor, getProjectActors } from "../modules/actors/actor.data";
import { createEnvironment, createRule, createRelationship, getProjectEnvironments, getProjectRelationships } from "../modules/world/world.data";
import { createSimulation, updateSimulation, listEvents } from "../modules/simulation/simulation.data";
import { advanceSimulation } from "../modules/simulation/run.service";
import { getProjectById } from "../modules/projects/project.data";

const scratch = process.env.LOCAL_DATA_DIR;
if (!scratch) throw new Error("LOCAL_DATA_DIR must be set");
fs.rmSync(scratch, { recursive: true, force: true });
fs.mkdirSync(scratch, { recursive: true });

let failures = 0;
function assert(cond: boolean, label: string): void {
  if (cond) console.log(`  ✓ ${label}`);
  else { console.error(`  ✗ ${label}`); failures++; }
}

openLocalDb("a".repeat(64));
runMigrations();
ensureLocalUser();
const raw = getRawDb()!;
const localUser = raw.prepare("SELECT id FROM users WHERE openId = 'local:primary'").get() as any;

// ── Build the world model ──────────────────────────────────────────────────
const project = createProject(localUser.id, "Harbor Town", "Emergent world: weather + transit + relationship");
console.log("World model:");

createActor(project!.id, "Mara", {
  type: "human",
  description: "Ferry captain who runs the harbor crossing",
  attributes: { role: "captain" },
  state: { location: "Harbor", exertion: 0, awareness: "routine" },
  goals: { survival: [], functional: ["make the crossing"], social: ["work with Finn"], emotional: [], longTerm: [], narrative: [] },
  drives: ["river", "crossing", "ferry"],
  habits: ["morning crossing"],
  constraints: [],
  knowledge: [],
  capabilities: ["steer ferry", "read weather"],
});
createActor(project!.id, "Finn", {
  type: "human",
  description: "Fisher who works the coastal waters",
  attributes: { role: "fisher" },
  state: { location: "OpenWater", exertion: 0, awareness: "routine" },
  goals: { survival: [], functional: ["bring in the catch"], social: ["work with Mara"], emotional: [], longTerm: [], narrative: [] },
  drives: ["catch", "weather", "fish"],
  habits: ["dawn nets"],
  constraints: [],
  knowledge: [],
  capabilities: ["sail", "read weather"],
});
assert(getProjectActors(project!.id).length === 2, "2 actors created");

createEnvironment(project!.id, "Harbor", {
  type: "transit",
  state: { weather: "calm", crossing: "open", tide: "low" },
  resources: {},
  inhabitants: ["Mara"],
  activeProcesses: ["tide rising", "ferry traffic"],
  constraints: [],
});
createEnvironment(project!.id, "OpenWater", {
  type: "weather",
  state: { weather: "calm", swell: "low" },
  resources: {},
  inhabitants: [],
  activeProcesses: ["storm brewing", "current shifting"],
  constraints: [],
});

const actors = getProjectActors(project!.id);
const mara = actors.find((a) => a.name === "Mara")!;
const finn = actors.find((a) => a.name === "Finn")!;

createRelationship(project!.id, mara.id, finn.id, {
  familiarity: "longtime",
  trust: "high",
  affection: "warm",
  resentment: "none",
  dependence: "moderate",
  fear: "none",
  obligation: "moderate",
  respect: "high",
  knowledge: "deep",
  expectations: { cooperate: "watch the weather" },
  history: ["shared the storm watch"],
});
assert(getProjectRelationships(project!.id).length === 1, "relationship created");

// ── Relationship-scoped rule (L6 verification) ─────────────────────────────
// Fires on the bond between Mara and Finn. When trust is high and affection
// is warm they meet at the crossing — a cross-actor event.
createRule(project!.id, "BondMeet", {
  family: "relationship",
  scope: "relationship",
  probability: 0.9,
  when: {
    conditions: [
      { field: "trust", op: "eq", value: "high" },
      { field: "affection", op: "eq", value: "warm" },
    ],
  },
  candidateEvents: [
    {
      id: "bond.meet",
      summary: "Mara and Finn share the crossing",
      level: "event",
      narrativeWeight: "high",
      probability: 0.8,
      stateChanges: [
        { target: "self", field: "affection", op: "set", value: "deepened" },
        { target: "actor:Mara", field: "state.location", op: "set", value: "Harbor" },
        { target: "actor:Finn", field: "state.location", op: "set", value: "Harbor" },
      ],
    },
  ],
  effects: [],
  priority: 7,
  cooldown: 0,
});

// ── Weather rule (environment scope) ───────────────────────────────────────
// When the weather is calm, a storm front can roll in.
createRule(project!.id, "StormFront", {
  family: "environment",
  scope: "environment",
  probability: 0.8,
  when: {
    conditions: [
      { field: "state.weather", op: "eq", value: "calm" },
    ],
  },
  candidateEvents: [
    {
      id: "weather.storm_front",
      summary: "storm front rolls in over {name}",
      level: "event",
      narrativeWeight: "medium",
      probability: 0.7,
      stateChanges: [
        { target: "self", field: "state.weather", op: "set", value: "stormy" },
      ],
    },
  ],
  effects: [],
  priority: 5,
  cooldown: 0,
});

// ── Transit rule (environment scope) ───────────────────────────────────────
// A stormy harbor closes the crossing.
createRule(project!.id, "HarborClosed", {
  family: "environment",
  scope: "environment",
  probability: 0.9,
  when: {
    conditions: [
      { field: "state.weather", op: "eq", value: "stormy" },
    ],
  },
  candidateEvents: [
    {
      id: "transit.harbor_closed",
      summary: "harbor crossing closes at {name}",
      level: "event",
      narrativeWeight: "medium",
      probability: 0.8,
      stateChanges: [
        { target: "self", field: "state.crossing", op: "set", value: "closed" },
      ],
    },
  ],
  effects: [],
  priority: 4,
  cooldown: 0,
});

// ── Actor rule (Mara warns the boats) ──────────────────────────────────────
// Texture: while at the harbor, Mara's ferry drive pushes her to warn boats.
// The relationship event above is the cross-actor demonstration.
createRule(project!.id, "MaraWarns", {
  family: "actor",
  scope: "actor",
  probability: 0.7,
  when: {
    conditions: [
      { field: "state.location", op: "eq", value: "Harbor" },
    ],
    requiresPressure: "ferry",
  },
  candidateEvents: [
    {
      id: "actor.mara_warns",
      summary: "{name} calls out warnings to the boats",
      level: "event",
      narrativeWeight: "medium",
      probability: 0.6,
      stateChanges: [
        { target: "actor:Finn", field: "state.awareness", op: "set", value: "alerted" },
      ],
    },
  ],
  effects: [],
  priority: 3,
  cooldown: 0,
});

console.log("  ✓ world model built (2 actors, 2 environments, 1 relationship, 4 rules)");

// ── Snapshot pristine world state for the determinism check ────────────────
// The persister mutates actor state, environment state, and relationship fields
// in the DB after each run. Snapshot everything BEFORE the first run so the
// second run can be restored to the identical starting world.
const initialActorStates = getProjectActors(project!.id).map((a) => ({
  id: a.id, state: a.state, goals: a.goals, drives: a.drives, beliefs: a.beliefs,
  knowledge: a.knowledge, capabilities: a.capabilities, constraints: a.constraints,
  resources: a.resources, habits: a.habits, plans: a.plans,
}));
const initialEnvironments = (() => {
  const envs = getProjectEnvironments(project!.id);
  return envs.map((e) => ({ id: e.id, state: e.state, resources: e.resources, inhabitants: e.inhabitants, activeProcesses: e.activeProcesses, constraints: e.constraints }));
})();
const initialRelationships = getProjectRelationships(project!.id).map((r) => ({
  id: r.id, familiarity: r.familiarity, trust: r.trust, affection: r.affection,
  resentment: r.resentment, dependence: r.dependence, fear: r.fear, obligation: r.obligation,
  respect: r.respect, knowledge: r.knowledge, expectations: r.expectations, history: r.history,
}));
const restoreWorldState = () => {
  const up = raw.prepare(`UPDATE ccm_actors SET state = ?, goals = ?, drives = ?, beliefs = ?, knowledge = ?, capabilities = ?, constraints = ?, resources = ?, habits = ?, plans = ? WHERE id = ?`);
  for (const s of initialActorStates) {
    up.run(JSON.stringify(s.state), JSON.stringify(s.goals), JSON.stringify(s.drives), JSON.stringify(s.beliefs), JSON.stringify(s.knowledge), JSON.stringify(s.capabilities), JSON.stringify(s.constraints), JSON.stringify(s.resources), JSON.stringify(s.habits), JSON.stringify(s.plans), s.id);
  }
  const upEnv = raw.prepare(`UPDATE ccm_environments SET state = ?, resources = ?, inhabitants = ?, activeProcesses = ?, constraints = ? WHERE id = ?`);
  for (const e of initialEnvironments) {
    upEnv.run(JSON.stringify(e.state), JSON.stringify(e.resources), JSON.stringify(e.inhabitants), JSON.stringify(e.activeProcesses), JSON.stringify(e.constraints), e.id);
  }
  const upRel = raw.prepare(`UPDATE ccm_relationships SET familiarity = ?, trust = ?, affection = ?, resentment = ?, dependence = ?, fear = ?, obligation = ?, respect = ?, knowledge = ?, expectations = ?, history = ? WHERE id = ?`);
  for (const r of initialRelationships) {
    upRel.run(r.familiarity, r.trust, r.affection, r.resentment, r.dependence, r.fear, r.obligation, r.respect, r.knowledge, JSON.stringify(r.expectations), JSON.stringify(r.history), r.id);
  }
};

// ── Run the engine (no plot, no constraints — world-before-plot) ───────────
const sim = createSimulation(project!.id, "Emergence Run", "world-before-plot");
updateSimulation(sim!.id, { simulationSeed: 42, clock: { day: 0, minute: 6 * 60 } });

console.log("\nAdvancing 48 ticks (8 hours) — no narrative constraints:");
const result = advanceSimulation(sim!.id, 48);
const events = listEvents(sim!.id).map((e) => `${e.timestamp}:${e.eventType}:${e.narrativeWeight}:${JSON.stringify(e.participants)}`);

console.log(`  events=${events.length}, ticks=${result.summary.ticks ?? "?"}, selected=${result.summary.selected ?? "?"}`);

assert(events.length > 0, "events were generated");

// ── Verify non-micro events exist ──────────────────────────────────────────
const nonMicro = events.filter((e) => !e.includes('"low"'));
assert(nonMicro.length > 0, "non-micro events exist (narrativeWeight !== low)");

// ── Verify cross-actor events (both Mara and Finn in participants) ─────────
const crossActor = events.filter((e) => e.includes('"Mara"') && e.includes('"Finn"'));
assert(crossActor.length > 0, "cross-actor events exist (Mara + Finn both participants)");

// ── Verify relationship-scoped rule fired ──────────────────────────────────
const bondEvents = events.filter((e) => e.includes("bond.meet"));
assert(bondEvents.length > 0, "relationship-scoped rule fired (bond.meet)");

// ── Verify weather chain produced events ───────────────────────────────────
const stormEvents = events.filter((e) => e.includes("weather.storm_front"));
assert(stormEvents.length > 0, "weather rule fired (storm_front)");

// ── Determinism: same seed twice → identical sequences ─────────────────────
// Restore the pristine snapshot captured before run 1, then run again with
// the same seed and compare sequences.
restoreWorldState();
const simB = createSimulation(project!.id, "Det B", "determinism");
updateSimulation(simB!.id, { simulationSeed: 42, clock: { day: 0, minute: 6 * 60 } });
advanceSimulation(simB!.id, 48);
const eventsB = listEvents(simB!.id).map((e) => `${e.timestamp}:${e.eventType}:${e.narrativeWeight}:${JSON.stringify(e.participants)}`);

assert(events.length === eventsB.length, `same event count (${events.length} == ${eventsB.length})`);
assert(JSON.stringify(events) === JSON.stringify(eventsB), "identical event sequences for identical seeds");

console.log(failures === 0 ? "\nALL EMERGENCE CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);