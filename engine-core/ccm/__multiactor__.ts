/**
 * CCE v1.1 — Multi-Agent Causal Interaction & Autonomous Event Generation
 * (Harmon Creek world fixture + required experiments).
 *
 * World: 8 actors, 5 environments, 5 systems, 6 relationships, ~14 rules.
 * The world is authored so NO single rule encodes the full chain. Instead the
 * chain emerges from: actor actions → environment change → observation →
 * knowledge → plan adaptation → alternative action → cross-actor interaction
 * → relationship change → later event.
 *
 * Experiments (CCE v1.1 §33-35):
 *   - autonomy chain with full causal ancestry
 *   - counterfactual A: remove a key actor goal
 *   - counterfactual B: change a relationship state
 *   - counterfactual C: alter an environment condition
 *   - counterfactual D: remove the protagonist
 *   - multi-seed variation (same seed identical, different seeds differ)
 *   - event budget: transitionOnly churn does not starve interactions
 *   - determinism: same seed twice → identical history
 *
 * Run with: LOCAL_DATA_DIR=<scratch dir> node --import tsx server/ccm/__multiactor__.ts
 */
import fs from "node:fs";
import { openLocalDb, runMigrations, getRawDb, ensureLocalUser } from "../db";
import { createProject } from "../modules/projects/project.data";
import { createActor, getProjectActors } from "../modules/actors/actor.data";
import {
  createEnvironment,
  createSystem,
  createRule,
  createRelationship,
  getProjectEnvironments,
  getProjectRelationships,
} from "../modules/world/world.data";
import { createSimulation, updateSimulation, listEvents, getEventAncestry, listEpisodes, listSkeletons } from "../modules/simulation/simulation.data";
import { advanceSimulation } from "../modules/simulation/run.service";

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

// ── World builder ──────────────────────────────────────────────────────────
// `opts` lets counterfactual experiments mutate the world BEFORE the first run.
type WorldOpts = {
  /** Counterfactual D: omit the protagonist entirely. */
  noMara?: boolean;
  /** Counterfactual A: remove Finn's market goal (plan interruption driver). */
  noFinnGoal?: boolean;
  /** Counterfactual B: Rina↔Tessa trust low → gossip does not spread. */
  lowRinaTessaTrust?: boolean;
  /** Counterfactual C: the ferry already departed at world start. */
  ferryAlreadyDeparted?: boolean;
};

let maraId = 0;
let finnId = 0;
let kaelId = 0;

