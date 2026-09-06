/**
 * Core integrity verification (Phase D, DoD #2).
 * Proves the kernel was not domain-fitted: current SHA-256 hashes of every
 * rl-engine/core file must match domain-packs/core-manifest.json. The manifest
 * records the exact, documented platform gap fixes (rule 4B) and the pre-fix
 * hashes they replaced — anything else drifting fails.
 *
 * Run: node --import tsx rl-engine/testing/core-integrity.ts [--update]
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CORE_DIR = path.join(RL_ROOT, "core");
const MANIFEST = path.join(RL_ROOT, "domain-packs/core-manifest.json");

const sha = (p: string): string => createHash("sha256").update(fs.readFileSync(p)).digest("hex");

if (process.argv.includes("--update")) {
  const files = fs.readdirSync(CORE_DIR).filter((f) => f.endsWith(".ts")).sort();
  const hashes: Record<string, string> = {};
  for (const f of files) hashes[f] = sha(path.join(CORE_DIR, f));
  const existing = fs.existsSync(MANIFEST)
    ? (JSON.parse(fs.readFileSync(MANIFEST, "utf-8")) as { documentedGaps?: unknown[] })
    : {};
  fs.writeFileSync(MANIFEST, JSON.stringify({
    _comment: "SHA-256 of rl-engine/core at the Phase D boundary (after documented gap fixes GAP-1 and GAP-2, before/without any domain-specific edits). Regenerate only when a platform-level gap fix is made and record it in documentedGaps.",
    documentedGaps: existing.documentedGaps ?? [],
    files: hashes,
  }, null, 2));
  console.log("core manifest updated:", MANIFEST);
  process.exit(0);
}

if (!fs.existsSync(MANIFEST)) {
  console.error("✗ core manifest missing — run with --update after a documented gap fix");
  process.exit(1);
}
const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf-8")) as { files: Record<string, string>; documentedGaps: unknown[] };
let bad = 0;
for (const [file, expected] of Object.entries(manifest.files)) {
  const p = path.join(CORE_DIR, file);
  if (!fs.existsSync(p)) { console.error(`  ✗ ${file}: missing`); bad++; continue; }
  const actual = sha(p);
  if (actual === expected) console.log(`  ✓ ${file}`);
  else { console.error(`  ✗ ${file}: hash drift (undocumented core change)`); bad++; }
}
const extra = fs.readdirSync(CORE_DIR).filter((f) => f.endsWith(".ts") && !(f in manifest.files));
for (const f of extra) { console.error(`  ✗ ${f}: not in manifest`); bad++; }
console.log(`documented gap fixes on record: ${manifest.documentedGaps.map((g) => (g as { id: string }).id).join(", ")}`);
console.log(bad === 0 ? "CORE INTEGRITY VERIFIED" : "CORE INTEGRITY FAILED");
process.exit(bad === 0 ? 0 : 1);
