/**
 * Grade an arbitrary dossier directory (Phase C packaging).
 * Run: node --import tsx benchmark/scripts/grade-dossier.ts <dossierDir>
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { gradeDossier } from "../grader/grader";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const dossierDir = path.resolve(process.argv[2] ?? path.join(ROOT, "benchmark/dossier"));

const scores = gradeDossier(dossierDir, { repoRoot: ROOT, write: true });

console.log(`dossier: ${path.relative(ROOT, dossierDir)}`);
console.log(`scores: ${scores.total}/100 (${scores.grade})`);
for (const [phase, p] of Object.entries(scores.phases)) {
  console.log(`  ${phase}: ${p.score}/${p.max}${p.missed.length > 0 ? ` missed: ${p.missed.join(", ")}` : ""}`);
}
if (scores.failures.length > 0) console.log(`failures: ${scores.failures.join(", ")}`);
const ab = Object.entries(scores.antiBluff).filter(([, v]) => v);
if (ab.length > 0) console.log(`anti-bluff triggers: ${ab.map(([k]) => k).join(", ")}`);
console.log(`causality: ${JSON.stringify(scores.details.causality)}`);
process.exit(scores.total >= 80 ? 0 : 1);
