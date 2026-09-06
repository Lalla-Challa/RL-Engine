/**
 * Fixture classification test (Phase C DoD #1).
 * The perfect dossier must score exactly 100 with zero failures; each broken
 * fixture must return its exact expected failure code — and ONLY that code.
 *
 * Run: node --import tsx benchmark/scripts/test-fixtures.ts
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { gradeDossier } from "../grader/grader";

function runTokenOf(fixture: string): string | undefined {
  try { return JSON.parse(fs.readFileSync(path.join(FIXTURES, fixture, "run-token.json"), "utf-8")).runToken as string; } catch { return undefined; }
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const FIXTURES = path.join(ROOT, "benchmark/fixtures");

const EXPECTATIONS: { fixture: string; expect: string | null; note: string }[] = [
  { fixture: "golden", expect: null, note: "perfect dossier → 100/100, zero failures" },
  { fixture: "broken-skipped-compliance", expect: "SKIPPED_COMPLIANCE", note: "constraint dropped from spec" },
  { fixture: "broken-stale-record", expect: "STALE_RECORD", note: "tampered state diverges on replay" },
  { fixture: "broken-unresolved-target", expect: "UNRESOLVED_TARGET", note: "starter defects never fixed" },
  { fixture: "broken-knowledge-violation", expect: "KNOWLEDGE_VIOLATION", note: "observation claims a ghost source" },
  { fixture: "broken-capability-violation", expect: "CAPABILITY_VIOLATION", note: "ends in repeated rejected steps" },
  { fixture: "broken-premature-filing", expect: "PREMATURE_FILING", note: "no terminal step in trajectory" },
  { fixture: "broken-budget-starvation", expect: "BUDGET_STARVATION", note: "trajectory below minimum" },
  { fixture: "broken-bluff-claim", expect: "BLUFF_CLAIM", note: "claimed chain absent from event graph" },
];

let failures = 0;
console.log("\n=== fixture classification ===");
for (const { fixture, expect, note } of EXPECTATIONS) {
  const dir = path.join(FIXTURES, fixture);
  if (!fs.existsSync(dir)) {
    console.error(`  ✗ ${fixture}: fixture missing`);
    failures++;
    continue;
  }
  const scores = gradeDossier(dir, { repoRoot: ROOT, write: false, runToken: runTokenOf(fixture) });
  if (expect === null) {
    const ok = scores.total === 100 && scores.failures.length === 0;
    if (ok) console.log(`  ✓ ${fixture}: 100/100, no failures`);
    else {
      console.error(`  ✗ ${fixture}: expected perfect, got ${scores.total}/100 failures=${scores.failures.join(",")}`);
      failures++;
    }
  } else {
    const exact = scores.failures.length === 1 && scores.failures[0] === expect;
    if (exact) console.log(`  ✓ ${fixture}: ${scores.total}/100 → ${expect} (only failure)`);
    else {
      console.error(`  ✗ ${fixture}: expected [${expect}], got [${scores.failures.join(", ")}] at ${scores.total}/100`);
      failures++;
    }
  }
}

console.log(failures === 0 ? "\nALL FIXTURES CLASSIFIED CORRECTLY" : `\n${failures} FIXTURE(S) MISCLASSIFIED`);
process.exit(failures === 0 ? 0 : 1);
