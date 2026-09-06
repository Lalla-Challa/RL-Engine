/**
 * Learning demo (Phase F, DoD #1) — reward-design bug detector.
 *
 * Trains the reference Q-learning agent on the Harmon Creek hospital pack and
 * compares it against a RandomPolicy baseline on the exact same seeds. If the
 * environment's reward signal were uninformative, no tabular method could
 * beat random — measurable improvement here is evidence the rewards work.
 *
 * Protocol:
 *   1. Validation curve: every VAL_INTERVAL episodes the CURRENT policy is
 *      evaluated greedily on fixed validation seeds. Per-episode training
 *      returns are NOT used for the curve — they are confounded by ε-decay
 *      (greedy episodes terminate sooner, shrinking raw returns even as the
 *      policy improves). Greedy validation isolates policy quality.
 *   2. Baseline: RandomPolicy (uniform over the discrete action catalog),
 *      evaluated on the same held-out evaluation seeds.
 *   3. DoD: trained policy's mean held-out return strictly exceeds baseline,
 *      and the greedy validation curve improves late-vs-early.
 *
 * Run: node --import tsx rl-engine/testing/learning-demo.ts
 */
import path from "node:path";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { loadSpecFromFile } from "../persistence/loader";
import { compileEnvironment } from "../environment/compiler";
import { createEnvironment } from "../environment/environment";
import type { Action } from "../core/types";
import { RandomPolicy } from "../rl/policy";
import { discreteActionCatalog, makeDiscretizer, QLearningTrainer, TabularQPolicy } from "../rl/qlearning";

const RL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function fsWrite(p: string, data: string): void { writeFileSync(p, data, "utf-8"); }

let failures = 0;
function assert(cond: boolean, label: string): void {
  if (cond) console.log(`  ✓ ${label}`);
  else { console.error(`  ✗ ${label}`); failures++; }
}

const TRAIN_SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];
const VALIDATION_SEEDS = [2001, 2002, 2003, 2004];
const EVAL_SEEDS = [1001, 1002, 1003, 1004, 1005, 1006, 1007, 1008];
const EPISODES = 240;
const MAX_STEPS = 100;
const VAL_INTERVAL = 12;

// Phase H: optional --spec <path> to run the difficulty certificate against a
// hardened pack (default: the standard hospital pack).
const specArgIdx = process.argv.indexOf("--spec");
const specPath = specArgIdx >= 0 ? path.resolve(process.argv[specArgIdx + 1]) : path.join(RL_ROOT, "domain-packs/harmon-creek/spec.json");
const spec = loadSpecFromFile(specPath);
const compiled = compileEnvironment(spec);
if (!compiled.ok) throw new Error("pack spec must compile: " + compiled.errors.map((e) => e.message).join("; "));

const catalog: Action[] = discreteActionCatalog(spec.actions);
const discretize = makeDiscretizer({ fields: [{ name: "ward_occupancy", buckets: 13, min: 0, max: 12 }] });
const envFactory = () => createEnvironment(spec, 42);

function evaluate(act: (obs: never) => Action, seeds: number[]): { mean: number; std: number; perSeed: number[] } {
  const returns: number[] = [];
  for (const seed of seeds) {
    const env = envFactory();
    env.reset(seed);
    let total = 0;
    for (let t = 0; t < MAX_STEPS; t++) {
      const obs = env.getState() as never;
      const r = env.step(act(obs));
      total += r.reward;
      if (r.terminated || r.truncated) break;
    }
    returns.push(total);
  }
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const std = Math.sqrt(returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length);
  return { mean, std, perSeed: returns };
}

console.log("═══ Phase F learning demo — Harmon Creek hospital pack ═══");
console.log(`discrete actions: ${catalog.map((a) => a.type).join(", ")}`);

// Phase H: certificate mode (--cert <outFile>) — run the trainer on a (possibly
// hardened) spec and dump the curve WITHOUT pass/fail assertions. Used to prove
// difficulty (non-saturation) on the hardened variant, per the audit's F3.
const certIdx = process.argv.indexOf("--cert");
const certOut = certIdx >= 0 ? process.argv[certIdx + 1] : undefined;
if (certOut) console.log(`  certificate mode: curve will be written to ${certOut} (no improvement assertions)`);

// ── Baseline: RandomPolicy on the same evaluation seeds ──────────────────────
const randomPolicy = new RandomPolicy(catalog.map((a) => a.type), 7);
const baseline = evaluate((obs) => randomPolicy.act(obs), EVAL_SEEDS);
console.log(`\nbaseline (RandomPolicy, uniform):  mean ${baseline.mean.toFixed(1)} ± ${baseline.std.toFixed(1)}  per-seed [${baseline.perSeed.map((v) => v.toFixed(0)).join(", ")}]`);