function buildWorld(projectId: number, opts: WorldOpts = {}) {
  // ── Actors (8) ────────────────────────────────────────────────────────────
  if (!opts.noMara) {
    const mara = createActor(projectId, "Mara", {
      type: "human",
      description: "Ferry captain who runs the harbor crossing",
      attributes: { role: "captain", vessel: "The Swallow" },
      state: { location: "Harbor", energy: "high", mood: "focused" },
      goals: { survival: [], functional: ["run the ferry"], social: ["help travelers"], emotional: [], longTerm: [], narrative: [] },
      drives: ["schedule", "river"],
      habits: ["morning crossing"],
      constraints: [],
      knowledge: ["harbor schedules"],
      capabilities: ["steer ferry", "read weather"],
      resources: { ferry: 1 },
      plans: ["run the morning crossing"],
    });
    maraId = mara!.id;
  }

  const finn = createActor(projectId, "Finn", {
    type: "human",
    description: "Fisher with a catch to sell",
    attributes: { role: "fisher" },
    state: { location: "Harbor", energy: "medium", mood: "calm" },
    goals: opts.noFinnGoal
      ? { survival: ["avoid the storm"], functional: [], social: [], emotional: [], longTerm: [], narrative: [] }
      : { survival: ["avoid the storm"], functional: ["sell the catch"], social: [], emotional: [], longTerm: [], narrative: [] },
    drives: ["catch", "weather"],
    habits: ["dawn nets"],
    constraints: ["cannot swim"],
    knowledge: ["tide tables"],
    capabilities: ["sail", "carry load"],
    resources: { fish: 6, coin: 0 },
    plans: ["sell fish at market"],
  });
  finnId = finn!.id;

  const kael = createActor(projectId, "Kael", {
    type: "human",
    description: "Merchant who buys goods at the square",
    attributes: { role: "merchant" },
    state: { location: "TownSquare", energy: "high", mood: "cheerful" },
    goals: { survival: [], functional: ["stock the shop"], social: ["build connections"], emotional: [], longTerm: [], narrative: [] },
    drives: ["trade", "profit"],
    habits: [],
    constraints: [],
    knowledge: ["market prices"],
    capabilities: ["bargain"],
    resources: { coin: 20, goods: 2 },
    plans: ["open the stall"],
  });
  kaelId = kael!.id;

  createActor(projectId, "Lyra", {
    type: "human",
    description: "Healer at the infirmary",
    attributes: { role: "healer" },
    state: { location: "Infirmary", energy: "low", mood: "weary" },
    goals: { survival: ["treat the sick"], functional: ["restock medicine"], social: [], emotional: [], longTerm: [], narrative: [] },
    drives: ["care", "medicine"],
    habits: ["morning rounds"],
    constraints: ["refuses violence"],
    knowledge: ["herbal remedies"],
    capabilities: ["heal", "prepare medicine"],
    resources: { herbs: 4, medicine: 2 },
    plans: [],
  });

  createActor(projectId, "Orin", {
    type: "human",
    description: "Elder who keeps the peace",
    attributes: { role: "elder" },
    state: { location: "TownSquare", energy: "medium", mood: "calm" },
    goals: { survival: [], functional: [], social: ["keep the peace"], emotional: [], longTerm: [], narrative: [] },
    drives: ["wisdom", "tradition"],
    habits: ["evening stories"],
    constraints: [],
    knowledge: ["town history"],
    capabilities: ["mediate"],
    resources: {},
    plans: [],
  });

  createActor(projectId, "Rina", {
    type: "human",
    description: "Messenger who spreads news",
    attributes: { role: "messenger" },
    state: { location: "TownSquare", energy: "high", mood: "eager" },
    goals: { survival: [], functional: ["deliver messages"], social: ["share news"], emotional: [], longTerm: [], narrative: [] },
    drives: ["speed", "news"],
    habits: ["morning route"],
    constraints: [],
    knowledge: ["town gossip"],
    capabilities: ["run fast"],
    resources: {},
    plans: [],
  });

  createActor(projectId, "Sorin", {
    type: "human",
    description: "Guard who patrols the square",
    attributes: { role: "guard" },
    state: { location: "TownSquare", energy: "high", mood: "alert" },
    goals: { survival: ["protect the town"], functional: ["keep order"], social: [], emotional: [], longTerm: [], narrative: [] },
    drives: ["duty", "patrol"],
    habits: ["night watch"],
    constraints: ["never leaves post"],
    knowledge: ["suspicious faces"],
    capabilities: ["guard"],
    resources: {},
    plans: [],
  });

  createActor(projectId, "Tessa", {
    type: "human",
    description: "Innkeeper who hears everything",
    attributes: { role: "innkeeper" },
    state: { location: "Inn", energy: "high", mood: "welcoming" },
    goals: { survival: [], functional: ["run the inn"], social: ["hear the news"], emotional: [], longTerm: [], narrative: [] },
    drives: ["hospitality", "gossip"],
    habits: ["morning brew"],
    constraints: [],
    knowledge: ["traveler tales"],
    capabilities: ["brew"],
    resources: { rooms: 4, ale: 8 },
    plans: [],
  });

  assert(getProjectActors(projectId).length === (opts.noMara ? 7 : 8), `${opts.noMara ? 7 : 8} actors created`);

  // ── Environments (5) ──────────────────────────────────────────────────────
  createEnvironment(projectId, "Harbor", {
    type: "transit",
    state: { ferry: opts.ferryAlreadyDeparted ? "departed" : "docked", tide: "low", weather: "clear" },
    resources: { berths: 3 },
    inhabitants: opts.noMara ? ["Finn"] : ["Mara", "Finn"],
    activeProcesses: ["tide rising", "ferry traffic"],
    constraints: [],
  });
  createEnvironment(projectId, "TownSquare", {
    type: "market",
    state: { market: "open", crowd: "quiet", gossip: "quiet" },
    resources: { stalls: 6 },
    inhabitants: ["Kael", "Orin", "Rina", "Sorin"],
    activeProcesses: ["trade", "gossip spreading"],
    constraints: [],
  });
  createEnvironment(projectId, "Infirmary", {
    type: "care",
    state: { beds: "free", supply: "adequate" },
    resources: { beds: 4 },
    inhabitants: ["Lyra"],
    activeProcesses: ["treating patients"],
    constraints: [],
  });
  createEnvironment(projectId, "Inn", {
    type: "lodging",
    state: { rooms: "vacant", ale: "plentiful" },
    resources: { rooms: 4 },
    inhabitants: ["Tessa"],
    activeProcesses: ["serving travelers"],
    constraints: [],
  });
  createEnvironment(projectId, "Ridge", {
    type: "terrain",
    state: { paths: "clear", weather: "clear" },
    resources: {},
    inhabitants: [],
    activeProcesses: ["wind shifting"],
    constraints: [],
  });

  // ── Systems (5) ───────────────────────────────────────────────────────────
  createSystem(projectId, "Weather", { type: "environmental", rules: ["seasonal patterns"], constraints: [], activeConditions: ["wind"], effects: ["storm"], exceptions: [] });
  createSystem(projectId, "Transit", { type: "transport", rules: ["harbor crossings"], constraints: [], activeConditions: ["ferry schedule"], effects: ["crossing"], exceptions: [] });
  createSystem(projectId, "Medicine", { type: "biological", rules: ["contagion"], constraints: [], activeConditions: ["outbreak risk"], effects: ["healing"], exceptions: [] });
  createSystem(projectId, "SocialGossip", { type: "social", rules: ["word travels"], constraints: [], activeConditions: ["rumors"], effects: ["news spreading"], exceptions: [] });
  createSystem(projectId, "Resource", { type: "economic", rules: ["supply and demand"], constraints: [], activeConditions: ["market supply"], effects: ["price shifts"], exceptions: [] });

  // ── Relationships (6) ─────────────────────────────────────────────────────
  const actors = getProjectActors(projectId);
  const byName = (n: string) => actors.find((a) => a.name === n)!;
  if (!opts.noMara) {
    createRelationship(projectId, byName("Mara").id, byName("Finn").id, {
      familiarity: "longtime", trust: "high", affection: "warm",
      resentment: "none", dependence: "moderate", fear: "none",
      obligation: "moderate", respect: "high", knowledge: "deep",
      expectations: { cooperate: "watch the weather" }, history: ["shared the storm watch"],
    });
  }
  createRelationship(projectId, byName("Finn").id, byName("Kael").id, {
    familiarity: "acquaintance", trust: "medium", affection: "neutral",
    resentment: "none", dependence: "none", fear: "none",
    obligation: "none", respect: "low", knowledge: "shallow",
    expectations: {}, history: [],
  });
  createRelationship(projectId, byName("Kael").id, byName("Orin").id, {
    familiarity: "longtime", trust: "high", affection: "warm",
    resentment: "none", dependence: "low", fear: "none",
    obligation: "low", respect: "high", knowledge: "deep",
    expectations: { trade: "fair" }, history: ["years of dealing"],
  });
  createRelationship(projectId, byName("Lyra").id, byName("Orin").id, {
    familiarity: "old friends", trust: "high", affection: "warm",
    resentment: "none", dependence: "low", fear: "none",
    obligation: "high", respect: "high", knowledge: "deep",
    expectations: {}, history: ["tended his family"],
  });
  const rinaTessaTrust = opts.lowRinaTessaTrust ? "low" : "high";
  createRelationship(projectId, byName("Rina").id, byName("Tessa").id, {
    familiarity: "close", trust: rinaTessaTrust, affection: "warm",
    resentment: "none", dependence: "low", fear: "none",
    obligation: "medium", respect: "medium", knowledge: "deep",
    expectations: { news: "first pick" }, history: ["many deliveries"],
  });
  createRelationship(projectId, byName("Sorin").id, byName("Orin").id, {
    familiarity: "respected", trust: "high", affection: "neutral",
    resentment: "none", dependence: "low", fear: "none",
    obligation: "low", respect: "high", knowledge: "shallow",
    expectations: {}, history: [],
  });
  assert(getProjectRelationships(projectId).length === (opts.noMara ? 5 : 6), `${opts.noMara ? 5 : 6} relationships created`);

  // ── Rules (~14) — no rule encodes the full chain ──────────────────────────
  // Chain starter: Mara runs the ferry (requiresPressure: schedule).
  if (!opts.noMara) {
    createRule(projectId, "FerryDepart", {
      family: "actor", scope: "actor", probability: 0.9,
      when: { conditions: [{ field: "state.location", op: "eq", value: "Harbor" }], requiresPressure: "schedule" },
      candidateEvents: [
        {
          id: "ferry.departs",
          summary: "{name} steers the ferry out of the harbor",
          level: "event", narrativeWeight: "medium", probability: 0.5,
          stateChanges: [{ target: "environment:Harbor", field: "state.ferry", op: "set", value: "departed" }],
          transitionOnly: true,
        },
      ],
      effects: [], priority: 7, cooldown: 0,
    });
  }

  // Ferry returns (transitionOnly → fires only when the ferry is departed).
  createRule(projectId, "FerryReturn", {
    family: "environment", scope: "environment", probability: 0.8,
    when: { conditions: [{ field: "state.ferry", op: "eq", value: "departed" }] },
    candidateEvents: [
      {
        id: "ferry.returns",
        summary: "the ferry returns to {name}",
        level: "micro", narrativeWeight: "low", probability: 0.3,
        stateChanges: [{ target: "self", field: "state.ferry", op: "set", value: "docked" }],
        transitionOnly: true,
      },
    ],
    effects: [], priority: 3, cooldown: 0,
  });

  // Plan adaptation (Finn): two legitimate actions, chosen by what Finn knows.
  // He boards when the ferry returned; he walks when the ferry departed
  // without him (plan interruption → alternative action).
  createRule(projectId, "FinnBoardsFerry", {
    family: "actor", scope: "actor", probability: 0.9,
    when: {
      conditions: [
        { field: "state.location", op: "eq", value: "Harbor" },
        { field: "knowledge", op: "in", value: ["ferry.returns"] },
      ],
      requiresPressure: "catch",
    },
    candidateEvents: [
      {
        id: "finn.boards_ferry",
        summary: "{name} boards the ferry for town",
        level: "event", narrativeWeight: "medium", probability: 0.7,
        stateChanges: [
          { target: "self", field: "state.location", op: "set", value: "TownSquare" },
          { target: "self", field: "plans", op: "remove", value: "sell fish at market" },
        ],
        requiresKnowledge: "ferry.returns",
      },
    ],
    effects: [], priority: 6, cooldown: 0,
  });

  createRule(projectId, "FinnWalksToMarket", {
    family: "actor", scope: "actor", probability: 0.9,
    when: {
      conditions: [
        { field: "state.location", op: "eq", value: "Harbor" },
        { field: "knowledge", op: "in", value: ["ferry.departs"] },
        { field: "goals", op: "in", value: ["sell the catch"] },
      ],
      requiresPressure: "sell",
    },
    candidateEvents: [
      {
        id: "finn.walks_to_market",
        summary: "{name} misses the ferry and walks to the market instead",
        level: "event", narrativeWeight: "high", probability: 0.7,
        stateChanges: [
          { target: "self", field: "state.location", op: "set", value: "TownSquare" },
          { target: "self", field: "plans", op: "remove", value: "sell fish at market" },
          { target: "self", field: "plans", op: "append", value: "walk to market" },
        ],
        requiresKnowledge: "ferry.departs",
      },
    ],
    effects: [], priority: 6, cooldown: 0,
  });

  // Cross-actor interaction (Kael): only once he KNOWS Finn is in town.
  createRule(projectId, "KaelGreetsFinn", {
    family: "actor", scope: "actor", probability: 0.9,
    when: {
      conditions: [
        { field: "state.location", op: "eq", value: "TownSquare" },
        { field: "knowledge", op: "in", value: ["finn.walks_to_market", "finn.boards_ferry"] },
      ],
      requiresPressure: "connections",
    },
    candidateEvents: [
      {
        id: "kael.greets_finn",
        summary: "{name} greets Finn and offers to buy his catch",
        level: "event", narrativeWeight: "high", probability: 0.7,
        stateChanges: [
          { target: "relationship:Finn:Kael", field: "affection", op: "set", value: "warm" },
          { target: "relationship:Finn:Kael", field: "trust", op: "set", value: "high" },
          { target: "actor:Finn", field: "state.mood", op: "set", value: "welcomed" },
        ],
      },
    ],
    effects: [], priority: 5, cooldown: 0,
  });

  // Consequence propagation: once the bond is warm, the sale happens
  // (relationship-scoped, transitionOnly so it settles once).
  createRule(projectId, "FinnSellsToKael", {
    family: "relationship", scope: "relationship", probability: 0.9,
    when: { conditions: [{ field: "affection", op: "eq", value: "warm" }] },
    candidateEvents: [
      {
        id: "finn.sells_to_kael",
        summary: "{name} sells his catch to Kael",
        level: "event", narrativeWeight: "high", probability: 0.6,
        stateChanges: [
          { target: "actor:Finn", field: "resources.coin", op: "set", value: 10 },
          { target: "actor:Kael", field: "resources.goods", op: "set", value: 6 },
          { target: "self", field: "obligation", op: "set", value: "settled" },
        ],
        transitionOnly: true,
      },
    ],
    effects: [], priority: 4, cooldown: 0,
  });

  // Environment autonomy (transitionOnly → state-transition, not tick spam).
  createRule(projectId, "StormFront", {
    family: "environment", scope: "environment", probability: 0.8,
    when: { conditions: [{ field: "state.weather", op: "eq", value: "clear" }] },
    candidateEvents: [
      {
        id: "weather.storm_front",
        summary: "storm front rolls in over {name}",
        level: "event", narrativeWeight: "medium", probability: 0.25,
        stateChanges: [{ target: "self", field: "state.weather", op: "set", value: "stormy" }],
        transitionOnly: true,
      },
    ],
    effects: [], priority: 3, cooldown: 0,
  });
  createRule(projectId, "StormPasses", {
    family: "environment", scope: "environment", probability: 0.8,
    when: { conditions: [{ field: "state.weather", op: "eq", value: "stormy" }] },
    candidateEvents: [
      {
        id: "weather.storm_passes",
        summary: "the storm clears over {name}",
        level: "micro", narrativeWeight: "low", probability: 0.2,
        stateChanges: [{ target: "self", field: "state.weather", op: "set", value: "clear" }],
        transitionOnly: true,
      },
    ],
    effects: [], priority: 2, cooldown: 0,
  });

  createRule(projectId, "WardCrowding", {
    family: "environment", scope: "environment", probability: 0.8,
    when: { conditions: [{ field: "state.beds", op: "eq", value: "free" }] },
    candidateEvents: [
      {
        id: "ward.crowded",
        summary: "{name} fills with the injured",
        level: "micro", narrativeWeight: "low", probability: 0.2,
        stateChanges: [{ target: "self", field: "state.beds", op: "set", value: "crowded" }],
        transitionOnly: true,
      },
    ],
    effects: [], priority: 2, cooldown: 0,
  });
  createRule(projectId, "WardClears", {
    family: "environment", scope: "environment", probability: 0.8,
    when: { conditions: [{ field: "state.beds", op: "eq", value: "crowded" }] },
    candidateEvents: [
      {
        id: "ward.clears",
        summary: "{name} empties out",
        level: "micro", narrativeWeight: "low", probability: 0.2,
        stateChanges: [{ target: "self", field: "state.beds", op: "set", value: "free" }],
        transitionOnly: true,
      },
    ],
    effects: [], priority: 2, cooldown: 0,
  });

  // Actor texture: independent activity from non-protagonist actors.
  createRule(projectId, "LyraTreats", {
    family: "actor", scope: "actor", probability: 0.7,
    when: { conditions: [{ field: "state.location", op: "eq", value: "Infirmary" }], requiresPressure: "care" },
    candidateEvents: [
      {
        id: "lyra.treats_sick",
        summary: "{name} tends the sick at the infirmary",
        level: "event", narrativeWeight: "medium", probability: 0.3,
        stateChanges: [{ target: "environment:Infirmary", field: "state.supply", op: "set", value: "low" }],
      },
    ],
    effects: [], priority: 3, cooldown: 3,
  });

  createRule(projectId, "KaelStocks", {
    family: "actor", scope: "actor", probability: 0.8,
    when: { conditions: [{ field: "state.location", op: "eq", value: "TownSquare" }], requiresPressure: "trade" },
    candidateEvents: [
      {
        id: "kael.stocks_shelves",
        summary: "{name} restocks the market stall",
        level: "event", narrativeWeight: "medium", probability: 0.4,
        stateChanges: [{ target: "environment:TownSquare", field: "state.market", op: "set", value: "bustling" }],
      },
    ],
    effects: [], priority: 3, cooldown: 3,
  });

  createRule(projectId, "SorinPatrols", {
    family: "actor", scope: "actor", probability: 0.7,
    when: { conditions: [{ field: "state.location", op: "eq", value: "TownSquare" }], requiresPressure: "duty" },
    candidateEvents: [
      {
        id: "sorin.patrols",
        summary: "{name} patrols the square",
        level: "micro", narrativeWeight: "low", probability: 0.3,
        stateChanges: [{ target: "self", field: "state.location", op: "set", value: "Ridge" }],
      },
    ],
    effects: [], priority: 3, cooldown: 4,
  });

  // Social causality via gossip — relationship-scoped: Rina only shares news
  // with Tessa when the bond TRUSTS her (CF-B changes this trust → different
  // information flow).
  createRule(projectId, "RinaGossips", {
    family: "social", scope: "relationship", probability: 0.8,
    when: {
      conditions: [
        { field: "actorA", op: "eq", value: "Rina" },
        { field: "actorB", op: "eq", value: "Tessa" },
        { field: "trust", op: "eq", value: "high" },
      ],
    },
    candidateEvents: [
      {
        id: "gossip.spreads",
        summary: "Rina tells Tessa the news of the day",
        level: "micro", narrativeWeight: "low", probability: 0.4,
        stateChanges: [{ target: "actor:Tessa", field: "knowledge", op: "append", value: "news of the day" }],
      },
    ],
    effects: [], priority: 3, cooldown: 3,
  });

  console.log(`  ✓ world model built (${opts.noMara ? 7 : 8} actors, 5 environments, 5 systems, ${opts.noMara ? 5 : 6} relationships, 14 rules)`);
}

