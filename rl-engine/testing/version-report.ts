/**
 * Version report (Phase G) — surfaces every version surface in one place:
 * engine semver, spec-format version, snapshot-format version, the Rule 4B
 * core ledger state, and content hashes for every frozen pack/scenario.
 * CI prints this first so every build is attributable.
 *
 * Run: node --import tsx rl-engine/testing/version-report.ts
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SUPPORTED_SPEC_VERSION } from "../environment/specification";
import { SNAPSHOT_VERSION } from "../environment/snapshot";

const RL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.resolve(RL_ROOT, "..");

function sha256(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

const pkg = JSON.parse(fs.readFileSync(path.join(RL_ROOT, "package.json"), "utf-8")) as { name: string; version: string };
const manifest = JSON.parse(fs.readFileSync(path.join(RL_ROOT, "domain-packs/core-manifest.json"), "utf-8")) as {
  documentedGaps: { id: string; title: string }[];
};

console.log(`engine:            ${pkg.name}@${pkg.version} (semver — see VERSIONING.md)`);
console.log(`spec format:       ${SUPPORTED_SPEC_VERSION} (SPEC_VERSION, compiler-enforced)`);
console.log(`snapshot format:   v${SNAPSHOT_VERSION}`);
console.log(`core ledger:       ${manifest.documentedGaps.length} documented gap fix(es) [${manifest.documentedGaps.map((g) => g.id).join(", ")}]`);

console.log("\nfrozen content (sha256 of canonical spec — content-hash versioning):");
const packsDir = path.join(RL_ROOT, "domain-packs");
for (const entry of fs.readdirSync(packsDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const specFile = path.join(packsDir, entry.name, "spec.json");
  if (!fs.existsSync(specFile)) continue;
  const spec = JSON.parse(fs.readFileSync(specFile, "utf-8")) as { environment: { id: string; version: string } };
  const hash = sha256(specFile);
  console.log(`  ${spec.environment.id}@${spec.environment.version}  ${hash.slice(0, 16)}…  (${path.relative(REPO_ROOT, specFile)})`);
}

const scenario = path.join(REPO_ROOT, "benchmark/scenario/spec.json");
if (fs.existsSync(scenario)) {
  console.log(`  benchmark starter  ${sha256(scenario).slice(0, 16)}…  (benchmark/scenario/spec.json)`);
}
