/**
 * Offline readiness check: node version, required files, no network needed.
 * Run: node --import tsx benchmark/scripts/verify-offline.ts
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const checks: [string, boolean][] = [
  ["node >= 22 (type stripping + stable ESM)", Number(process.versions.node.split(".")[0]) >= 22],
  ["starter spec (benchmark/scenario/spec.json)", existsSync(path.join(ROOT, "benchmark/scenario/spec.json"))],
  ["reference domain pack (rl-engine/domain-packs/harmon-creek/spec.json)", existsSync(path.join(ROOT, "rl-engine/domain-packs/harmon-creek/spec.json"))],
  ["grader (benchmark/grader/grader.ts)", existsSync(path.join(ROOT, "benchmark/grader/grader.ts"))],
  ["task prompt (benchmark/tasks/task.md)", existsSync(path.join(ROOT, "benchmark/tasks/task.md"))],
  ["frozen legacy reference (engine-core/ccm/rng.ts — FROZEN, see engine-core/FROZEN.md)", existsSync(path.join(ROOT, "engine-core/ccm/rng.ts"))],
  ["license (benchmark/LICENSE.md)", existsSync(path.join(ROOT, "benchmark/LICENSE.md"))],
  ["data license (benchmark/DATA_LICENSE.md)", existsSync(path.join(ROOT, "benchmark/DATA_LICENSE.md"))],
  ["CI workflow (.github/workflows/ci.yml)", existsSync(path.join(ROOT, ".github/workflows/ci.yml"))],
  ["versioning policy (VERSIONING.md)", existsSync(path.join(ROOT, "VERSIONING.md"))],
  ["docs (tutorial / benchmark guide / migration notes)", ["docs/tutorial.md", "docs/benchmark-guide.md", "docs/migration-from-ccm.md"].every((f) => existsSync(path.join(ROOT, f)))],
  ["security negative gate (rl-engine/testing/negative-gate.ts)", existsSync(path.join(ROOT, "rl-engine/testing/negative-gate.ts"))],
];

let fail = 0;
for (const [label, ok] of checks) {
  console.log(`  ${ok ? "✓" : "✗"} ${label}`);
  if (!ok) fail++;
}
console.log(fail === 0 ? "\nOFFLINE-READY" : `\n${fail} CHECK(S) FAILED`);
process.exit(fail === 0 ? 0 : 1);
