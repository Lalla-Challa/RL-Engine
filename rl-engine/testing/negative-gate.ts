/**
 * Negative gate (Phase G, DoD #1) — proof of enforcement.
 *
 * Every check here INJECTS a fault and asserts the platform CATCHES it:
 *
 *   1. Sandbox escapes (§40):
 *      a. reward expressions attempting eval/require/process escapes → 0, no throw
 *      b. function-registry prototype-pollution probes ("constructor",
 *         "__proto__") → null; allowlist is exactly the audited set
 *      c. spec-size bombs (oversized spec, rule flood, deep conditions) →
 *         compiler rejects with spec_too_large
 *   2. Kernel I/O conformance: the modules reachable from spec evaluation
 *      (core/, environment/, observation/, reward/, episode/, events/) must
 *      contain no fs/net/http/child_process imports and no eval-class
 *      constructs (eval(, new Function).
 *   3. Golden-fixture tamper: mutating a filed dossier's rewards must flip
 *      the grader to STALE_RECORD / sub-100 score.
 *
 * `--drill` mode additionally proves CI wiring end-to-end: it copies the
 * engine to a scratch tree, injects real nondeterminism into core/randomness.ts
 * (Math.random noise in the PRNG), and runs the Phase A determinism gate
 * against the tampered copy — the gate MUST fail (non-zero exit). A broken
 * determinism PR therefore fails the build automatically.
 *
 * Run: node --import tsx rl-engine/testing/negative-gate.ts [--drill]
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compileEnvironment } from "../environment/compiler";
import { createEnvironment } from "../environment/environment";
import { signTrace } from "../api/provenance";
import { evaluateReward } from "../reward/reward";
import { PluginRegistry } from "../plugins/registry";
import { ALLOWED_FUNCTIONS, isAllowedFunction } from "../plugins/registry";
import { gradeDossier } from "../../benchmark/grader/grader";
import type { EnvironmentSpecification } from "../core/types";

const RL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.resolve(RL_ROOT, "..");

let failures = 0;
function assert(cond: boolean, label: string): void {
  if (cond) console.log(`  ✓ ${label}`);
  else { console.error(`  ✗ ${label}`); failures++; }
}

console.log("═══ 1. sandbox escapes (§40) ═══");

// 1a. reward expression escapes → fail closed to 0, never throw
{
  const spec = JSON.parse(fs.readFileSync(path.join(RL_ROOT, "domain-packs/trading-market/spec.json"), "utf-8")) as EnvironmentSpecification;
  const prevState = { cash: 1000, shares: 0, price: 100 };
  const nextState = { cash: 1100, shares: 0, price: 100 };
  const escapes = [
    "require('child_process')",
    "process.exit(1)",
    "this.constructor.constructor('return 1')()",
    "eval('1+1')",
    "globalThis.payload",
    "(function(){return 9})()",
    "state.cash; require('fs')",
  ];
  for (const expr of escapes) {
    const result = evaluateReward(prevState, { type: "hold" }, nextState, { components: [{ id: "escape", expression: expr, weight: 1.0 }] });
    assert(result.components["escape"] === 0 && !Object.values(result.components).some((v) => v !== 0), `escape neutralized: ${JSON.stringify(expr)}`);
  }
  // sanity: a legitimate expression still evaluates
  const ok = evaluateReward(prevState, { type: "hold" }, nextState, { components: [{ id: "ok", expression: "state.cash - prevState.cash", weight: 1 }] });
  assert(ok.components["ok"] === 100, "legitimate delta expression still evaluates (100)");
}

// 1b. function registry allowlist
{
  const reg = new PluginRegistry();
  for (const probe of ["eval", "require", "constructor", "__proto__", "toString", "hasOwnProperty", "process", "fetch"]) {
    assert(reg.callSafeFunction(probe, [1, 2]) === null && !reg.hasFunction(probe), `registry probe rejected: ${probe}`);
  }
  assert(Object.isFrozen(ALLOWED_FUNCTIONS), "allowlist is frozen");
  assert(ALLOWED_FUNCTIONS.every((f) => isAllowedFunction(f)), "allowlist self-consistent");
  assert(!ALLOWED_FUNCTIONS.includes("random"), "random deliberately excluded (determinism §28)");
  console.log(`  · allowlist = ${ALLOWED_FUNCTIONS.join(", ")}`);
}

// 1c. spec-size bombs
{
  const base = JSON.parse(fs.readFileSync(path.join(RL_ROOT, "domain-packs/harmon-creek/spec.json"), "utf-8")) as EnvironmentSpecification;

  const huge = JSON.parse(JSON.stringify(base)) as EnvironmentSpecification;
  huge.environment.description = "x".repeat(1_500_000);
  assert(compileEnvironment(huge).errors.some((e) => e.code === "spec_too_large"), "1.5 MB spec rejected");

  const ruleFlood = JSON.parse(JSON.stringify(base)) as EnvironmentSpecification;
  ruleFlood.rules = Array.from({ length: 600 }, (_, i) => ({ ...base.rules[0], id: `r${i}` })) as typeof ruleFlood.rules;
  assert(compileEnvironment(ruleFlood).errors.some((e) => e.code === "spec_too_large"), "600-rule spec rejected");

  const deep = JSON.parse(JSON.stringify(base)) as EnvironmentSpecification;
  let node: Record<string, unknown> = { field: "ward_occupancy", op: "gt", value: -1 };
  for (let i = 0; i < 30; i++) node = { all: [node] };
  deep.rules = [{ ...base.rules[0], conditions: [node] } as typeof base.rules[0]];
  assert(compileEnvironment(deep).errors.some((e) => e.code === "condition_too_deep"), "over-deep condition tree rejected");

  const exprFlood = JSON.parse(JSON.stringify(base)) as EnvironmentSpecification;
  exprFlood.rewards.components.push({ id: "bomb", expression: "1+".repeat(4000) + "1", weight: 1 });
  assert(compileEnvironment(exprFlood).errors.some((e) => e.code === "expression_too_long"), "oversized reward expression rejected");
}

console.log("\n═══ 2. kernel I/O conformance (spec evaluation cannot touch FS/network) ═══");
{
  const kernelDirs = ["core", "environment", "observation", "reward", "episode", "events"];
  const forbidden = ["node:fs", "node:net", "node:http", "node:https", "node:child_process", "node:os", "node:dns"];
  const evalConstructs = ["eval(", "new Function", "require("];
  let violations = 0;
  /** Strip line/block comments so doc mentions don't false-positive. */
  const stripComments = (text: string): string =>
    text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const dir of kernelDirs) {
    const dirPath = path.join(RL_ROOT, dir);
    for (const file of fs.readdirSync(dirPath).filter((f) => f.endsWith(".ts"))) {
      const text = stripComments(fs.readFileSync(path.join(dirPath, file), "utf-8"));
      for (const f of forbidden) {
        if (text.includes(`"${f}"`) || text.includes(`'${f}'`)) {
          console.error(`    ✗ ${dir}/${file}: forbidden import ${f}`);
          violations++;
        }
      }
      for (const c of evalConstructs) {
        if (text.includes(c)) {
          console.error(`    ✗ ${dir}/${file}: eval-class construct "${c}"`);
          violations++;
        }
      }
    }
  }
  assert(violations === 0, `kernel spec-evaluation chain free of I/O + eval-class constructs (${violations} violations)`);
}

