/**
 * Pack pipeline (Phase D) — compile → validate → smoke → grade for every
 * domain pack. Proves domain-independence: this file knows nothing about any
 * specific domain; it drives each pack purely through the generic API.
 *
 * Per pack:
 *   1. compile (§32) + validate (§33)
 *   2. smoke: reset → scripted mixed-action cycle → adversarial checks
 *      (illegal actions never mutate; continuous value clamped to [min,max];
 *      multiDiscrete dims validated; multiply/divide ops actually ran)
 *   3. determinism gate (§44): trajectory hash stable across 2 runs per seed
 *   4. property suite (§45, P1–P7)
 *   5. grade a filed dossier with the Phase C forensic grader (causality from
 *      the event graph, replay verification, anti-bluff)
 *
 * Run: node --import tsx rl-engine/testing/pack-pipeline.ts [packDir ...]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compileEnvironment } from "../environment/compiler";
import { validateEnvironment } from "../environment/validator";
import { createEnvironment } from "../environment/environment";
import { gate } from "./determinism";
import { testProperties } from "./propertyTests";
import { gradeDossier } from "../../benchmark/grader/grader";
import { mintRunToken, argsDigest, signTrace } from "../api/provenance";
import type { Action, EnvironmentSpecification, StepResult } from "../core/types";

const RL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.resolve(RL_ROOT, "..");
const PACKS_DIR = path.join(RL_ROOT, "domain-packs");

let failures = 0;
function assert(cond: boolean, label: string): void {
  if (cond) console.log(`    ✓ ${label}`);
  else { console.error(`    ✗ ${label}`); failures++; }
}

function listPacks(argv: string[]): string[] {
  if (argv.length > 0) return argv.map((p) => path.resolve(p));
  return fs.readdirSync(PACKS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(PACKS_DIR, d.name, "spec.json")))
    .map((d) => path.join(PACKS_DIR, d.name));
}

function actionSpaceSummary(spec: EnvironmentSpecification): { discrete: string[]; typed: string[] } {
  const discrete: string[] = [];
  const typed: string[] = [];
  for (const a of spec.actions ?? []) {
    if (a.kind === "discrete") discrete.push(...a.actions);
    else typed.push(a.type);
  }
  return { discrete, typed };
}

/** Find a legal multiDiscrete selection for the first declared space. */
function legalMultiDiscrete(spec: EnvironmentSpecification): Action | null {
  for (const a of spec.actions ?? []) {
    if (a.kind === "multiDiscrete") {
      return { type: a.type, params: { dims: a.dims.map((d) => d.values[0]) } };
    }
  }
  return null;
}

function illegalActions(spec: EnvironmentSpecification): Action[] {
  const out: Action[] = [{ type: "__no_such_action__" }];
  for (const a of spec.actions ?? []) {
    if (a.kind === "continuous") {
      out.push({ type: a.type, value: a.max + 100 });          // out of range
      out.push({ type: a.type, value: "not-a-number" });       // wrong shape
    }
    if (a.kind === "multiDiscrete") {
      out.push({ type: a.type, params: { dims: a.dims.map(() => "ILLEGAL") } });
      out.push({ type: a.type, params: { dims: [a.dims[0].values[0]] } }); // wrong arity
    }
  }
  return out;
}