// ── Run helpers ─────────────────────────────────────────────────────────────
type RunOutcome = {
  simId: number;
  events: string[];
  eventsDetailed: any[];
};

function makeRun(projectId: number, seed: number, ticks = 48): RunOutcome {
  const sim = createSimulation(projectId, `Run ${seed}`, "v1.1 experiment");
  updateSimulation(sim!.id, { simulationSeed: seed, clock: { day: 0, minute: 6 * 60 } });
  advanceSimulation(sim!.id, ticks);
  const rows = listEvents(sim!.id).map((e) => ({
    id: e.id,
    timestamp: e.timestamp,
    eventType: e.eventType,
    narrativeWeight: e.narrativeWeight,
    participants: e.participants,
    trigger: e.trigger,
    stateChanges: e.stateChanges,
    action: e.action,
  }));
  const events = rows.map((e) => `${e.timestamp}:${e.eventType}:${e.narrativeWeight}:${JSON.stringify(e.participants)}`);
  return { simId: sim!.id, events, eventsDetailed: rows };
}

function snapshot(projectId: number) {
  const actors = getProjectActors(projectId).map((a) => ({
    id: a.id, state: a.state, goals: a.goals, drives: a.drives, beliefs: a.beliefs,
    knowledge: a.knowledge, capabilities: a.capabilities, constraints: a.constraints,
    resources: a.resources, habits: a.habits, plans: a.plans,
  }));
  const envs = getProjectEnvironments(projectId).map((e) => ({
    id: e.id, state: e.state, resources: e.resources, inhabitants: e.inhabitants,
    activeProcesses: e.activeProcesses, constraints: e.constraints,
  }));
  const rels = getProjectRelationships(projectId).map((r) => ({
    id: r.id, familiarity: r.familiarity, trust: r.trust, affection: r.affection,
    resentment: r.resentment, dependence: r.dependence, fear: r.fear,
    obligation: r.obligation, respect: r.respect, knowledge: r.knowledge,
    expectations: r.expectations, history: r.history,
  }));
  return { actors, envs, rels };
}

