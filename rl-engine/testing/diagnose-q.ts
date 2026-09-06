/**
 * Diagnostic (Phase F): inspect the Q table + greedy trajectory at the
 * validation peak and after the collapse.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadSpecFromFile } from "../persistence/loader";
import { createEnvironment } from "../environment/environment";
import type { Action } from "../core/types";
import { RandomPolicy } from "../rl/policy";
import { discreteActionCatalog, makeDiscretizer, QLearningTrainer, TabularQPolicy } from "../rl/qlearning";

const RL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const spec = loadSpecFromFile(path.join(RL_ROOT, "domain-packs/harmon-creek/spec.json"));
const catalog: Action[] = discreteActionCatalog(spec.actions);
const discretize = makeDiscretizer({ fields: [{ name: "ward_occupancy", buckets: 13, min: 0, max: 12 }] });
const envFactory = () => createEnvironment(spec, 42);

const trainer = new QLearningTrainer({ alpha: 0.3, gamma: 0.99, epsilonStart: 1.0, epsilonEnd: 0.05, epsilonDecayEpisodes: 150, replayBatch: 16, bufferCapacity: 20000, seed: 7 });
const policy = new TabularQPolicy(catalog, discretize, 7, 1.0);

function greedyTrajectory(label: string): void {
  const env = envFactory();
  env.reset(2001);
  const lines: string[] = [];
  let total = 0;
  for (let t = 0; t < 100; t++) {
    const obs = env.getState() as Record<string, unknown>;
    const a = policy.greedyAct(obs as never);
    const r = env.step(a);
    total += r.reward;
    lines.push(`${t}:occ=${obs.ward_occupancy}→${a.type}(${r.reward.toFixed(1)})`);
    if (r.terminated || r.truncated) { lines.push("TERMINAL"); break; }
  }
  console.log(`\n[${label}] greedy traj (seed 2001), return=${total.toFixed(1)}:`);
  console.log("  " + lines.slice(0, 24).join(" | "));
}

const snapshots: Record<number, string> = {};
await trainer.train(envFactory, policy, {
  episodes: 240,
  seeds: [1, 2, 3, 4, 5, 6, 7, 8],
  maxSteps: 100,
  onEpisode: (r) => {
    const ep = r.episode + 1;
    if (ep === 144 || ep === 204) {
      // greedy seed-2001 return for sanity
      snapshots[ep] = policy.canonical();
    }
  },
});

const env = envFactory();
for (const ep of [144, 204]) {
  policy.restore(JSON.parse(snapshots[ep]));
  greedyTrajectory(`after ep ${ep}`);
  console.log(`[${ep}] Q table (occ rows, argmax action):`);
  const byOcc: Record<string, string> = {};
  for (const raw of policy.checkpoint().q.map((e) => e[0])) {
    const occ = raw.split("|")[0].split(":")[1];
    const row = policy.getQ(raw);
    const best = row.indexOf(Math.max(...row));
    byOcc[occ] = `${catalog[best].type}(max=${Math.max(...row).toFixed(1)}) [${row.map((v) => v.toFixed(0)).join(",")}]`;
  }
  for (const occ of Object.keys(byOcc).map(Number).sort((a, b) => a - b)) {
    console.log(`    occ ${occ}: ${byOcc[String(occ)]}`);
  }
}
void env;