function runPack(dir: string): void {
  const name = path.basename(dir);
  console.log(`\n═══ pack: ${name} ═══`);
  const spec = JSON.parse(fs.readFileSync(path.join(dir, "spec.json"), "utf-8")) as EnvironmentSpecification;

  // ── 1. compile + validate ────────────────────────────────────────────────
  const compiled = compileEnvironment(spec);
  assert(compiled.ok, `compiles clean (§32)${compiled.ok ? "" : ": " + compiled.errors.map((e) => e.message).join("; ")}`);
  const validated = validateEnvironment(spec);
  assert(validated.valid, `environment validation passes (§33)${validated.valid ? "" : ": " + validated.errors.map((e) => e.message).join("; ")}`);
  if (!compiled.ok || !validated.valid) return;

  const { discrete, typed } = actionSpaceSummary(spec);
  const env = createEnvironment(spec, 42);
  const reset = env.reset(42);
  assert(reset.observation !== undefined, "reset returns an observation");

  // ── 2. smoke: mixed-action scripted cycle ────────────────────────────────
  const illegal = illegalActions(spec);
  let illegalRejected = 0;
  for (const bad of illegal) {
    const before = JSON.stringify(env.getState());
    const r = env.step(bad);
    if (r.info.valid === false && JSON.stringify(env.getState()) === before) illegalRejected++;
  }
  assert(illegalRejected === illegal.length, `all ${illegal.length} illegal actions rejected atomically`);

  const md = legalMultiDiscrete(spec);
  let sawMd = md === null;
  let sawContinuous = !typed.includes((spec.actions ?? []).find((a) => a.kind === "continuous")?.type ?? "");
  let continuousClamped = true;
  const continuousDef = (spec.actions ?? []).find((a) => a.kind === "continuous") as
    | { kind: "continuous"; type: string; field: string; min: number; max: number }
    | undefined;

  const cycle: Action[] = [
    ...discrete.slice(0, 3).map((t) => ({ type: t })),
    ...(md ? [md] : []),
    ...(continuousDef ? [{ type: continuousDef.type, value: (continuousDef.min + continuousDef.max) / 2 }] : []),
    ...discrete.slice(0, 2).map((t) => ({ type: t })),
  ];

  const opsSeen = new Set<string>();
  let steps = 0;
  for (let round = 0; round < 12 && steps < 400; round++) {
    for (const action of cycle) {
      const r: StepResult = env.step(action);
      if (r.info.valid === false) continue;
      steps++;
      if (action.type === md?.type) sawMd = true;
      if (continuousDef && action.type === continuousDef.type) sawContinuous = true;
      const events = env.getEvents?.() ?? [];
      const last = events[events.length - 1];
      for (const sc of last?.stateChanges ?? []) opsSeen.add(String(sc.to !== sc.from));
      if (continuousDef && action.type === continuousDef.type) {
        const v = (r.state as Record<string, unknown>)?.[continuousDef.field];
        if (typeof v === "number" && (v < continuousDef.min || v > continuousDef.max)) continuousClamped = false;
      }
      if (r.terminated || r.truncated) { env.reset(42); }
    }
  }
  assert(steps >= 40, `mixed-action cycle ran ≥40 committed steps (got ${steps})`);
  if (md) assert(sawMd, "multiDiscrete action accepted and committed");
  if (continuousDef) {
    assert(sawContinuous, "continuous action accepted");
    assert(continuousClamped, "continuous value clamped to [min,max] before effects");
  }
  const events = env.getEvents?.() ?? [];
  assert(events.length >= steps, `event log records every step (${events.length} ≥ ${steps})`);
  assert(events.some((e) => (e.causes ?? []).length >= 2), "multi-parent causal convergence exists (§25/§37)");
  void opsSeen;

  // multiply/divide actually exercised when the spec declares them
  const declaresMulDiv = (spec.rules ?? []).some((r) =>
    [...(r.effects ?? []), ...((r.outcomes ?? []).flatMap((o) => o.effects ?? []))].some((e) => e.op === "multiply" || e.op === "divide")
  );
  if (declaresMulDiv) {
    const touched = events.some((e) => e.stateChanges.some((sc) => sc.from !== sc.to && (e.effects ?? []).some((eff) => eff.op === "multiply" || eff.op === "divide")));
    assert(touched, "multiply/divide effects changed state at least once");
  }

  // ── 3. determinism gate ──────────────────────────────────────────────────
  const gateResult = gate(spec, [42, 7], (_seed, i) => cycle[i % cycle.length], 60);
  assert(gateResult.pass, `determinism gate passes (seeds 42,7; hashes ${Object.entries(gateResult.hashes).map(([s, h]) => `${s}→${h.slice(0, 8)}…`).join(" ")})`);

  // ── 4. property suite ────────────────────────────────────────────────────
  const props = testProperties(spec, { seeds: [1, 42], samplesPerSeed: 120 });
  assert(props.pass, props.pass ? "property suite P1–P7 holds" : `property failures: ${props.failures.join("; ")}`);
  for (const f of props.failures) console.error(`      · ${f}`);

  // ── 5. grade a filed dossier with the Phase C forensic grader ────────────
  const env2 = createEnvironment(spec, 42);
  env2.reset(42);
  const traj: unknown[] = [];
  let terminated = false;
  let truncated = false;
  for (let i = 0; i < 200 && !terminated && !truncated; i++) {
    const action = cycle[i % cycle.length];
    const r = env2.step(action);
    traj.push({
      observation: r.observation,
      action,
      reward: r.reward,
      rewardComponents: r.rewardComponents,
      nextObservation: r.observation,
      terminated: r.terminated,
      truncated: r.truncated,
      state: r.state ?? {},
    });
    terminated = r.terminated;
    truncated = r.truncated;
  }
  const dossierDir = path.join(dir, ".pipeline-dossier");
  fs.rmSync(dossierDir, { recursive: true, force: true });
  fs.mkdirSync(dossierDir, { recursive: true });
  // Phase H: trusted harness signs the trace and hands the token to the grader.
  const runToken = mintRunToken();
  const traceEntries = traj.map((s, i) => ({
    index: i + 1,
    tool: "env_step",
    argsHash: argsDigest((s as { action: unknown }).action),
    stepIndex: i + 1,
  }));
  fs.writeFileSync(path.join(dossierDir, "trajectory.json"), JSON.stringify(traj, null, 2), "utf-8");
  fs.writeFileSync(path.join(dossierDir, "spec-snapshot.json"), JSON.stringify(spec, null, 2), "utf-8");
  fs.writeFileSync(path.join(dossierDir, "events.json"), JSON.stringify(env2.getEvents?.() ?? [], null, 2), "utf-8");
  fs.writeFileSync(path.join(dossierDir, "manifest.json"), JSON.stringify({ spec_id: name, specIdentity: `${spec.environment.id}@${spec.environment.version}`, episodes: [{ seed: 42, steps: traj.length }], claimedChains: [] }, null, 2), "utf-8");
  fs.writeFileSync(path.join(dossierDir, "trace.json"), JSON.stringify(signTrace(traceEntries, runToken), null, 2), "utf-8");
  fs.writeFileSync(path.join(dossierDir, "run-token.json"), JSON.stringify({ runToken }, null, 2), "utf-8");
  const scores = gradeDossier(dossierDir, { repoRoot: REPO_ROOT, write: true, runToken });
  assert(scores.total >= 80, `forensic grader: ${scores.total}/100 (${scores.grade})${scores.failures.length ? " failures: " + scores.failures.join(",") : ""}`);
  console.log(`    · causality: ${JSON.stringify(scores.details.causality)}`);
}

const packs = listPacks(process.argv.slice(2));
for (const pack of packs) runPack(pack);

console.log(failures === 0 ? "\nALL PACK PIPELINE CHECKS PASSED" : `\n${failures} PACK CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