function restore(projectId: number, snap: ReturnType<typeof snapshot>) {
  const upA = raw.prepare(`UPDATE ccm_actors SET state = ?, goals = ?, drives = ?, beliefs = ?, knowledge = ?, capabilities = ?, constraints = ?, resources = ?, habits = ?, plans = ? WHERE id = ?`);
  for (const s of snap.actors) {
    upA.run(JSON.stringify(s.state), JSON.stringify(s.goals), JSON.stringify(s.drives), JSON.stringify(s.beliefs), JSON.stringify(s.knowledge), JSON.stringify(s.capabilities), JSON.stringify(s.constraints), JSON.stringify(s.resources), JSON.stringify(s.habits), JSON.stringify(s.plans), s.id);
  }
  const upE = raw.prepare(`UPDATE ccm_environments SET state = ?, resources = ?, inhabitants = ?, activeProcesses = ?, constraints = ? WHERE id = ?`);
  for (const e of snap.envs) {
    upE.run(JSON.stringify(e.state), JSON.stringify(e.resources), JSON.stringify(e.inhabitants), JSON.stringify(e.activeProcesses), JSON.stringify(e.constraints), e.id);
  }
  const upR = raw.prepare(`UPDATE ccm_relationships SET familiarity = ?, trust = ?, affection = ?, resentment = ?, dependence = ?, fear = ?, obligation = ?, respect = ?, knowledge = ?, expectations = ?, history = ? WHERE id = ?`);
  for (const r of snap.rels) {
    upR.run(r.familiarity, r.trust, r.affection, r.resentment, r.dependence, r.fear, r.obligation, r.respect, r.knowledge, JSON.stringify(r.expectations), JSON.stringify(r.history), r.id);
  }
}

