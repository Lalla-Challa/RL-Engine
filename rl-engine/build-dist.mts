/**
 * Standalone distribution build (Phase E, Path B).
 * Bundles the public entry (index.ts) and the persistence sub-entry into
 * dist/ as ESM + CJS, emits .d.ts rollups via tsc, and ships domain packs as
 * data files.
 *
 * Run: node --import tsx rl-engine/build-dist.mts
 * (esbuild + typescript are resolved from the vendored toolchain or the
 *  parent checkout — no install needed inside rl-engine itself.)
 */
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const REPO_ROOT = path.resolve(RL_ROOT, "..");
const OUT = path.join(RL_ROOT, "dist");

function resolveTool(pkgName: string): string | null {
  const bases = [
    path.join(REPO_ROOT, "node_modules"),
    path.resolve(REPO_ROOT, "..", "story-vault", "node_modules"),
    path.join(REPO_ROOT, "vendor", "node_modules"),
  ];
  for (const base of bases) {
    const pkg = path.join(base, pkgName, "package.json");
    if (fs.existsSync(pkg)) return base;
  }
  return null;
}

const esbuildBase = resolveTool("esbuild");
if (!esbuildBase) throw new Error("esbuild not found (need it in D:\\CMM-CME\\node_modules, story-vault, or vendor)");
const esbuild = createRequire(path.join(esbuildBase, "package.json"))("esbuild") as typeof import("esbuild");

async function main(): Promise<void> {
  fs.rmSync(OUT, { recursive: true, force: true });

  const entries = [
    { in: path.join(RL_ROOT, "index.ts"), out: "index" },
    { in: path.join(RL_ROOT, "persistence/index.ts"), out: "persistence/index" },
  ];

  for (const format of ["esm", "cjs"] as const) {
    await esbuild.build({
      entryPoints: entries.map((e) => ({ in: e.in, out: e.out })),
      outdir: OUT,
      bundle: true,
      platform: "node",
      format,
      target: "node22",
      sourcemap: true,
      packages: "external",
      outExtension: { ".js": format === "esm" ? ".js" : ".cjs" },
      logLevel: "silent",
    });
  }

  // .d.ts rollups via a dedicated declaration-only tsconfig.
  const tsBase = resolveTool("typescript");
  if (tsBase) {
    const tsc = path.join(tsBase, "typescript", "bin", "tsc");
    execFileSync(process.execPath, [tsc, "-p", path.join(RL_ROOT, "tsconfig.dist.json")], { stdio: "inherit" });
  } else {
    console.warn("typescript not found — dist ships without .d.ts");
  }

  // Domain packs ship as data files.
  for (const pack of fs.readdirSync(path.join(RL_ROOT, "domain-packs"), { withFileTypes: true })) {
    if (pack.isDirectory() && pack.name !== "node_modules") {
      fs.cpSync(path.join(RL_ROOT, "domain-packs", pack.name), path.join(OUT, "domain-packs", pack.name), { recursive: true });
    }
  }

  console.log(`dist built at ${OUT}`);
}

await main();
