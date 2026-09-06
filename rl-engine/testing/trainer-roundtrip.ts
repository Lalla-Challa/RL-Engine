/**
 * Checkpoint round-trip test (Phase F, DoD #2 — §45 training tier).
 *
 * Proves a Q-learning run can be saved mid-training through the Phase E
 * persistence adapters and continued in a fresh trainer with zero state loss:
 *
 *   Trainer A: 80 episodes → checkpoint → 60 more episodes → final state F_A
 *   Trainer B: fresh → load checkpoint → same 60 episodes → final state F_B
 *
 * Assertions:
 *   1. F_A and F_B are byte-identical (canonical JSON): Q table, epsilon,
 *      buffer (entries + sampling RNG), episode counter.
 *   2. Greedy evaluation of A's and B's policies on 5 held-out seeds returns
 *      identical per-seed results.
 *   3. The checkpoint round-trip through the SQLite adapter matches the file
 *      adapter (same JSON document, adapter-independent).
 *
 * Run: node --import tsx rl-engine/testing/trainer-roundtrip.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadSpecFromFile } from "../persistence/loader";
import { FilePersistenceAdapter } from "../persistence/fileAdapter";
import { SqlCipherPersistenceAdapter } from "../persistence/sqlCipherAdapter";
import { compileEnvironment } from "../environment/compiler";
import { createEnvironment } from "../environment/environment";
import { canonicalJson } from "../core/state";
import type { Action } from "../core/types";
import { discreteActionCatalog, makeDiscretizer, QLearningTrainer, TabularQPolicy } from "../rl/qlearning";

const RL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.resolve(RL_ROOT, "..");

let failures = 0;
function assert(cond: boolean, label: string): void {
  if (cond) console.log(`  ✓ ${label}`);
  else { console.error(`  ✗ ${label}`); failures++; }
}

const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const FIRST_HALF = 80;
const SECOND_HALF = 60;

function makeSetup() {
  const spec = loadSpecFromFile(path.join(RL_ROOT, "domain-packs/harmon-creek/spec.json"));
  const compiled = compileEnvironment(spec);
  if (!compiled.ok) throw new Error("pack spec must compile");
  const catalog: Action[] = discreteActionCatalog(spec.actions);
  const discretize = makeDiscretizer({ fields: [{ name: "ward_occupancy", buckets: 13, min: 0, max: 12 }] });
  const envFactory = () => createEnvironment(spec, 42);
  return { spec, catalog, discretize, envFactory };
}

function evaluateGreedy(policy: TabularQPolicy, envFactory: () => ReturnType<typeof createEnvironment>, seeds: number[]): number[] {
  const savedEpsilon = policy.epsilon;
  policy.epsilon = 0;
  const returns: number[] = [];
  for (const seed of seeds) {
    const env = envFactory();
    env.reset(seed);
    let total = 0;
    for (let t = 0; t < 100; t++) {
      const r = env.step(policy.greedyAct(env.getState() as never));
      total += r.reward;
      if (r.terminated || r.truncated) break;
    }
    returns.push(total);
  }
  policy.epsilon = savedEpsilon;
  return returns;
}

type TrainerState = ReturnType<QLearningTrainer["checkpoint"]>;

async function runAndCheckpoint(adapterName: "file" | "sqlite"): Promise<void> {
  console.log(`\n═══ checkpoint round-trip via ${adapterName} adapter ═══`);
  const { catalog, discretize, envFactory } = makeSetup();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `rl-roundtrip-${adapterName}-`));

  const adapter =
    adapterName === "sqlite"
      ? new SqlCipherPersistenceAdapter({ dbPath: path.join(tmp, "vault.db"), keyHex: "a".repeat(64) })
      : new FilePersistenceAdapter(tmp);
  const artifactId = "qlearning-harmon-creek-ckpt";

  // ── Trainer A: 80 episodes → checkpoint → 60 more ─────────────────────────
  const trainerA = new QLearningTrainer({ alpha: 0.25, gamma: 0.99, bufferCapacity: 5000, seed: 7 });
  const policyA = new TabularQPolicy(catalog, discretize, 7, 1.0);
  const curveA: number[] = [];
  await trainerA.train(envFactory, policyA, {
    episodes: FIRST_HALF,
    seeds: SEEDS,
    maxSteps: 100,
    onEpisode: (r) => curveA.push(r.return),
  });
  const midReturnsA = evaluateGreedy(policyA, envFactory, [101, 102, 103, 104, 105]);

  trainerA.attach(policyA);
  adapter.saveArtifact(artifactId, trainerA.checkpoint());

  await trainerA.train(envFactory, policyA, {
    episodes: SECOND_HALF,
    seeds: SEEDS,
    maxSteps: 100,
    onEpisode: (r) => curveA.push(r.return),
  });
  const finalA = trainerA.checkpoint();
  const evalA = evaluateGreedy(policyA, envFactory, [201, 202, 203, 204, 205]);

  // ── Trainer B: fresh → load → same 60 episodes ────────────────────────────
  const trainerB = new QLearningTrainer({ alpha: 0.25, gamma: 0.99, bufferCapacity: 5000, seed: 7 });
  const policyB = new TabularQPolicy(catalog, discretize, 7, 1.0);
  trainerB.attach(policyB);
  const loaded = adapter.loadArtifact(artifactId) as TrainerState;
  assert(loaded !== null, "checkpoint artifact loaded from store");
  assert(loaded.episodesDone === FIRST_HALF, `checkpoint carries episode counter (${loaded.episodesDone})`);
  trainerB.restore(loaded);

  const midReturnsB = evaluateGreedy(policyB, envFactory, [101, 102, 103, 104, 105]);
  assert(JSON.stringify(midReturnsA) === JSON.stringify(midReturnsB), "reloaded policy reproduces mid-training greedy returns exactly");

  await trainerB.train(envFactory, policyB, {
    episodes: SECOND_HALF,
    seeds: SEEDS,
    maxSteps: 100,
    onEpisode: () => {},
  });
  const finalB = trainerB.checkpoint();
  const evalB = evaluateGreedy(policyB, envFactory, [201, 202, 203, 204, 205]);

  // ── Assertions ────────────────────────────────────────────────────────────
  assert(finalA.episodesDone === FIRST_HALF + SECOND_HALF, `episode counter survived (${finalA.episodesDone})`);
  assert(finalB.episodesDone === finalA.episodesDone, "both trainers land on the same episode counter");
  assert(canonicalJson(finalA.policy) === canonicalJson(finalB.policy), "Q tables byte-identical after continuation");
  assert(canonicalJson(finalA.buffer) === canonicalJson(finalB.buffer), "replay buffer (entries + sampling RNG) byte-identical after continuation");
  assert(finalA.policy.epsilon === finalB.policy.epsilon, "epsilon schedule position identical");
  assert(JSON.stringify(evalA) === JSON.stringify(evalB), "greedy evaluation identical after continuation (no degradation)");

  // Adapter independence: the same artifact through the other adapter produces
  // an identical continuation.
  const other = adapterName === "sqlite"
    ? new FilePersistenceAdapter(tmp) as Pick<typeof adapter, "saveArtifact" | "loadArtifact">
    : new SqlCipherPersistenceAdapter({ dbPath: path.join(tmp, "cross.db"), keyHex: "b".repeat(64) });
  other.saveArtifact("mirror", loaded);
  const mirrored = other.loadArtifact("mirror") as TrainerState;
  assert(canonicalJson(mirrored) === canonicalJson(loaded), "checkpoint artifact is adapter-independent");
  if ("close" in adapter && typeof adapter.close === "function") adapter.close();
  if ("close" in other && typeof other.close === "function") (other as { close(): void }).close();

  console.log(`  · learning curve (first 5 / last 5 avg): ${(curveA.slice(0, 5).reduce((a, b) => a + b, 0) / 5).toFixed(1)} → ${(curveA.slice(-5).reduce((a, b) => a + b, 0) / 5).toFixed(1)}`);
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    // Windows may hold the sqlite handle briefly — best-effort cleanup
  }
}

await runAndCheckpoint("file");
await runAndCheckpoint("sqlite");

console.log(failures === 0 ? "\nCHECKPOINT ROUND-TRIP VERIFIED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