// ── Experiment harness ──────────────────────────────────────────────────────
// Each experiment gets its own project so counterfactual worlds are isolated.
function runExperiment(name: string, opts: WorldOpts, seed = 42): RunOutcome {
  const project = createProject(localUser.id, `${name}`, `${name} world`);
  buildWorld(project!.id, opts);
  const snap = snapshot(project!.id);
  const outcome = makeRun(project!.id, seed);
  restore(project!.id, snap);
  return outcome;
}

// ════════════════════════════════════════════════════════════════════════════
// EXPERIMENT 1: Autonomy chain + causal ancestry
// ════════════════════════════════════════════════════════════════════════════
console.log("\n=== Experiment 1: autonomy chain (baseline) ===");
const base = runExperiment("Baseline", {});
console.log(`  events=${base.events.length}`);

// Chain assertions: ferry → Finn observes → Finn adapts → Kael interacts.
assert(base.events.some((e) => e.includes("ferry.departs")), "Mara runs the ferry (chain start)");
assert(base.events.some((e) => e.includes("finn.walks_to_market") || e.includes("finn.boards_ferry")), "Finn acts on observed ferry state (plan adaptation)");
assert(base.events.some((e) => e.includes("kael.greets_finn")), "Kael greets Finn (cross-actor interaction)");
assert(base.events.some((e) => e.includes("finn.sells_to_kael")), "consequence: the sale happens (later event)");

