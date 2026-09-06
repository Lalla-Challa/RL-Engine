/**
 * Standalone grading entry: reads the filed dossier and writes scores.json.
 * Run: node --import tsx benchmark/scripts/grade.ts
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { writeScores } from "../grader/grader";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const scores = writeScores(ROOT);

console.log(`scores: ${scores.total}/100 (${scores.grade})`);
for (const [phase, p] of Object.entries(scores.phases)) {
  console.log(`  ${phase}: ${p.score}/${p.max}${p.missed.length > 0 ? ` missed: ${p.missed.join(", ")}` : ""}`);
}
if (scores.failures.length > 0) console.log(`failures: ${scores.failures.join(", ")}`);
process.exit(scores.total >= 80 ? 0 : 1);
