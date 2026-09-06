/**
 * Cross-process replay verification (Phase E, DoD #1).
 *
 * Proves an episode survives a process boundary with mathematically identical
 * results:
 *
 *   Process A: start episode (warehouse pack, seed 42), run 30 steps,
 *              persist trajectory + engine snapshot → exit.
 *   Process B: fresh process — load spec + snapshot from the store, restore,
 *              continue the episode to termination/truncation.
 *   Reference: an uninterrupted in-process run of the same action script.
 *
 * Assertions:
 *   1. A's per-step hashes == reference[0..29]           (A ran honestly)
 *   2. B's restored state hash == A's final state hash   (checkpoint integrity)
 *   3. B's continuation hashes == reference[30..N-1]     (seamless resume)
 *   4. All N step hashes identical across 3 computations → N/N logged
 *
 * Run: node --import tsx rl-engine/testing/cross-process-replay.ts
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createEnvironment } from "../environment/environment";
import { sha256Canonical } from "../environment/snapshot";
import type { Action } from "../core/types";

const RL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.resolve(RL_ROOT, "..");
const WORKER = path.join(RL_ROOT, "testing/replay-worker.ts");
const SPEC = path.join(RL_ROOT, "domain-packs/warehouse-logistics/spec.json");

const SEED = "42";
const STEPS_A = 30;
const TOTAL = 120; // warehouse truncation cap

let failures = 0;
function assert(cond: boolean, label: string): void {
  if (cond) console.log(`  ✓ ${label}`);
  else { console.error(`  ✗ ${label}`); failures++; }
}

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

function runWorker(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", WORKER, ...args], {
      cwd: REPO_ROOT,
      env: { ...process.env, RL_SQLCIPHER_DRIVER_BASE: path.join(REPO_ROOT, "node_modules") },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (c) => { out += c; process.stdout.write(`      [worker] ${String(c).trim()}\n`); });
    child.stderr.on("data", (c) => process.stderr.write(`      [worker!] ${String(c).trim()}\n`));
    child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`worker exited ${code}`))));
    child.on("error", reject);
  });
}

type AResult = { stepHashes: { index: number; stepHash: string; stateHash: string }[]; lastStateHash: string; stepCount: number; specId: string };
type BResult = { restoredStepCount: number; restoredStateHash: string; continuation: { index: number; stepHash: string; stateHash: string }[]; finalStepCount: number; truncated: boolean; terminated: boolean };

async function verifyFlow(adapterName: "sqlite" | "file"): Promise<void> {
  console.log(`\n═══ cross-process replay via ${adapterName} adapter ═══`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `rl-replay-${adapterName}-`));
  const store = adapterName === "sqlite" ? path.join(tmp, "vault.db") : path.join(tmp, "store");
  const key = crypto.randomBytes(32).toString("hex");
  const runId = `warehouse-cross-process-${adapterName}`;
  const base = ["--adapter", adapterName, "--store", store, "--seed", SEED, "--total", String(TOTAL), "--id", runId];
  if (adapterName === "sqlite") base.push("--key", key);

  // ── Process A ──────────────────────────────────────────────────────────────
  const outA = path.join(tmp, "resultA.json");
  await runWorker([...base, "--phase", "A", "--spec", SPEC, "--stepsA", String(STEPS_A), "--out", outA]);
  const resultA = JSON.parse(fs.readFileSync(outA, "utf-8")) as AResult;

  // ── Process B (A is dead — only the store connects them) ──────────────────
  const outB = path.join(tmp, "resultB.json");
  await runWorker([...base, "--phase", "B", "--out", outB]);
  const resultB = JSON.parse(fs.readFileSync(outB, "utf-8")) as BResult;

  // ── Reference: uninterrupted in-process run ───────────────────────────────
  const spec = JSON.parse(fs.readFileSync(SPEC, "utf-8"));
  const env = createEnvironment(spec, SEED);
  env.reset(SEED);
  const reference: { index: number; stepHash: string; stateHash: string }[] = [];
  for (let i = 0; i < TOTAL; i++) {
    const r = env.step(makeAction(i));
    reference.push({
      index: i,
      stepHash: sha256Canonical({ o: r.observation, r: r.reward, c: r.rewardComponents ?? {}, t: r.terminated, x: r.truncated, s: r.state ?? {} }),
      stateHash: sha256Canonical(r.state ?? {}),
    });
    if (r.terminated || r.truncated) break;
  }
  const n = reference.length;
  console.log(`  reference run: ${n} steps (terminal at step ${n})`);

  // ── Assertions + hash comparison log ──────────────────────────────────────
  assert(resultA.specId === "northgate-warehouse", "process A ran the warehouse pack");
  assert(resultA.stepCount === STEPS_A, `process A checkpointed at step ${STEPS_A}`);
  assert(resultB.restoredStepCount === STEPS_A, `process B restored to step ${STEPS_A}`);

  let prefixIdentical = 0;
  for (let k = 0; k < STEPS_A; k++) {
    if (resultA.stepHashes[k].stepHash === reference[k].stepHash) prefixIdentical++;
  }
  assert(prefixIdentical === STEPS_A, `process A step hashes == reference prefix (${prefixIdentical}/${STEPS_A})`);

  assert(resultB.restoredStateHash === resultA.lastStateHash, "restored state hash == process A final state hash");

  let continuationIdentical = 0;
  const continued = resultB.continuation.length;
  for (let k = 0; k < continued; k++) {
    const ref = reference[STEPS_A + k];
    if (ref && resultB.continuation[k].stepHash === ref.stepHash) continuationIdentical++;
  }
  assert(continued > 0, `process B continued the episode (${continued} further steps to step ${resultB.finalStepCount})`);
  assert(continuationIdentical === continued && continued === n - STEPS_A, `process B continuation hashes == reference (${continuationIdentical}/${continued})`);

  // ── The hash comparison log (DoD evidence) ────────────────────────────────
  console.log("\n  per-step hash comparison (step · A · B · reference · identical):");
  const row = (k: number, who: string, h: string | undefined): string =>
    `${who}:${h ? h.slice(0, 12) : "——"}`;
  const show = [0, 1, STEPS_A - 1, STEPS_A, STEPS_A + 1, n - 2, n - 1];
  for (const k of show) {
    const inA = k < STEPS_A;
    const aHash = inA ? resultA.stepHashes[k]?.stepHash : undefined;
    const bCont = resultB.continuation[k - STEPS_A];
    const bHash = !inA && bCont ? bCont.stepHash : undefined;
    const ref = reference[k]?.stepHash;
    const hash = inA ? aHash : bHash;
    const identical = hash !== undefined && hash === ref;
    console.log(`    step ${String(k).padStart(3)} · ${row(k, "A", aHash)} · ${row(k, "B", bHash)} · ref:${ref.slice(0, 12)} · ${identical ? "IDENTICAL" : "MISMATCH"}`);
  }
  const totalIdentical = prefixIdentical + continuationIdentical;
  console.log(`  → ${totalIdentical}/${n} step hashes mathematically identical across the process boundary`);

  assert(totalIdentical === n, `all ${n} step hashes identical across processes`);
  assert(resultB.truncated || resultB.terminated, "continued episode reached a terminal state");
  fs.rmSync(tmp, { recursive: true, force: true });
}

await verifyFlow("sqlite");
await verifyFlow("file");

console.log(failures === 0 ? "\nCROSS-PROCESS REPLAY VERIFIED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
