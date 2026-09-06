/**
 * SQLite/SQLCipher persistence adapter (§29) — Phase E.
 *
 * Reuses the parent system's (D:\story-vault) exact connection patterns:
 * better-sqlite3-multiple-ciphers, `pragma key = "x'<hex>'"`,
 * journal_mode = WAL, busy_timeout = 5000, and scrypt-based key derivation
 * from auth.json (keySalt + PIN, N=4096) — the same scheme as the parent's
 * server/db.ts and engine-core/db-connection.ts.
 *
 * The driver is resolved lazily so the rest of the engine (and every other
 * pack/pipeline run) works with zero native dependencies.
 */

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { scryptSync } from "node:crypto";

import type { EnvironmentSpecification } from "../core/types";
import type { EngineSnapshot } from "../environment/snapshot";
import type { TrajectoryStep } from "../episode/trajectory";
import type { PersistenceAdapter, SnapshotMeta } from "./adapter";

/**
 * Node_modules bases to search for the native driver. `import.meta.url` is
 * only available in ESM; the CJS bundle falls back to process paths, so
 * resolution works identically in the repo checkout and an installed package.
 */
function driverSearchBases(explicit?: string): string[] {
  const bases: string[] = [];
  if (explicit) bases.push(explicit);
  if (process.env.RL_SQLCIPHER_DRIVER_BASE) bases.push(process.env.RL_SQLCIPHER_DRIVER_BASE);
  try {
    // ESM: resolve relative to this module's own location (works in dist too).
    bases.push(path.dirname(fileURLToPath(import.meta.url))); // dist/persistence → dist
    bases.push(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")); // dist → package root
    bases.push(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..")); // package root → node_modules
    bases.push(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..")); // → parent node_modules
  } catch {
    // non-ESM context — process cwd fallbacks below
  }
  if (typeof process !== "undefined" && process.cwd()) bases.push(path.join(process.cwd(), "node_modules"));
  return [...new Set(bases)].filter(Boolean);
}

function loadSqlCipherDriver(driverBase?: string): new (p: string) => SqliteDatabase {
  for (const base of driverSearchBases(driverBase)) {
    const pkgJson = path.join(base, "better-sqlite3-multiple-ciphers", "package.json");
    if (!fs.existsSync(pkgJson)) continue;
    try {
      const require_ = createRequire(pkgJson);
      return require_("better-sqlite3-multiple-ciphers") as new (p: string) => SqliteDatabase;
    } catch {
      // try the next base
    }
  }
  // Last resort: bare specifier (works when the caller's node_modules has it).
  try {
    const require_ = createRequire(process.cwd() + "/package.json");
    return require_("better-sqlite3-multiple-ciphers") as new (p: string) => SqliteDatabase;
  } catch {
    throw new Error(
      "better-sqlite3-multiple-ciphers not found — install it (optionalDependency of rl-engine) " +
      "or set RL_SQLCIPHER_DRIVER_BASE to a node_modules dir containing it"
    );
  }
}

type SqliteDatabase = {
  pragma(statement: string): unknown;
  prepare(sql: string): {
    run(...args: unknown[]): unknown;
    get(...args: unknown[]): unknown;
    all(...args: unknown[]): unknown[];
  };
  exec(sql: string): unknown;
  close(): void;
};

/** Derive the SQLCipher key hex exactly as the parent app does. */
export function deriveKeyHex(pin: string, auth: { keySalt: string }): string {
  return scryptSync(pin, Buffer.from(auth.keySalt, "hex"), 32, { N: 4096 }).toString("hex");
}

export type SqlCipherAdapterOptions = {
  /** Path to the database file (created if missing). */
  dbPath: string;
  /** Raw key hex (64 chars) — takes precedence over pin+authPath. */
  keyHex?: string;
  /** Vault PIN + path to auth.json (parent-app scheme). */
  pin?: string;
  authPath?: string;
  /** Optional node_modules base dir for resolving the native driver. */
  driverBase?: string;
};

export class SqlCipherPersistenceAdapter implements PersistenceAdapter {
  readonly name = "sqlcipher";
  private db: SqliteDatabase;

  constructor(private readonly options: SqlCipherAdapterOptions) {
    let keyHex = options.keyHex;
    if (!keyHex) {
      if (!options.pin || !options.authPath) {
        throw new Error("SqlCipherPersistenceAdapter: provide keyHex or pin+authPath");
      }
      const auth = JSON.parse(fs.readFileSync(options.authPath, "utf-8")) as { keySalt: string };
      keyHex = deriveKeyHex(options.pin, auth);
    }

    const Driver = loadSqlCipherDriver(options.driverBase);

    fs.mkdirSync(path.dirname(options.dbPath), { recursive: true });
    const db = new Driver(options.dbPath);
    db.pragma(`key = "x'${keyHex}'"`);
    db.pragma("journal_mode = WAL");
    db.pragma("busy_timeout = 5000");
    // Verify the key — throws on wrong key (same sanity check as the parent).
    db.prepare("SELECT count(*) AS n FROM sqlite_master").get();

    db.exec(`
      CREATE TABLE IF NOT EXISTS rl_specs (
        id TEXT NOT NULL,
        version TEXT NOT NULL,
        spec_json TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        PRIMARY KEY (id, version)
      );
      CREATE TABLE IF NOT EXISTS rl_trajectories (
        id TEXT PRIMARY KEY,
        steps_json TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE TABLE IF NOT EXISTS rl_snapshots (
        id TEXT NOT NULL,
        step_count INTEGER NOT NULL,
        state_hash TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        PRIMARY KEY (id, step_count, state_hash)
      );
      CREATE TABLE IF NOT EXISTS rl_artifacts (
        id TEXT PRIMARY KEY,
        artifact_json TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
    `);
    this.db = db;
  }

  saveSpec(spec: EnvironmentSpecification): void {
    this.db.prepare(
      "INSERT OR REPLACE INTO rl_specs (id, version, spec_json) VALUES (?, ?, ?)"
    ).run(spec.environment.id, spec.environment.version, JSON.stringify(spec));
  }
  loadSpec(id: string, version?: string): EnvironmentSpecification | null {
    const row = version !== undefined
      ? this.db.prepare("SELECT spec_json FROM rl_specs WHERE id = ? AND version = ?").get(id, version) as { spec_json: string } | undefined
      : this.db.prepare("SELECT spec_json FROM rl_specs WHERE id = ? ORDER BY updated_at DESC LIMIT 1").get(id) as { spec_json: string } | undefined;
    return row ? (JSON.parse(row.spec_json) as EnvironmentSpecification) : null;
  }

  saveTrajectory(id: string, steps: TrajectoryStep[]): void {
    this.db.prepare(
      "INSERT OR REPLACE INTO rl_trajectories (id, steps_json) VALUES (?, ?)"
    ).run(id, JSON.stringify(steps));
  }
  loadTrajectory(id: string): TrajectoryStep[] | null {
    const row = this.db.prepare("SELECT steps_json FROM rl_trajectories WHERE id = ?").get(id) as { steps_json: string } | undefined;
    return row ? (JSON.parse(row.steps_json) as TrajectoryStep[]) : null;
  }

  saveSnapshot(id: string, snapshot: EngineSnapshot): void {
    this.db.prepare(
      "INSERT OR REPLACE INTO rl_snapshots (id, step_count, state_hash, snapshot_json) VALUES (?, ?, ?, ?)"
    ).run(id, snapshot.stepCount, snapshot.stateHash, JSON.stringify(snapshot));
  }
  loadSnapshot(id: string): EngineSnapshot | null {
    const row = this.db.prepare(
      "SELECT snapshot_json FROM rl_snapshots WHERE id = ? ORDER BY step_count DESC, created_at DESC LIMIT 1"
    ).get(id) as { snapshot_json: string } | undefined;
    return row ? (JSON.parse(row.snapshot_json) as EngineSnapshot) : null;
  }
  listSnapshots(id: string): SnapshotMeta[] {
    const rows = this.db.prepare(
      "SELECT step_count, state_hash, created_at FROM rl_snapshots WHERE id = ? ORDER BY step_count ASC"
    ).all(id) as { step_count: number; state_hash: string; created_at: string }[];
    return rows.map((r) => ({
      stepCount: r.step_count,
      stateHash: r.state_hash,
      specId: id,
      savedAt: r.created_at,
    }));
  }

  saveArtifact(id: string, artifact: unknown): void {
    this.db.prepare(
      "INSERT OR REPLACE INTO rl_artifacts (id, artifact_json) VALUES (?, ?)"
    ).run(id, JSON.stringify(artifact));
  }
  loadArtifact(id: string): unknown | null {
    const row = this.db.prepare("SELECT artifact_json FROM rl_artifacts WHERE id = ?").get(id) as { artifact_json: string } | undefined;
    return row ? JSON.parse(row.artifact_json) : null;
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // already closed
    }
  }
}