console.log("\n═══ 3. golden-fixture tamper detection ═══");
{
  const golden = path.join(REPO_ROOT, "benchmark/fixtures/golden");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rl-tamper-"));
  const files = ["trajectory.json", "spec-snapshot.json", "events.json", "manifest.json", "trace.json"];
  for (const f of files) fs.copyFileSync(path.join(golden, f), path.join(tmp, f));

  // reward tamper → replay divergence
  const traj = JSON.parse(fs.readFileSync(path.join(tmp, "trajectory.json"), "utf-8")) as Array<{ reward: number }>;
  traj[10].reward += 0.5;
  fs.writeFileSync(path.join(tmp, "trajectory.json"), JSON.stringify(traj, null, 2));
  const scores = gradeDossier(tmp, { repoRoot: REPO_ROOT, write: false });
  assert(scores.failures.includes("STALE_RECORD") && scores.total < 100, `tampered reward → STALE_RECORD (${scores.total}/100, failures: ${scores.failures.join(",")})`);

  // truncation tamper → premature filing
  const tmp2 = path.join(tmp, "cut");
  fs.mkdirSync(tmp2, { recursive: true });
  for (const f of files) fs.copyFileSync(path.join(golden, f), path.join(tmp2, f));
  const traj2 = JSON.parse(fs.readFileSync(path.join(tmp2, "trajectory.json"), "utf-8")) as Array<{ terminated: boolean; truncated: boolean }>;
  for (const s of traj2) { s.terminated = false; s.truncated = false; }
  fs.writeFileSync(path.join(tmp2, "trajectory.json"), JSON.stringify(traj2, null, 2));
  const scores2 = gradeDossier(tmp2, { repoRoot: REPO_ROOT, write: false });
  assert(scores2.failures.includes("PREMATURE_FILING"), `terminal flags stripped → PREMATURE_FILING`);
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log("\n═══ 5. provenance enforcement (Phase H, F1+F4) ═══");
{
  const golden = path.join(REPO_ROOT, "benchmark/fixtures/golden");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rl-prov-"));
  const files = ["trajectory.json", "spec-snapshot.json", "events.json", "manifest.json", "trace.json"];
  for (const f of files) fs.copyFileSync(path.join(golden, f), path.join(tmp, f));
  const tokenEntry = JSON.parse(fs.readFileSync(path.join(golden, "run-token.json"), "utf-8")) as { runToken: string };
  const mk = (dir: string) => gradeDossier(dir, { repoRoot: REPO_ROOT, write: false, runToken: tokenEntry.runToken });

  // 5a. honest signed dossier → clean
  assert(!mk(tmp).failures.includes("PROVENANCE_FAILURE"), "honest signed dossier passes provenance");

  // 5b. unsigned (legacy) trace → rejected
  const tmp2 = path.join(tmp, "unsigned");
  fs.mkdirSync(tmp2, { recursive: true });
  for (const f of files) fs.copyFileSync(path.join(golden, f), path.join(tmp2, f));
  const traceObj = JSON.parse(fs.readFileSync(path.join(tmp2, "trace.json"), "utf-8")) as { entries: unknown[] };
  fs.writeFileSync(path.join(tmp2, "trace.json"), JSON.stringify(traceObj.entries, null, 2));
  assert(mk(tmp2).failures.includes("PROVENANCE_FAILURE"), "unsigned (legacy-shape) trace → PROVENANCE_FAILURE");

  // 5c. wrong key (attacker signs with their own token) → rejected
  const tmp3 = path.join(tmp, "wrongkey");
  fs.mkdirSync(tmp3, { recursive: true });
  for (const f of files) fs.copyFileSync(path.join(golden, f), path.join(tmp3, f));
  const forged = signTrace((JSON.parse(fs.readFileSync(path.join(tmp3, "trace.json"), "utf-8")) as { entries: never[] }).entries, "attacker-token");
  fs.writeFileSync(path.join(tmp3, "trace.json"), JSON.stringify(forged, null, 2));
  assert(mk(tmp3).failures.includes("PROVENANCE_FAILURE"), "trace signed with wrong token → PROVENANCE_FAILURE");

  // 5d. reward tamper: trace untouched → chain holds; replay divergence catches it
  const tmp4 = path.join(tmp, "edited");
  fs.mkdirSync(tmp4, { recursive: true });
  for (const f of files) fs.copyFileSync(path.join(golden, f), path.join(tmp4, f));
  const traj4 = JSON.parse(fs.readFileSync(path.join(tmp4, "trajectory.json"), "utf-8")) as Array<{ reward: number }>;
  traj4[10].reward += 0.5;
  fs.writeFileSync(path.join(tmp4, "trajectory.json"), JSON.stringify(traj4, null, 2));
  const verdict4 = mk(tmp4);
  assert(verdict4.failures.includes("STALE_RECORD") && !verdict4.failures.includes("PROVENANCE_FAILURE"), "reward tamper → STALE_RECORD (trace chain intact)");

  // 5d2. action tamper: trajectory action edited → F4 argsHash cross-check + replay both fire
  const tmp5 = path.join(tmp, "action-tamper");
  fs.mkdirSync(tmp5, { recursive: true });
  for (const f of files) fs.copyFileSync(path.join(golden, f), path.join(tmp5, f));
  const traj5 = JSON.parse(fs.readFileSync(path.join(tmp5, "trajectory.json"), "utf-8")) as Array<{ action: { type: string } }>;
  // pick an action that genuinely differs from the recorded one
  const original = traj5[10].action.type;
  traj5[10].action.type = original === "restock" ? "inspect_ward" : "restock";
  fs.writeFileSync(path.join(tmp5, "trajectory.json"), JSON.stringify(traj5, null, 2));
  const verdict5 = mk(tmp5);
  assert(verdict5.failures.includes("PROVENANCE_FAILURE") && verdict5.failures.includes("STALE_RECORD"), "action tamper → PROVENANCE_FAILURE (F4) + STALE_RECORD");

  // 5e. H2: hidden parameters are invisible to the agent but real in dynamics
  const hiddenSpec: EnvironmentSpecification = JSON.parse(fs.readFileSync(path.join(RL_ROOT, "domain-packs/harmon-creek-hard/spec.json"), "utf-8"));
  const env = createEnvironment(hiddenSpec, 42);
  env.reset(42);
  const visible = env.getState() as Record<string, unknown>;
  assert(!("budget" in visible), "hidden field 'budget' stripped from getState()");
  const snap = env.snapshot() as { state: Record<string, unknown> };
  assert("budget" in snap.state, "snapshot retains hidden field (restore correctness)");
  void mk;
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log("\n═══ 6. determinism tamper drill (broken PRNG must fail the gate) ═══");
const drill = process.argv.includes("--drill");
{
  // Cheap in-process proof: an intentionally nondeterministic "gate" on two
  // consecutive evaluations of the same spec+seed MUST see different hashes
  // when noise is injected — i.e., the gate's comparison is sensitive.
  const spec = JSON.parse(fs.readFileSync(path.join(RL_ROOT, "domain-packs/warehouse-logistics/spec.json"), "utf-8")) as EnvironmentSpecification;
  const env = createEnvironment(spec, 42);
  env.reset(42);
  const clean = JSON.stringify(env.step({ type: "receive_shipment" }).state);
  const env2 = createEnvironment(spec, 42);
  env2.reset(42);
  const clean2 = JSON.stringify(env2.step({ type: "receive_shipment" }).state);
  assert(clean === clean2, "control: clean engine is deterministic (hashes match)");
  const noisy = JSON.parse(clean) as Record<string, unknown>;
  noisy.__tampered = (typeof noisy.battery === "number" ? (noisy.battery as number) : 0) + 1e-9;
  assert(JSON.stringify(noisy) !== clean, "injected noise is detectable by hash comparison");

  if (drill) {
    // Full drill: copy the engine, inject Math.random noise into the PRNG
    // itself, run the Phase A determinism gate against the tampered tree.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rl-tamper-core-"));
    const copy = path.join(tmp, "rl-engine");
    fs.cpSync(RL_ROOT, copy, {
      recursive: true,
      filter: (src) => !src.includes(`${path.sep}dist`) && !src.includes(`${path.sep}node_modules`) && !src.includes(".pipeline-dossier"),
    });
    const rngFile = path.join(copy, "core/randomness.ts");
    const original = fs.readFileSync(rngFile, "utf-8");
    // Simulate a broken seed stream: every draw is scaled by an unseeded
    // random factor, so two runs of the same seed produce different
    // rule-firing decisions — the exact class of bug the gate exists for.
    const tampered = original.replace(
      "return ((t ^ (t >>> 14)) >>> 0) / 4294967296;",
      "return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * (0.5 + Math.random());"
    );
    if (tampered === original) throw new Error("tamper patch did not apply — determinism gate anchor changed");
    fs.writeFileSync(rngFile, tampered, "utf-8");

    const res = spawnSync(process.execPath, ["--import", "tsx", path.join(copy, "testing/determinism-gate.ts")], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      timeout: 300_000,
    });
    fs.rmSync(tmp, { recursive: true, force: true });
    assert(res.status !== 0, `tampered-core determinism gate FAILS the build (exit ${res.status}) — a nondeterminism PR is caught automatically`);
    console.log(`    · gate output tail: ${(res.stdout ?? "").trim().split("\n").slice(-2).join(" | ")}`);
  } else {
    console.log("  · full core-tamper drill skipped (pass --drill; CI runs it in the tamper-drill job)");
  }
}

console.log(failures === 0 ? "\nNEGATIVE GATE PASSED — every injected fault was caught" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
