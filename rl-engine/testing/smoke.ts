/**
 * End-to-end smoke — proves the generic engine satisfies the benchmark brief.
 *
 *  1. Starter spec fails compilation with exactly 4 `unknown_target` defects
 *  2. Corrected spec compiles + validates clean
 *  3. ≥100 real step() calls across two episodes (terminated + truncated)
 *  4. Invalid action is rejected atomically (state never mutates)
 *  5. Observation ⊂ State (partial observability)
 *  6. Reward composition exposed (R = Σ component × weight)
 *  7. replay(spec, seed, actions) reproduces an identical trajectory (§27/§44)
 *  8. Dossier filed + grader emits scores.json
 *
 * Run: node --import tsx rl-engine/testing/smoke.ts
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compileEnvironment } from "../environment/compiler";
import { validateEnvironment } from "../environment/validator";
import { createEnvironment } from "../environment/environment";
import type { Environment, StepResult } from "../core/types";
import { TrajectoryRecorder } from "../episode/trajectory";
import { replay } from "../episode/replay";
import type { TrajectoryStep } from "../episode/trajectory";
import { CallCounter } from "../../benchmark/harness/call-counter";
import { gradeDossier } from "../../benchmark/grader/grader";
import { gate, trajectoryHash } from "./determinism";
import { testProperties } from "./propertyTests";
import { canonicalJson } from "../core/state";
import { mintRunToken, argsDigest, signTrace } from "../api/provenance";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

let failures = 0;
function assert(cond: boolean, label: string): void {
  if (cond) console.log(`  ✓ ${label}`);
  else { console.error(`  ✗ ${label}`); failures++; }
}

type SimpleAction = { type: string; params?: Record<string, unknown> };

// ── 1. Starter spec: exactly 4 compiler defects ─────────────────────────────
console.log("\n=== 1. starter spec defect detection (compiler §32) ===");
const starterSpec = JSON.parse(
  readFileSync(path.join(ROOT, "benchmark/scenario/spec.json"), "utf-8")
);
const starterCompiled = compileEnvironment(starterSpec);
assert(!starterCompiled.ok, "starter spec fails compilation (defects present)");
const defectErrors = starterCompiled.errors.filter((e) => e.code === "unknown_target");
assert(defectErrors.length === 4, `exactly 4 unknown_target defects (got ${defectErrors.length})`);
for (const e of defectErrors) console.log(`    · ${e.message}`);

// ── 2. Corrected spec: compiles + validates ─────────────────────────────────
console.log("\n=== 2. corrected spec compiles + validates ===");
const spec = JSON.parse(
  readFileSync(path.join(ROOT, "rl-engine/domain-packs/harmon-creek/spec.json"), "utf-8")
);
const compiled = compileEnvironment(spec);
assert(compiled.ok, "corrected spec compiles clean");
assert(compiled.warnings.length === 0 || compiled.warnings.every((w) => w.code !== "unsupported_spec_version"), "no fatal spec-version issues");
const validated = validateEnvironment(spec);
assert(validated.valid, "corrected spec passes environment validation (§33)");

// ── 3-7. Episodes ────────────────────────────────────────────────────────────
console.log("\n=== 3. episodes: termination, truncation, atomicity ===");
const env = createEnvironment(spec, 42);
const resetA = env.reset(42);
assert(resetA.observation !== undefined, "reset(42) returns an observation");

const recorder = new TrajectoryRecorder();
const counter = new CallCounter();
const actionsA: SimpleAction[] = [];

function doStep(action: SimpleAction): StepResult {
  const before = JSON.stringify(env.getState());
  const result: StepResult = env.step(action);
  counter.record(action.type, result.reward, result.terminated || result.truncated);
  if (result.info.valid === false) {
    assert(JSON.stringify(env.getState()) === before, `invalid action left state unchanged (${action.type})`);
  }
  recorder.record({
    observation: result.observation,
    action,
    reward: result.reward,
    rewardComponents: result.rewardComponents,
    nextObservation: result.observation,
    terminated: result.terminated,
    truncated: result.truncated,
    state: result.state ?? env.getState(),
  });
  actionsA.push(action);
  return result;
}

// Invalid action first — must be rejected without mutating state.
const invalid = doStep({ type: "__invalid_action__" });
assert(invalid.info.valid === false, "invalid action rejected (info.valid === false)");
assert(invalid.reward === 0, "invalid action yields zero reward");

// Episode A — admit-heavy until the ward reaches capacity → terminated.
const cycleA = ["admit_patient", "admit_patient", "admit_patient", "admit_patient", "discharge_patient", "inspect_ward"];
let terminatedA = false;
for (let i = 0; i < 200; i++) {
  const r = doStep({ type: cycleA[i % cycleA.length] });
  if (r.terminated) { terminatedA = true; break; }
  if (r.truncated) break;
}
assert(terminatedA, "episode A terminated (ward at capacity)");

// Episode B — discharge-heavy until maxSteps=100 → truncated.
env.reset(42);
const actionsB: SimpleAction[] = [];
function doStepB(action: SimpleAction): StepResult {
  const result: StepResult = env.step(action);
  counter.record(action.type, result.reward, result.terminated || result.truncated);
  recorder.record({
    observation: result.observation,
    action,
    reward: result.reward,
    rewardComponents: result.rewardComponents,
    nextObservation: result.observation,
    terminated: result.terminated,
    truncated: result.truncated,
    state: result.state ?? env.getState(),
  });
  actionsB.push(action);
  return result;
}
const cycleB = ["discharge_patient", "admit_patient", "inspect_ward", "move"];
let truncatedB = false;
for (let i = 0; i < 150; i++) {
  const type = cycleB[i % cycleB.length];
  const r = doStepB(type === "move" ? { type, params: { direction: "north" } } : { type });
  if (r.truncated) { truncatedB = true; break; }
  if (r.terminated) break;
}
assert(truncatedB, "episode B truncated at maxSteps=100");
assert(counter.getCount() >= 100, `≥100 real step() calls (got ${counter.getCount()})`);

// ── 5. Partial observability ────────────────────────────────────────────────
console.log("\n=== 4. partial observability (§17) ===");
const steps = recorder.getTrajectory();
const lastObs = steps[steps.length - 1].observation as Record<string, unknown>;
const lastState = steps[steps.length - 1].state as Record<string, unknown>;
assert(Object.keys(lastObs).length > 0, "observation is non-empty");
assert(Object.keys(lastObs).length < Object.keys(lastState).length, "Observation ⊂ State (fullyObservable: false)");

// ── 6. Reward composition ───────────────────────────────────────────────────
console.log("\n=== 5. reward composition (§18-19) ===");
const withComponents = steps.filter((s) => s.rewardComponents && Object.keys(s.rewardComponents).length > 0);
assert(withComponents.length > 0, "reward components exposed on steps");
const sample = withComponents[0];
const componentSum = Object.values(sample.rewardComponents ?? {}).reduce((a, b) => a + (b as number), 0);
assert(Math.abs(componentSum - sample.reward) < 1e-9, "reward === Σ component × weight");
console.log(`    · sample components: ${JSON.stringify(sample.rewardComponents)} → reward ${sample.reward}`);

// ── 7. Deterministic replay ─────────────────────────────────────────────────
console.log("\n=== 6. deterministic replay (§27/§44) ===");
const replayTraj = replay(spec, 42, actionsA);
const origStates = steps.slice(0, replayTraj.length).map((s) => canonicalJson(s.state));
const replayStates = replayTraj.map((s) => canonicalJson(s.state));
assert(replayTraj.length > 0, "replay produced a trajectory");
assert(
  origStates.slice(0, replayStates.length).every((s, i) => s === replayStates[i]),
  `replay(spec, seed, actions) reproduces identical trajectory (${replayStates.length} steps)`
);

// ── 7b. Determinism gate (Phase A): hash-stable trajectories across seeds ──
console.log("\n=== 6b. determinism gate (canonical hashes, §44) ===");
const gateResult = gate(spec, [42, 7], (_seed, i) => {
  const cycle = ["admit_patient", "admit_patient", "discharge_patient", "inspect_ward", "restock", "transfer_patient"];
  return { type: cycle[i % cycle.length] };
}, 60);
assert(gateResult.pass, `determinism gate passes across seeds 42,7 (hashes: ${Object.entries(gateResult.hashes).map(([s, h]) => `${s}→${h.slice(0, 8)}…`).join(" ")})`);
const goldenHash = trajectoryHash(spec, 42, actionsA);
const repeatHash = trajectoryHash(spec, 42, actionsA);
assert(goldenHash === repeatHash, "episode A trajectory hash is stable across runs");
console.log(`    · episode A hash: ${goldenHash.slice(0, 16)}…`);

// ── 7c. Property suites (Phase A, §45) ─────────────────────────────────────
console.log("\n=== 6c. property suites (§45, Phase A) ===");
const props = testProperties(spec, { seeds: [1, 7, 42], samplesPerSeed: 120 });
assert(props.pass, props.pass ? "all kernel properties hold (P1–P7)" : `property failures: ${props.failures.join("; ")}`);
for (const f of props.failures) console.error(`    · ${f}`);

// ── 8. Filing + grading (dossier v2, signed trace) ──────────────────────────
console.log("\n=== 7. dossier filing + grading ===");
const dossierDir = path.join(ROOT, "benchmark/dossier");
mkdirSync(dossierDir, { recursive: true });
// Phase H: the smoke is a trusted harness — mint a run token, sign the trace
// chain, and hand the token to the grader via run-token.json + ctx.
const runToken = mintRunToken();
const traceEntries = steps.map((s, i) => ({
  index: i + 1,
  tool: "env_step",
  argsHash: argsDigest(s.action),
  stepIndex: i + 1,
}));
writeFileSync(path.join(dossierDir, "trajectory.json"), JSON.stringify(steps, null, 2), "utf-8");
writeFileSync(path.join(dossierDir, "spec-snapshot.json"), JSON.stringify(spec, null, 2), "utf-8");
writeFileSync(path.join(dossierDir, "events.json"), JSON.stringify(env.getEvents?.() ?? [], null, 2), "utf-8");
writeFileSync(path.join(dossierDir, "manifest.json"), JSON.stringify({
  spec_id: "smoke",
  specIdentity: "harmon-creek-hospital@1.0.0",
  episodes: [{ seed: 42, steps: actionsA.length }, { seed: 42, steps: actionsB.length }],
  claimedChains: [],
}, null, 2), "utf-8");
writeFileSync(path.join(dossierDir, "trace.json"), JSON.stringify(signTrace(traceEntries, runToken), null, 2), "utf-8");
writeFileSync(path.join(dossierDir, "run-token.json"), JSON.stringify({ runToken }, null, 2), "utf-8");

const scores = gradeDossier(dossierDir, { repoRoot: ROOT, write: true, runToken });
console.log(`    · scores: ${scores.total}/100 (${scores.grade})`);
for (const [phase, p] of Object.entries(scores.phases)) {
  console.log(`    · ${phase}: ${p.score}/${p.max}${p.missed.length > 0 ? ` missed: ${p.missed.join(", ")}` : ""}`);
}
assert(scores.total >= 80, "benchmark score ≥80 (pass)");
assert(!scores.failures.includes("PROVENANCE_FAILURE"), "signed trace passes PROVENANCE_FAILURE check");
assert(scores.antiBluff.empty === false, "anti-bluff: trajectory not empty");
assert(scores.antiBluff.echoed === false, "anti-bluff: dossier not an echoed starter spec");
assert(scores.antiBluff.boilerplate === false, "anti-bluff: rewards are not boilerplate");
assert(scores.antiBluff.bluff === false, "anti-bluff: no bluff (components present on every step)");
console.log(`    · scores: ${scores.total}/100 (${scores.grade})`);
for (const [phase, p] of Object.entries(scores.phases)) {
  console.log(`    · ${phase}: ${p.score}/${p.max}${p.missed.length > 0 ? ` missed: ${p.missed.join(", ")}` : ""}`);
}
assert(scores.total >= 80, "benchmark score ≥80 (pass)");
assert(scores.antiBluff.empty === false, "anti-bluff: trajectory not empty");
assert(scores.antiBluff.echoed === false, "anti-bluff: dossier not an echoed starter spec");
assert(scores.antiBluff.boilerplate === false, "anti-bluff: rewards are not boilerplate");
assert(scores.antiBluff.bluff === false, "anti-bluff: no bluff (components present on every step)");

console.log(failures === 0 ? "\nALL GENERIC-ENGINE SMOKE CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