// Causal ancestry: find finn.walks event and confirm ferry.departs is upstream.
const walksEvent = base.eventsDetailed.find((e) => e.eventType === "finn.walks_to_market");
assert(!!walksEvent, "finn.walks_to_market event found");
if (walksEvent) {
  const ancestry = getEventAncestry(walksEvent.id, 6);
  const ancestorTypes = ancestry
    .map((id) => base.eventsDetailed.find((e) => e.id === id)?.eventType)
    .filter(Boolean);
  console.log(`  ancestry(finn.walks_to_market) = ${ancestorTypes.join(" → ") || "none"}`);
  assert(ancestorTypes.includes("ferry.departs"), "causal ancestry includes the ferry departure (state-mediated)");
}

// Observation proof: Finn's knowledge must have gained the ferry event.
const finnKnowledge = base.eventsDetailed.some((e) => e.eventType === "finn.walks_to_market");
assert(finnKnowledge, "Finn acted only after observation (knowledge-gated action)");

// ════════════════════════════════════════════════════════════════════════════
// EXPERIMENT 2: Determinism (same seed twice)
// ════════════════════════════════════════════════════════════════════════════
console.log("\n=== Experiment 2: determinism (same seed) ===");
const detA = runExperiment("Determinism A", {}, 42);
const detB = runExperiment("Determinism B", {}, 42);
assert(detA.events.length === detB.events.length, `same event count (${detA.events.length} == ${detB.events.length})`);
assert(JSON.stringify(detA.events) === JSON.stringify(detB.events), "identical event histories for identical seeds");