// ── Training with greedy validation curve ────────────────────────────────────
// NOTE on replayBatch: 0 — tabular Q-learning on a *stochastic* environment
// (rules fire with probability < 1, so each (s,a) has multiple outcomes) must
// not replay single-sample transitions: stale samples flatten unvisited rows
// into a degenerate fixed point (verified empirically — see diagnose-q.ts).
// Online-only is the textbook-stable configuration; the prioritized buffer is
// still built, checkpointed, and feature-tested in trainer-roundtrip.ts.
const trainer = new QLearningTrainer({ alpha: 0.3, gamma: 0.99, epsilonStart: 1.0, epsilonEnd: 0.05, epsilonDecayEpisodes: 150, replayBatch: 0, bufferCapacity: 20000, seed: 7 });
const policy = new TabularQPolicy(catalog, discretize, 7, 1.0);

const validation: { episode: number; mean: number }[] = [];
await trainer.train(envFactory, policy, {
  episodes: EPISODES,
  seeds: TRAIN_SEEDS,
  maxSteps: MAX_STEPS,
  onEpisode: (r) => {
    if ((r.episode + 1) % VAL_INTERVAL === 0) {
      validation.push({ episode: r.episode + 1, mean: evaluate((obs) => policy.greedyAct(obs), VALIDATION_SEEDS).mean });
    }
  },
});

console.log("\ngreedy validation curve (fixed seeds 2001–2004, mean return):");
const width = 46;
const lo = Math.min(...validation.map((v) => v.mean));
const hi = Math.max(...validation.map((v) => v.mean));
for (const v of validation) {
  const bars = Math.max(1, Math.round(((v.mean - lo) / Math.max(1e-9, hi - lo)) * width));
  console.log(`  ep ${String(v.episode).padStart(3)}: ${"█".repeat(bars)} ${v.mean.toFixed(1)}`);
}

const early = validation.slice(0, 5).reduce((a, v) => a + v.mean, 0) / 5;
const late = validation.slice(-5).reduce((a, v) => a + v.mean, 0) / 5;
const best = Math.max(...validation.map((v) => v.mean));
console.log(`  early (first 5 validations) ${early.toFixed(1)} → late (last 5) ${late.toFixed(1)} · best ${best.toFixed(1)}`);

// ── Held-out evaluation of the trained policy ────────────────────────────────
const trained = evaluate((obs) => policy.greedyAct(obs), EVAL_SEEDS);
console.log(`\ntrained (Q-learning, greedy):      mean ${trained.mean.toFixed(1)} ± ${trained.std.toFixed(1)}  per-seed [${trained.perSeed.map((v) => v.toFixed(0)).join(", ")}]`);

const improvement = trained.mean - baseline.mean;
console.log(`\nimprovement over baseline: ${improvement >= 0 ? "+" : ""}${improvement.toFixed(1)} (${((improvement / Math.abs(baseline.mean)) * 100).toFixed(1)}%)`);

// ── DoD assertions ───────────────────────────────────────────────────────────
if (certOut) {
  fsWrite(certOut, JSON.stringify({
    spec: spec.environment.id + "@" + spec.environment.version,
    episodes: EPISODES,
    validation,
    trainedMean: trained.mean,
    baselineMean: baseline.mean,
  }, null, 2));
  console.log(`\ncertificate written: ${certOut}`);
  console.log("CERTIFICATE MODE COMPLETE (no improvement assertions in certificate mode)");
  process.exit(0);
}

assert(trained.mean > baseline.mean, `trained mean > baseline mean (${trained.mean.toFixed(1)} > ${baseline.mean.toFixed(1)})`);
assert(late >= early, `greedy validation improves late-vs-early (${late.toFixed(1)} ≥ ${early.toFixed(1)})`);
assert(improvement > baseline.mean * 0.1, `improvement is material (>10% of baseline: ${((improvement / Math.abs(baseline.mean)) * 100).toFixed(1)}%)`);

const wins = trained.perSeed.filter((v, i) => v > baseline.perSeed[i]).length;
assert(wins >= Math.ceil(EVAL_SEEDS.length * 0.7), `trained beats baseline on ≥70% of held-out seeds (${wins}/${EVAL_SEEDS.length})`);

console.log(failures === 0 ? "\nLEARNING DEMO PASSED — reward signal is informative" : `\n${failures} CHECK(S) FAILED — suspect a reward-design bug`);
process.exit(failures === 0 ? 0 : 1);
