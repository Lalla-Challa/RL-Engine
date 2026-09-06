/**
 * Determinism gate — repeatable command (Phase A).
 * Runs the reference domain pack across multiple seeds; each seed's
 * trajectory is computed twice and must hash identically (canonical JSON).
 *
 * Run: node --import tsx rl-engine/testing/determinism-gate.ts
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compileEnvironment } from "../environment/compiler";
import { loadSpecFromFile } from "../persistence/loader";
import { gate } from "./determinism";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const spec = loadSpecFromFile(path.join(ROOT, "rl-engine/domain-packs/harmon-creek/spec.json"));

const compiled = compileEnvironment(spec);
if (!compiled.ok) {
  console.error("✗ reference spec does not compile");
  for (const e of compiled.errors) console.error(`  · ${e.message}`);
  process.exit(1);
}

const result = gate(spec, [42, 7, 2024], (seed, i) => {
  // Deterministic action script per seed: admit-heavy cycle.
  const cycle = ["admit_patient", "admit_patient", "discharge_patient", "inspect_ward", "restock", "move"];
  return { type: cycle[(i + Number(seed)) % cycle.length] };
});

for (const [seed, hash] of Object.entries(result.hashes)) {
  console.log(`  seed ${seed}: ${hash.slice(0, 16)}…`);
}
if (!result.pass) {
  for (const f of result.failures) console.error(`  ✗ seed ${f.seed}: ${f.reason}`);
  console.error("\nDETERMINISM GATE FAILED");
  process.exit(1);
}
console.log("\nDETERMINISM GATE PASSED (every seed reproduced its trajectory hash twice)");