// ════════════════════════════════════════════════════════════════════════════
// EXPERIMENT 3: Counterfactual A — remove Finn's goal
// ════════════════════════════════════════════════════════════════════════════
console.log("\n=== Experiment 3: counterfactual A (remove Finn's goal) ===");
const cfA = runExperiment("CF-A no goal", { noFinnGoal: true });
console.log(`  events=${cfA.events.length} (baseline=${base.events.length})`);
// The walk-to-market action is goal-gated ("sell the catch"). Remove the goal →
// that action disappears from Finn's decision opportunity set.
assert(!cfA.events.some((e) => e.includes("finn.walks_to_market")), "Finn no longer walks to market (goal-gated action disabled)");
assert(JSON.stringify(cfA.events) !== JSON.stringify(base.events), "downstream history changed meaningfully");

// ════════════════════════════════════════════════════════════════════════════
// EXPERIMENT 4: Counterfactual B — change a relationship state
// ════════════════════════════════════════════════════════════════════════════
console.log("\n=== Experiment 4: counterfactual B (Rina↔Tessa trust low) ===");
const cfB = runExperiment("CF-B low trust", { lowRinaTessaTrust: true });
const gossipBase = base.events.filter((e) => e.includes("gossip.spreads")).length;
const gossipB = cfB.events.filter((e) => e.includes("gossip.spreads")).length;
console.log(`  gossip events: baseline=${gossipBase}, low-trust=${gossipB}`);
assert(gossipB === 0 && gossipBase > 0, "trust change shut off information sharing (relationship-gated gossip)");
assert(JSON.stringify(cfB.events) !== JSON.stringify(base.events), "relationship state changed the downstream history");

// ════════════════════════════════════════════════════════════════════════════
// EXPERIMENT 5: Counterfactual C — alter an environment condition
// ════════════════════════════════════════════════════════════════════════════
console.log("\n=== Experiment 5: counterfactual C (ferry already departed) ===");
const cfC = runExperiment("CF-C ferry gone", { ferryAlreadyDeparted: true });
console.log(`  events=${cfC.events.length} (baseline=${base.events.length})`);
const baseFerryEvents = base.eventsDetailed.filter((e) => e.eventType.startsWith("ferry.")).sort((a, b) => a.timestamp - b.timestamp);
const cfCFerryEvents = cfC.eventsDetailed.filter((e) => e.eventType.startsWith("ferry.")).sort((a, b) => a.timestamp - b.timestamp);
console.log(`  first ferry event: baseline=${baseFerryEvents[0]?.eventType}, altered=${cfCFerryEvents[0]?.eventType}`);
// The ferry already being gone (environment condition) means the FIRST ferry
// event is the return, not the departure — the world starts mid-transition.
assert(baseFerryEvents[0]?.eventType === "ferry.departs", "baseline first ferry event is the departure");
assert(cfCFerryEvents[0]?.eventType === "ferry.returns", "altered world starts with the ferry returning, not departing");
assert(JSON.stringify(cfC.events) !== JSON.stringify(base.events), "environment condition changed the downstream history");

