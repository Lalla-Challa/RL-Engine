/**
 * Replay worker (Phase E) — a standalone process that either starts an
 * episode and checkpoints it (phase A), or loads the checkpoint into a fresh
 * process and continues it (phase B). Spawned by cross-process-replay.ts.
 *
 * The action for global step i is generated purely from (spec, i), so process
 * B continues the exact sequence process A started — and the orchestrator's
 * uninterrupted reference run replays the same script.
 *
 * Run: node --import tsx replay-worker.ts --phase A --adapter sqlcipher ...
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compileEnvironment } from "../environment/compiler";
import { createEnvironment } from "../environment/environment";
import { sha256Canonical } from "../environment/snapshot";
import type { EngineSnapshot } from "../environment/snapshot";
import type { Action } from "../core/types";
import { FilePersistenceAdapter } from "../persistence/fileAdapter";
import { SqlCipherPersistenceAdapter } from "../persistence/sqlCipherAdapter";
import type { PersistenceAdapter } from "../persistence/adapter";

function makeAction(i: number): Action {
  const cycle: Action[] = [
    { type: "receive_shipment" },
    { type: "dispatch_order" },
    { type: "move_units", params: { dims: ["A", "DISPATCH", 10] } },
    { type: "idle" },
    { type: "move_units", params: { dims: ["B", "A", 5] } },
    { type: "cycle_count" },
  ];
  return cycle[i % cycle.length];
}

type StepRecord = { index: number; stepHash: string; stateHash: string; reward: number };

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) out[argv[i].slice(2)] = argv[i + 1] ?? "";
  }
  return out;
}

function openAdapter(args: Record<string, string>): PersistenceAdapter {
  if (args.adapter === "sqlite") {
    return new SqlCipherPersistenceAdapter({ dbPath: args.store, keyHex: args.key });
  }
  return new FilePersistenceAdapter(args.store);
}

const args = parseArgs(process.argv.slice(2));
const runId = args.id;
const seed = args.seed;
const totalSteps = Number(args.total);
const phase = args.phase;

// Phase A loads the spec from disk; phase B loads it from the store itself —
// the spec must survive the process boundary through the adapter too.
let specJson: string;
if (phase === "A") {
  specJson = fs.readFileSync(args.spec, "utf-8");
} else {
  const bootAdapter = openAdapter(args);
  const snap = bootAdapter.loadSnapshot(runId);
  if (!snap) throw new Error("snapshot not found in store");
  const loaded = bootAdapter.loadSpec(snap.specId);
  if (!loaded) throw new Error(`spec ${snap.specId} not found in store — process A must saveSpec first`);
  specJson = JSON.stringify(loaded);
}
const spec = JSON.parse(specJson);
const compiled = compileEnvironment(spec);
if (!compiled.ok) throw new Error("spec does not compile: " + compiled.errors.map((e) => e.message).join("; "));

const adapter = openAdapter(args);
const env = createEnvironment(spec, seed);
env.reset(seed);

if (phase === "B") {
  const snap: EngineSnapshot | null = adapter.loadSnapshot(runId);
  if (!snap) throw new Error("snapshot not found in store");
  env.restore(snap);

  // Continuity evidence: the loaded trajectory tail is exactly the snapshot.
  const trajectory = adapter.loadTrajectory(runId);
  const lastTraj = trajectory && trajectory.length > 0 ? (trajectory[trajectory.length - 1] as { state: unknown }) : null;
  if (!lastTraj || sha256Canonical(lastTraj.state) !== snap.stateHash) {
    throw new Error("loaded trajectory tail does not match the snapshot state hash");
  }

  const record = {
    phase: "B",
    restoredStepCount: snap.stepCount,
    restoredStateHash: snap.stateHash,
    lastTrajectoryStateHash: sha256Canonical(lastTraj.state),
    continuation: [] as StepRecord[],
    finalStepCount: 0,
    truncated: false,
    terminated: false,
  };
  let i = snap.stepCount;
  for (; i < totalSteps; i++) {
    const r = env.step(makeAction(i));
    record.continuation.push({
      index: i,
      stepHash: sha256Canonical({ o: r.observation, r: r.reward, c: r.rewardComponents ?? {}, t: r.terminated, x: r.truncated, s: r.state ?? {} }),
      stateHash: sha256Canonical(r.state ?? {}),
      reward: r.reward,
    });
    if (r.terminated || r.truncated) { record.terminated = r.terminated; record.truncated = r.truncated; break; }
  }
  record.finalStepCount = i + 1;
  fs.writeFileSync(args.out, JSON.stringify(record, null, 2), "utf-8");
  console.log(`worker B done: resumed at step ${snap.stepCount} (stateHash ${snap.stateHash.slice(0, 12)}…), ran to step ${record.finalStepCount}`);
  process.exit(0);
}

// ── phase A: start the episode, persist trajectory + snapshot, exit ─────────
const stepsA = Number(args.stepsA);
const recordA = {
  phase: "A",
  specId: spec.environment.id,
  steps: [] as Array<{ index: number; stepHash: string; stateHash: string; reward: number; full: Record<string, unknown> }>,
  lastStateHash: "",
  stepCount: stepsA,
};
for (let i = 0; i < stepsA; i++) {
  const r = env.step(makeAction(i));
  recordA.steps.push({
    index: i,
    stepHash: sha256Canonical({ o: r.observation, r: r.reward, c: r.rewardComponents ?? {}, t: r.terminated, x: r.truncated, s: r.state ?? {} }),
    stateHash: sha256Canonical(r.state ?? {}),
    reward: r.reward,
    full: {
      observation: r.observation,
      action: makeAction(i),
      reward: r.reward,
      rewardComponents: r.rewardComponents,
      nextObservation: r.observation,
      terminated: r.terminated,
      truncated: r.truncated,
      state: r.state ?? {},
    },
  });
}
const snap: EngineSnapshot = env.snapshot();
if (snap.stepCount !== stepsA) throw new Error(`stepCount ${snap.stepCount} != stepsA ${stepsA}`);
recordA.lastStateHash = snap.stateHash;

adapter.saveSpec(spec);
adapter.saveTrajectory(runId, recordA.steps.map((s) => s.full as never));
adapter.saveSnapshot(runId, snap);
fs.writeFileSync(args.out, JSON.stringify({
  phase: "A",
  specId: recordA.specId,
  stepHashes: recordA.steps.map((s) => ({ index: s.index, stepHash: s.stepHash, stateHash: s.stateHash, reward: s.reward })),
  lastStateHash: recordA.lastStateHash,
  stepCount: recordA.stepCount,
}, null, 2), "utf-8");
console.log(`worker A done: ran ${stepsA} steps, checkpointed (stateHash ${snap.stateHash.slice(0, 12)}…)`);
