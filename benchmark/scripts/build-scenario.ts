/**
 * Freeze the starter scenario: verify the 4 deliberate defects, hash the
 * starter spec, and write the hash into scenario.json (idempotent).
 *
 * Run: node --import tsx benchmark/scripts/build-scenario.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

import { compileEnvironment } from "../../rl-engine/environment/compiler";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const specPath = path.join(ROOT, "benchmark/scenario/spec.json");

const spec = JSON.parse(readFileSync(specPath, "utf-8"));
const compiled = compileEnvironment(spec);
const defects = compiled.errors.filter((e) => e.code === "unknown_target");

if (defects.length !== 4) {
  console.error(`✗ expected 4 deliberate defects in starter spec, got ${defects.length}`);
  process.exit(1);
}

const scenarioPath = path.join(ROOT, "benchmark/scenario/scenario.json");
const scenario = JSON.parse(readFileSync(scenarioPath, "utf-8"));
scenario.starterHash = createHash("sha256").update(readFileSync(specPath)).digest("hex");
writeFileSync(scenarioPath, JSON.stringify(scenario, null, 2), "utf-8");

console.log(`✓ scenario frozen: starterHash ${scenario.starterHash.slice(0, 16)}…`);
console.log(`✓ ${defects.length} deliberate defects verified:`);
for (const d of defects) console.log(`    · ${d.message}`);