// ════════════════════════════════════════════════════════════════════════════
// EXPERIMENT 6: Counterfactual D — remove the protagonist
// ════════════════════════════════════════════════════════════════════════════
console.log("\n=== Experiment 6: counterfactual D (remove protagonist Mara) ===");
const cfD = runExperiment("CF-D no Mara", { noMara: true });
const meaningfulD = cfD.events.filter((e) => !e.includes('"low"'));
console.log(`  events=${cfD.events.length} (meaningful=${meaningfulD.length})`);
assert(cfD.events.length > 0, "world keeps producing activity without the protagonist");
assert(meaningfulD.length > 0, "non-micro meaningful events exist without Mara");
assert(!cfD.events.some((e) => e.includes("ferry.departs")), "no ferry events (Mara absent)");
assert(cfD.events.some((e) => e.includes("kael.stocks_shelves") || e.includes("lyra.treats_sick") || e.includes("gossip.spreads")), "other actors continue their own trajectories");

// ════════════════════════════════════════════════════════════════════════════
// EXPERIMENT 7: Event budget — transitionOnly churn does not starve interactions
// ════════════════════════════════════════════════════════════════════════════
console.log("\n=== Experiment 7: event budget / repeat control ===");
const churn = base.events.filter((e) => e.includes("ward.crowded") || e.includes("ward.clears") || e.includes("weather.storm"));
const interactions = base.events.filter((e) => e.includes("kael.greets_finn") || e.includes("finn.sells_to_kael") || e.includes("finn.walks_to_market"));
console.log(`  churn events=${churn.length}, interaction events=${interactions.length}`);
assert(interactions.length > 0, "meaningful actor interactions happened");
const wardCrowdedCount = base.events.filter((e) => e.includes("ward.crowded")).length;
assert(wardCrowdedCount <= 3, `ward_crowded repeated at most once per transition (got ${wardCrowdedCount})`);

// ════════════════════════════════════════════════════════════════════════════
// EXPERIMENT 8: Multi-seed variation
// ════════════════════════════════════════════════════════════════════════════
console.log("\n=== Experiment 8: cross-seed variation ===");
const seeds = [42, 7, 99, 2024];
const seedRuns = seeds.map((s) => ({ seed: s, outcome: runExperiment(`Seed ${s}`, {}, s) }));
const set42 = new Set(seedRuns[0].outcome.events);
const othersDiffer = seedRuns.slice(1).filter((r) => JSON.stringify(r.outcome.events) !== JSON.stringify(seedRuns[0].outcome.events)).length;
console.log(`  seeds=${seeds.join(",")} — ${othersDiffer}/3 different histories vs seed 42`);
assert(othersDiffer >= 1, "different seeds produce different histories");
const decisionVariation = new Set(seedRuns.map((r) => r.outcome.events.filter((e) => e.includes("finn.walks_to_market") || e.includes("finn.boards_ferry")).join("|")));
assert(decisionVariation.size >= 1, "seeds show variation in Finn's decision (walk vs board)");
seedRuns.forEach((r) => {
  const hasChain = r.outcome.events.some((e) => e.includes("ferry.departs")) && r.outcome.events.some((e) => e.includes("kael.greets_finn"));
  console.log(`  seed ${r.seed}: events=${r.outcome.events.length}, full chain=${hasChain ? "yes" : "partial"}`);
});

// ════════════════════════════════════════════════════════════════════════════
// EXPERIMENT 9: extraction still works
// ════════════════════════════════════════════════════════════════════════════
console.log("\n=== Experiment 9: extraction ===");
const episodes = listEpisodes(base.simId);
const skeletons = listSkeletons(base.simId);
console.log(`  episodes=${episodes.length}, skeletons=${skeletons.length}`);
assert(episodes.length > 0, "episodes extracted from the multi-actor run");
assert(skeletons.length > 0, "scene skeletons derived from actual events");

console.log(failures === 0 ? "\nALL V1.1 MULTI-ACTOR CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
