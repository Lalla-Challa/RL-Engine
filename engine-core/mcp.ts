#!/usr/bin/env node
/**
 * Story Vault MCP Server
 *
 * A standalone MCP (Model Context Protocol) server that exposes project data
 * from an encrypted Story Vault database. Designed to work with Claude Desktop,
 * Cursor, Cline, Qwen Chat, and any MCP-compatible client.
 *
 * ## Configuration (environment variables)
 *
 *   STORY_VAULT_PIN          (required)  The vault PIN to decrypt the database.
 *   STORY_VAULT_DATA_DIR     (optional)  Path to the vault data directory.
 *                                        Defaults to `<cwd>/data`.
 *   STORY_VAULT_PROJECT_ID   (optional)  Default project ID. When set, tools
 *                                        that accept `project_id` can omit it.
 *
 * ## Transport
 *
 *   STDIO (default) — the client spawns this process directly.
 *   HTTP  set `STORY_VAULT_TRANSPORT=http` (or pass `--http`) and optionally
 *         `STORY_VAULT_PORT` (default 3100) for a Streamable HTTP transport via
 *         Express on 127.0.0.1.
 *
 * ## Security
 *
 *   The PIN is NEVER exposed to the LLM — it is only used to derive the
 *   SQLCipher database key. No user metadata, system settings, API keys, or
 *   filesystem paths are returned by any tool.
 *
 * ## Usage
 *
 *   Claude Desktop config (claude_desktop_config.json):
 *   {
 *     "mcpServers": {
 *       "story-vault": {
 *         "command": "node",
 *         "args": ["D:/story-vault/dist/mcp.js"],
 *         "env": {
 *           "STORY_VAULT_PIN": "your-pin",
 *           "STORY_VAULT_PROJECT_ID": "1"
 *         }
 *       }
 *     }
 *   }
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { localhostHostValidation, hostHeaderValidation } from "@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import express from "express";
import { scryptSync, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { eq, desc, like, and, asc } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type BetterSqlite3 from "better-sqlite3";
import { suggestTags, checkContradiction } from "./ccm/semantics";
import { CCM_CORE_LAW, CCM_SECTION_IDS, getSectionById, searchSections } from "./ccm/guidance";
import { resolveStateChangeTarget } from "./ccm/rules";
import * as storageService from "./services/storageService";
// ─── Data-layer imports (quota + dangling-span cleanup contracts) ───────────
import { deleteActor, assertValidActorName, assertUniqueActorName } from "./modules/actors/actor.data";
import { deleteEnvironment, deleteSystem, createRule, getProjectRules, getRuleById, updateRule, deleteRule, getProjectConstraints, getConstraintById, createConstraint, updateConstraint, deleteConstraint, getProjectRelationships, getRelationshipById, createRelationship, updateRelationship, deleteRelationship } from "./modules/world/world.data";
// ─── Engine / validated-write / simulation imports ──────────────────────────
import {
  proposeActorChange,
  proposeEnvironmentChange,
  proposeSystemChange,
  proposeRelationshipChange,
} from "./agent/engineProposals";
import { advanceSimulation, resetSimulation } from "./modules/simulation/run.service";
import {
  listSimulations,
  getSimulationById,
  createSimulation,
  updateSimulation,
  listEvents,
  getEventById,
  getEventAncestry,
  listEpisodes,
  listSkeletons,
  getSkeletonById,
  insertSnapshot,
  listSnapshots,
  deleteSkeleton,
} from "./modules/simulation/simulation.data";
import { renderSkeletonToProposal } from "./modules/simulation/skeletonRenderer";
import { escapeLlmText, fenceLlmContent } from "./entities";
// ─── Schema imports ──────────────────────────────────────────────────────────
import * as schema from "../drizzle/schema";
import {
  users,
  projects,
  scenes,
  sceneVersions,
  mainStoryScenes,
  ccmActors,
  ccmEnvironments,
  ccmSystems,
  ccmRelationships,
  ideas,
  projectMemory,
} from "../drizzle/schema";
import type {
  Project,
  Scene,
  Idea,
  ProjectMemory,
  CcmActor,
  CcmEnvironment,
  CcmSystem,
} from "../drizzle/schema";

// ─── Startup diagnostic log ───────────────────────────────────────────────────
// The MCP client (npx/uvx) spawns this process in an environment we don't see —
// logging startup details to a file lets us diagnose "Connection closed" from
// the client's side. Writes to `mcp-debug.log` in the current working dir, or
// alongside this bundle if cwd is not writable.
function debugLog(message: string): void {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  const targets = new Set<string>();
  if (process.env.STORY_VAULT_DATA_DIR) {
    targets.add(path.join(process.env.STORY_VAULT_DATA_DIR, "mcp-debug.log"));
  }
  targets.add(path.resolve(process.cwd(), "mcp-debug.log"));
  targets.forEach((target) => {
    try {
      fs.appendFileSync(target, line, "utf-8");
    } catch {
      // logging must never break the server
    }
  });
}

debugLog(
  `=== story-vault-mcp started ===\n` +
    `  execPath: ${process.execPath}\n` +
    `  argv: ${JSON.stringify(process.argv)}\n` +
    `  cwd: ${process.cwd()}\n` +
    `  STORY_VAULT_PIN: ${process.env.STORY_VAULT_PIN ? "SET" : "MISSING"}\n` +
    `  STORY_VAULT_DATA_DIR: ${process.env.STORY_VAULT_DATA_DIR ?? "(unset)"}\n` +
    `  STORY_VAULT_PROJECT_ID: ${process.env.STORY_VAULT_PROJECT_ID ?? "(unset)"}`
);

// ─── Config ──────────────────────────────────────────────────────────────────
/**
 * Resolve the vault data directory.
 *
 * Priority:
 *  1. `STORY_VAULT_DATA_DIR` env var (explicit, recommended).
 *  2. `<cwd>/data` (dev server runs from the repo root).
 *  3. `<server dir>/../data` — this bundle lives in `<repo>/dist/mcp.js`, so
 *     `<repo>/data` works even when the MCP client spawns the process from an
 *     unrelated working directory (Claude Desktop, npx, uvx all do this).
 *
 * The check only runs at startup; `initDb` errors clearly if none exists.
 */
function resolveDataDir(): string {
  if (process.env.STORY_VAULT_DATA_DIR) {
    return path.resolve(process.env.STORY_VAULT_DATA_DIR);
  }
  const cwdData = path.resolve(process.cwd(), "data");
  if (fs.existsSync(path.join(cwdData, "auth.json"))) return cwdData;
  // Relative to this bundle's own location. esbuild provides `__filename` in
  // the CJS npm bundle; the ESM bundle uses `import.meta.url` (file:// URL).
  const selfBase = typeof __filename === "string"
    ? path.dirname(__filename)
    : path.dirname(fileURLToPath(import.meta.url));
  const selfData = path.resolve(selfBase, "../data");
  if (fs.existsSync(path.join(selfData, "auth.json"))) return selfData;
  return cwdData;
}

const DATA_DIR = resolveDataDir();

const PIN = process.env.STORY_VAULT_PIN;
const DEFAULT_PROJECT_ID = process.env.STORY_VAULT_PROJECT_ID
  ? parseInt(process.env.STORY_VAULT_PROJECT_ID, 10)
  : null;

const TRANSPORT_MODE = process.argv.includes("--http") || process.env.STORY_VAULT_TRANSPORT === "http"
  ? "http"
  : "stdio";
const HTTP_PORT = parseInt(process.env.STORY_VAULT_PORT || "3100", 10);

// ─── Database initialization ─────────────────────────────────────────────────
// Resolve the native SQLCipher module. The require base differs between the
// ESM bundle (root dist/mcp.js) and the CJS npm bundle (mcp/npm/dist/index.cjs):
// esbuild provides `__filename` only in CJS output, so fall back to
// `import.meta.url` when it isn't present.
const require_ = createRequire(
  typeof __filename === "string" ? __filename : import.meta.url
);
const SqlCipher = require_("better-sqlite3-multiple-ciphers") as typeof BetterSqlite3;

let _sqlite: BetterSqlite3.Database | null = null;
let db: BetterSQLite3Database<typeof schema> | null = null;
let localUserId: number | null = null;

function initDb(): void {
  if (!PIN) {
    debugLog("FAIL: STORY_VAULT_PIN missing");
    console.error(
      "STORY_VAULT_PIN is required. Add it to the MCP client config (env) — " +
      "it is the same PIN you use to unlock the Story Vault app."
    );
    process.exit(1);
  }

  const authPath = path.join(DATA_DIR, "auth.json");
  if (!fs.existsSync(authPath)) {
    debugLog(`FAIL: auth.json not found at ${authPath}`);
    console.error(
      `Vault not found at: ${DATA_DIR}\n` +
      "  The app's vault lives in its data directory (e.g. D:/story-vault/data).\n" +
      "  Set STORY_VAULT_DATA_DIR to that folder in the MCP client config (env)."
    );
    process.exit(1);
  }

  const auth = JSON.parse(fs.readFileSync(authPath, "utf-8"));
  const keyHex = scryptSync(PIN, Buffer.from(auth.keySalt, "hex"), 32, { N: 4096 }).toString("hex");

  const dbPath = path.join(DATA_DIR, "story_vault.db");
  if (!fs.existsSync(dbPath)) {
    debugLog(`FAIL: story_vault.db not found at ${dbPath}`);
    console.error(
      `Database not found at: ${dbPath}\n` +
      "  Launch the Story Vault app at least once so it creates the vault."
    );
    process.exit(1);
  }
  debugLog(`OK: auth.json + story_vault.db exist in ${DATA_DIR}, opening SQLCipher DB`);

  let sqlite: BetterSqlite3.Database;
  try {
    sqlite = new SqlCipher(dbPath);
    sqlite.pragma(`key = "x'${keyHex}'"`);
  } catch (e) {
    debugLog(`FAIL: could not open SQLCipher DB: ${e instanceof Error ? e.message : String(e)}`);
    console.error("Failed to open the SQLCipher database:", e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
  // Allow concurrent access with the main app (WAL mode + busy timeout).
  // WAL change is best-effort: if the app holds the DB open in rollback mode
  // the pragma may return busy — that is fine, busy_timeout covers contention.
  try {
    sqlite.pragma("journal_mode = WAL");
  } catch {
    // ignore — busy_timeout below is the real protection
  }
  try {
    sqlite.pragma("busy_timeout = 5000");
  } catch {
    // ignore
  }
  // Verify the key is correct.
  try {
    sqlite.prepare("SELECT count(*) FROM sqlite_master").get();
    debugLog("OK: SQLCipher key verified");
  } catch {
    debugLog("FAIL: SQLCipher key verification — PIN incorrect or DB corrupted");
    console.error(
      "Failed to open the vault — the PIN is incorrect or the database is corrupted.\n" +
      "  It is the same PIN you use to unlock the Story Vault app."
    );
    process.exit(1);
  }

  _sqlite = sqlite;
  db = drizzle(sqlite, { schema });

  // Resolve the local user.
  const localUser = db.select().from(users).where(eq(users.openId, "local:primary")).get();
  if (!localUser) {
    debugLog("FAIL: no local user found in the vault");
    console.error("No local user found in the vault.");
    process.exit(1);
  }
  localUserId = localUser.id;
  debugLog(`OK: vault opened, local user id=${localUserId}`);
}

function getDb(): BetterSQLite3Database<typeof schema> {
  if (!db) throw new Error("Database not initialized");
  return db;
}

function getLocalUserId(): number {
  if (localUserId === null) throw new Error("Local user not resolved");
  return localUserId;
}

// ─── Project validation ──────────────────────────────────────────────────────
function assertProject(projectId: number): Project {
  const project = getDb().select().from(projects).where(eq(projects.id, projectId)).get();
  if (!project) throw new Error(`Project #${projectId} not found`);
  if (project.userId !== getLocalUserId()) throw new Error("Access denied");
  return project;
}

/**
 * Canon-protected fields (CCM): actor/environment/system STATE, attributes,
 * constraints, capabilities, etc. These are the fields the engine's 6-layer
 * validation gate actually governs. Direct mutation of them over MCP would
 * bypass the gate, so the raw `update_*` tools reject them and point callers
 * to the `propose_*` validated-write tools instead.
 */
const ACTOR_CANON_FIELDS = [
  "attributes", "state", "goals", "drives", "beliefs", "knowledge",
  "capabilities", "constraints", "resources", "habits", "plans",
] as const;

const ENVIRONMENT_CANON_FIELDS = [
  "attributes", "state", "resources", "inhabitants", "accessibility",
  "activeProcesses", "constraints",
] as const;

const SYSTEM_CANON_FIELDS = [
  "rules", "constraints", "activeConditions", "effects", "exceptions",
] as const;

/**
 * Throws if the caller passed any canon-protected field to a raw update tool.
 * `proposeTool` names the validated-write tool they should use instead.
 */
function rejectCanonFields(
  tool: string,
  args: Record<string, unknown>,
  canonFields: readonly string[],
  proposeTool: string
): void {
  const attempted = canonFields.filter((f) => args[f] !== undefined);
  if (attempted.length > 0) {
    throw new Error(
      `${tool} cannot directly mutate canon fields (${attempted.join(", ")}). ` +
      `Canon state is owned by the CCE engine — submit the change through ${proposeTool} so it passes the 6-layer validation gate.`
    );
  }
}

/**
 * Fuzzy name match: returns the candidate (e.g. an actor/environment name)
 * closest to `wanted` by edit distance, for "did you mean …?" hints when a
 * rule/constraint target does not resolve. Returns null when nothing is close.
 */
function fuzzySuggestion(wanted: string, candidates: string[]): string | null {
  const w = wanted.toLowerCase();
  if (!w) return null;
  let best: string | null = null;
  let bestDist = Infinity;
  const levenshtein = (a: string, b: string): number => {
    if (a === b) return 0;
    const m = a.length, n = b.length;
    if (m === 0) return n;
    if (n === 0) return m;
    const prev = Array.from({ length: n + 1 }, (_, j) => j);
    for (let i = 1; i <= m; i++) {
      let cur = i;
      let left = i - 1;
      for (let j = 1; j <= n; j++) {
        const top = prev[j];
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        const val = Math.min(cur + 1, top + 1, left + cost);
        prev[j] = val;
        left = top;
        cur = val;
      }
    }
    return prev[n];
  };
  for (const c of candidates) {
    const d = levenshtein(w, c.toLowerCase());
    if (d < bestDist) { bestDist = d; best = c; }
  }
  // Heuristic: within 2 edits, or a strict substring relationship, is "close".
  if (best && (bestDist <= 2 || w.includes(best.toLowerCase()) || best.toLowerCase().includes(w))) {
    return best;
  }
  return null;
}

/**
 * Collect every entity name the engine can target (actors, environments,
 * systems, and relationship labels) for fuzzy target validation.
 */
function worldTargetCandidates(): string[] {
  const db = getDb();
  if (!db) return [];
  const actors = db.select().from(ccmActors).all();
  const envs = db.select().from(ccmEnvironments).all();
  const systems = db.select().from(ccmSystems).all();
  return [
    ...actors.map((a) => a.name),
    ...envs.map((e) => e.name),
    ...systems.map((s) => s.name),
  ];
}

/**
 * Resolve a rule/constraint state-change target against the live world
 * (actors, environments, systems, relationships) without running a
 * simulation. Returns { ok, kind } or an unresolved result with a fuzzy hint.
 */
function resolveRuleTarget(target: string): { ok: boolean; kind: string; hint?: string } {
  const db = getDb();
  if (!db) return { ok: false, kind: "unknown" };
  const resolveName = (name: string, kind: string): { ok: boolean; kind: string; hint?: string } => {
    const table =
      kind === "actor"
        ? ccmActors
        : kind === "environment"
          ? ccmEnvironments
          : ccmSystems;
    const found = db.select({ id: (table as any).id }).from(table as any).where(eq((table as any).name, name)).get();
    if (found) return { ok: true, kind };
    const hint = fuzzySuggestion(name, worldTargetCandidates());
    return { ok: false, kind, ...(hint ? { hint: `did you mean "${hint}"?` } : {}) };
  };

  if (target === "self") return { ok: true, kind: "self" };
  if (target.startsWith("actor:")) return resolveName(target.slice("actor:".length), "actor");
  if (target.startsWith("environment:")) return resolveName(target.slice("environment:".length), "environment");
  if (target.startsWith("system:")) return resolveName(target.slice("system:".length), "system");
  if (target.startsWith("relationship:")) {
    const [a, b] = target.slice("relationship:".length).split(":");
    const rel = db.select().from(ccmRelationships).all().find(
      (r) =>
        (db.select({ name: ccmActors.name }).from(ccmActors).where(eq(ccmActors.id, r.actorAId)).get()?.name === a &&
         db.select({ name: ccmActors.name }).from(ccmActors).where(eq(ccmActors.id, r.actorBId)).get()?.name === b) ||
        (db.select({ name: ccmActors.name }).from(ccmActors).where(eq(ccmActors.id, r.actorAId)).get()?.name === b &&
         db.select({ name: ccmActors.name }).from(ccmActors).where(eq(ccmActors.id, r.actorBId)).get()?.name === a)
    );
    if (rel) return { ok: true, kind: "relationship" };
    return { ok: false, kind: "relationship", hint: "relationship actors must both exist" };
  }
  // Bare actor/environment/system name fallback.
  const bare = resolveName(target, "actor");
  if (bare.ok) return bare;
  const envBare = resolveName(target, "environment");
  if (envBare.ok) return envBare;
  return resolveName(target, "system");
}

// ─── DTO helpers (strip sensitive fields) ────────────────────────────────────
/** Converts a Drizzle timestamp (Date, or raw epoch-seconds number) to ISO. */
function ts(value: Date | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return new Date(value * 1000).toISOString();
}

type SafeProject = { id: number; title: string; description: string | null; createdAt: string; updatedAt: string };
function toProject(p: Project): SafeProject {
  return {
    id: p.id,
    title: p.title,
    description: p.description,
    createdAt: ts(p.createdAt) ?? "",
    updatedAt: ts(p.updatedAt) ?? "",
  };
}

type SafeScene = { id: number; projectId: number; title: string; description: string | null; status: string; wordCount: number; createdAt: string; updatedAt: string };
function toScene(s: Scene): SafeScene {
  return {
    id: s.id,
    projectId: s.projectId,
    title: s.title,
    description: s.description,
    status: s.status,
    wordCount: s.wordCount,
    createdAt: ts(s.createdAt) ?? "",
    updatedAt: ts(s.updatedAt) ?? "",
  };
}

type SafeActor = {
  id: number; projectId: number; name: string; type: string;
  description: string | null; notes: string | null;
  attributes: unknown; state: unknown; goals: unknown; drives: unknown;
  beliefs: unknown; knowledge: unknown; capabilities: unknown;
  constraints: unknown; resources: unknown; habits: unknown; plans: unknown;
  createdAt: string; updatedAt: string;
};
function toActor(a: CcmActor): SafeActor {
  return {
    id: a.id,
    projectId: a.projectId,
    name: escapeLlmText(a.name),
    type: escapeLlmText(a.type),
    description: escapeLlmText(a.description ?? ""),
    notes: escapeLlmText(a.notes ?? ""),
    attributes: a.attributes,
    state: a.state,
    goals: a.goals,
    drives: a.drives,
    beliefs: a.beliefs,
    knowledge: a.knowledge,
    capabilities: a.capabilities,
    constraints: a.constraints,
    resources: a.resources,
    habits: a.habits,
    plans: a.plans,
    createdAt: ts(a.createdAt) ?? "",
    updatedAt: ts(a.updatedAt) ?? "",
  };
}

type SafeEnvironment = {
  id: number; projectId: number; name: string; type: string;
  attributes: unknown; state: unknown; resources: unknown; inhabitants: unknown;
  accessibility: unknown; activeProcesses: unknown; constraints: unknown;
  createdAt: string; updatedAt: string;
};
function toEnvironment(e: CcmEnvironment): SafeEnvironment {
  return {
    id: e.id,
    projectId: e.projectId,
    name: escapeLlmText(e.name),
    type: escapeLlmText(e.type),
    attributes: e.attributes,
    state: e.state,
    resources: e.resources,
    inhabitants: e.inhabitants,
    accessibility: e.accessibility,
    activeProcesses: e.activeProcesses,
    constraints: e.constraints,
    createdAt: ts(e.createdAt) ?? "",
    updatedAt: ts(e.updatedAt) ?? "",
  };
}

type SafeSystem = {
  id: number; projectId: number; name: string; type: string;
  rules: unknown; constraints: unknown; activeConditions: unknown;
  effects: unknown; exceptions: unknown;
  createdAt: string; updatedAt: string;
};
function toSystem(s: CcmSystem): SafeSystem {
  return {
    id: s.id,
    projectId: s.projectId,
    name: escapeLlmText(s.name),
    type: escapeLlmText(s.type),
    rules: s.rules,
    constraints: s.constraints,
    activeConditions: s.activeConditions,
    effects: s.effects,
    exceptions: s.exceptions,
    createdAt: ts(s.createdAt) ?? "",
    updatedAt: ts(s.updatedAt) ?? "",
  };
}

type SafeIdea = { id: number; projectId: number; title: string; content: string; status: string; linkedSceneId: number | null; createdAt: string; updatedAt: string };
function toIdea(i: Idea): SafeIdea {
  return {
    id: i.id,
    projectId: i.projectId,
    title: i.title,
    content: i.content,
    status: i.status,
    linkedSceneId: i.linkedSceneId,
    createdAt: ts(i.createdAt) ?? "",
    updatedAt: ts(i.updatedAt) ?? "",
  };
}

type SafeMemory = { id: number; projectId: number; category: string; content: string; createdAt: string };
function toMemory(m: ProjectMemory): SafeMemory {
  return {
    id: m.id,
    projectId: m.projectId,
    category: m.category,
    content: m.content,
    createdAt: ts(m.createdAt) ?? "",
  };
}

// ─── Tool definitions ────────────────────────────────────────────────────────
type ToolDef = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
};

const TOOLS: ToolDef[] = [
  // CCM framework guidance (read-only)
  {
    name: "get_ccm_guidance",
    description:
      "Use this to look up specific CCM framework guidance instead of assuming or guessing the rule. Prefer topic with a known section id when you know what you're looking for; use query only for vague/exploratory questions.",
    inputSchema: {
      type: "object",
      properties: {
        topic: { type: "string", enum: CCM_SECTION_IDS, description: "Exact CCM section id" },
        query: { type: "string", description: "Free-text CCM question for semantic retrieval" },
        token_budget: { type: "integer", description: "Max tokens of section content to return for semantic search (default 1200; min 1)" },
        top_k: { type: "integer", description: "Max sections to return for semantic search (default 2)" },
      },
      required: [],
    },
    handler: async (args) => {
      const topic = typeof args.topic === "string" ? args.topic : undefined;
      const query = typeof args.query === "string" ? args.query : undefined;
      if (topic) {
        const section = getSectionById(topic);
        if (!section) throw new Error("Unknown CCM topic: " + topic);
        return { sections: [section], matchType: "direct" as const };
      }
      if (query?.trim()) {
        const tokenBudget =
          typeof args.token_budget === "number" && Number.isFinite(args.token_budget) ? Math.max(0, Math.floor(args.token_budget)) : 1200;
        const topK =
          typeof args.top_k === "number" && Number.isFinite(args.top_k) ? Math.max(0, Math.floor(args.top_k)) : 2;
        return { sections: await searchSections(query, { tokenBudget, topK }), matchType: "semantic" as const };
      }
      throw new Error("Provide either a CCM topic or a free-text query.");
    },
  },

  // ── Project tools ────────────────────────────────────────────────────────
  {
    name: "list_projects",
    description: "List all projects in the vault. Returns id, title, description, and timestamps for each project.",
    inputSchema: { type: "object", properties: {}, required: [] },
    handler: async () => {
      const rows = getDb().select().from(projects).where(eq(projects.userId, getLocalUserId())).all();
      return rows.map(toProject);
    },
  },
  {
    name: "get_project",
    description: "Get detailed information about a specific project.",
    inputSchema: { type: "object", properties: { project_id: { type: "integer", description: "Project ID (defaults to STORY_VAULT_PROJECT_ID)" } }, required: [] },
    handler: async (args) => {
      const pid = (args.project_id as number) ?? DEFAULT_PROJECT_ID;
      if (!pid) throw new Error("project_id is required. Set STORY_VAULT_PROJECT_ID or pass it explicitly.");
      return toProject(assertProject(pid));
    },
  },
  {
    name: "create_project",
    description: "Create a new project with a title and optional description.",
    inputSchema: {
      type: "object",
      properties: { title: { type: "string", description: "Project title" }, description: { type: "string", description: "Optional project description" } },
      required: ["title"],
    },
    handler: async (args) => {
      const result = getDb().insert(projects).values({ userId: getLocalUserId(), title: args.title as string, description: (args.description as string) ?? null }).returning().get();
      return toProject(result);
    },
  },
  {
    name: "update_project",
    description: "Update a project's title and/or description.",
    inputSchema: {
      type: "object",
      properties: { project_id: { type: "integer", description: "Project ID (defaults to STORY_VAULT_PROJECT_ID)" }, title: { type: "string", description: "New title" }, description: { type: "string", description: "New description" } },
      required: [],
    },
    handler: async (args) => {
      const pid = (args.project_id as number) ?? DEFAULT_PROJECT_ID;
      if (!pid) throw new Error("project_id is required. Set STORY_VAULT_PROJECT_ID or pass it explicitly.");
      assertProject(pid);
      const update: Record<string, unknown> = { updatedAt: new Date() };
      if (args.title !== undefined) update.title = args.title;
      if (args.description !== undefined) update.description = args.description;
      getDb().update(projects).set(update).where(eq(projects.id, pid)).run();
      return toProject(assertProject(pid));
    },
  },
  {
    name: "delete_project",
    description: "Permanently delete a project and all its data (scenes, characters, notes, etc.).",
    inputSchema: { type: "object", properties: { project_id: { type: "integer", description: "Project ID (defaults to STORY_VAULT_PROJECT_ID)" } }, required: [] },
    handler: async (args) => {
      const pid = (args.project_id as number) ?? DEFAULT_PROJECT_ID;
      if (!pid) throw new Error("project_id is required. Set STORY_VAULT_PROJECT_ID or pass it explicitly.");
      assertProject(pid);
      getDb().delete(projects).where(eq(projects.id, pid)).run();
      storageService.recomputeUsage(getLocalUserId());
      return { success: true, deleted_project_id: pid };
    },
  },

  // ── Scene tools ──────────────────────────────────────────────────────────
  {
    name: "list_scenes",
    description: "List all scenes in a project, ordered by most recently updated. Returns title, status, word count, and timestamps.",
    inputSchema: {
      type: "object",
      properties: { project_id: { type: "integer", description: "Project ID (defaults to STORY_VAULT_PROJECT_ID)" } },
      required: [],
    },
    handler: async (args) => {
      const pid = (args.project_id as number) ?? DEFAULT_PROJECT_ID;
      if (!pid) throw new Error("project_id is required. Set STORY_VAULT_PROJECT_ID or pass it explicitly.");
      assertProject(pid);
      const rows = getDb().select().from(scenes).where(eq(scenes.projectId, pid)).orderBy(desc(scenes.updatedAt)).all();
      return rows.map(toScene);
    },
  },
  {
    name: "get_scene",
    description: "Get a scene's metadata (title, description, status, word count) by ID.",
    inputSchema: { type: "object", properties: { scene_id: { type: "integer", description: "Scene ID" } }, required: ["scene_id"] },
    handler: async (args) => {
      const scene = getDb().select().from(scenes).where(eq(scenes.id, args.scene_id as number)).get();
      if (!scene) throw new Error(`Scene #${args.scene_id} not found`);
      assertProject(scene.projectId);
      return toScene(scene);
    },
  },
  {
    name: "create_scene",
    description: "Create a new scene in a project.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "integer", description: "Project ID (defaults to STORY_VAULT_PROJECT_ID)" },
        title: { type: "string", description: "Scene title" },
        description: { type: "string", description: "Optional scene description" },
        status: { type: "string", enum: ["draft", "revised", "final"], description: "Scene status (default: draft)" },
      },
      required: ["title"],
    },
    handler: async (args) => {
      const pid = (args.project_id as number) ?? DEFAULT_PROJECT_ID;
      if (!pid) throw new Error("project_id is required. Set STORY_VAULT_PROJECT_ID or pass it explicitly.");
      assertProject(pid);
      const result = getDb().insert(scenes).values({
        projectId: pid,
        title: args.title as string,
        description: (args.description as string) ?? null,
        status: (args.status as "draft" | "revised" | "final") ?? "draft",
      }).returning().get();
      storageService.recomputeUsage(getLocalUserId());
      return toScene(result);
    },
  },
  {
    name: "update_scene",
    description: "Update a scene's title, description, or status.",
    inputSchema: {
      type: "object",
      properties: {
        scene_id: { type: "integer", description: "Scene ID" },
        title: { type: "string", description: "New title" },
        description: { type: "string", description: "New description" },
        status: { type: "string", enum: ["draft", "revised", "final"], description: "New status" },
      },
      required: ["scene_id"],
    },
    handler: async (args) => {
      const sid = args.scene_id as number;
      const scene = getDb().select().from(scenes).where(eq(scenes.id, sid)).get();
      if (!scene) throw new Error(`Scene #${sid} not found`);
      assertProject(scene.projectId);
      const update: Record<string, unknown> = { updatedAt: new Date() };
      if (args.title !== undefined) update.title = args.title;
      if (args.description !== undefined) update.description = args.description;
      if (args.status !== undefined) update.status = args.status;
      getDb().update(scenes).set(update).where(eq(scenes.id, sid)).run();
      storageService.recomputeUsage(getLocalUserId());
      return toScene(getDb().select().from(scenes).where(eq(scenes.id, sid)).get()!);
    },
  },
  {
    name: "delete_scene",
    description: "Permanently delete a scene and all its versions. Also removes it from the main story.",
    inputSchema: { type: "object", properties: { scene_id: { type: "integer", description: "Scene ID" } }, required: ["scene_id"] },
    handler: async (args) => {
      const sid = args.scene_id as number;
      const scene = getDb().select().from(scenes).where(eq(scenes.id, sid)).get();
      if (!scene) throw new Error(`Scene #${sid} not found`);
      assertProject(scene.projectId);
      getDb().delete(scenes).where(eq(scenes.id, sid)).run();
      storageService.recomputeUsage(getLocalUserId());
      return { success: true, deleted_scene_id: sid };
    },
  },
  {
    name: "read_scene_content",
    description: "Read the latest version content of a scene. Returns the full HTML content, plain text, word count, and version metadata.",
    inputSchema: { type: "object", properties: { scene_id: { type: "integer", description: "Scene ID" } }, required: ["scene_id"] },
    handler: async (args) => {
      const sid = args.scene_id as number;
      const scene = getDb().select().from(scenes).where(eq(scenes.id, sid)).get();
      if (!scene) throw new Error(`Scene #${sid} not found`);
      assertProject(scene.projectId);
      const version = getDb().select().from(sceneVersions).where(eq(sceneVersions.sceneId, sid)).orderBy(desc(sceneVersions.createdAt)).get();
      if (!version) {
        return { scene_id: sid, title: scene.title, content: "", plainText: "", wordCount: 0, versionId: null };
      }
      const plainText = version.content.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
      return {
        scene_id: sid,
        title: scene.title,
        content: version.content,
        plainText,
        wordCount: plainText.split(/\s+/).filter(Boolean).length,
        versionId: version.id,
        versionLabel: version.versionLabel,
        updatedAt: ts(version.updatedAt) ?? "",
      };
    },
  },

  // ── Version tools ────────────────────────────────────────────────────────
  {
    name: "list_scene_versions",
    description: "List all saved versions of a scene, newest first.",
    inputSchema: { type: "object", properties: { scene_id: { type: "integer", description: "Scene ID" } }, required: ["scene_id"] },
    handler: async (args) => {
      const sid = args.scene_id as number;
      const scene = getDb().select().from(scenes).where(eq(scenes.id, sid)).get();
      if (!scene) throw new Error(`Scene #${sid} not found`);
      assertProject(scene.projectId);
      const rows = getDb().select({ id: sceneVersions.id, versionLabel: sceneVersions.versionLabel, createdAt: sceneVersions.createdAt })
        .from(sceneVersions).where(eq(sceneVersions.sceneId, sid)).orderBy(desc(sceneVersions.createdAt)).all();
      return rows.map((v) => ({ ...v, createdAt: ts(v.createdAt) ?? "" }));
    },
  },
  {
    name: "read_scene_version",
    description: "Read the full content of a specific version of a scene.",
    inputSchema: { type: "object", properties: { version_id: { type: "integer", description: "Version ID" } }, required: ["version_id"] },
    handler: async (args) => {
      const vid = args.version_id as number;
      const version = getDb().select().from(sceneVersions).where(eq(sceneVersions.id, vid)).get();
      if (!version) throw new Error(`Version #${vid} not found`);
      const scene = getDb().select().from(scenes).where(eq(scenes.id, version.sceneId)).get();
      if (!scene) throw new Error("Scene not found for this version");
      assertProject(scene.projectId);
      const plainText = version.content.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
      return {
        versionId: version.id,
        sceneId: version.sceneId,
        versionLabel: version.versionLabel,
        content: version.content,
        plainText,
        wordCount: plainText.split(/\s+/).filter(Boolean).length,
        createdAt: ts(version.createdAt) ?? "",
      };
    },
  },
  {
    name: "save_scene_version",
    description: "Save a new version (draft) of a scene. This is how the AI writes prose into the project. The content is HTML. Returns the created version.",
    inputSchema: {
      type: "object",
      properties: {
        scene_id: { type: "integer", description: "Scene ID to write to" },
        content: { type: "string", description: "HTML content of the scene version" },
        version_label: { type: "string", enum: ["draft", "revised", "final"], description: "Optional version label (default: draft)" },
      },
      required: ["scene_id", "content"],
    },
    handler: async (args) => {
      const sid = args.scene_id as number;
      const scene = getDb().select().from(scenes).where(eq(scenes.id, sid)).get();
      if (!scene) throw new Error(`Scene #${sid} not found`);
      assertProject(scene.projectId);
      const content = args.content as string;
      const plainText = content.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
      const wordCount = plainText.split(/\s+/).filter(Boolean).length;
      const sizeBytes = Buffer.byteLength(content, "utf-8");
      const version = getDb().insert(sceneVersions).values({
        sceneId: sid,
        content,
        versionLabel: (args.version_label as "draft" | "revised" | "final") ?? "draft",
        sizeBytes,
      }).returning().get();
      // Update the scene's word count and timestamp.
      getDb().update(scenes).set({ wordCount, updatedAt: new Date() }).where(eq(scenes.id, sid)).run();
      storageService.recomputeUsage(getLocalUserId());
      return {
        versionId: version.id,
        sceneId: version.sceneId,
        versionLabel: version.versionLabel,
        wordCount,
        sizeBytes,
        createdAt: ts(version.createdAt) ?? "",
      };
    },
  },

  // ── Actor tools (CCM world model) ────────────────────────────────────────
  {
    name: "list_actors",
    description: "List all actors (characters) in a project, ordered by name. Actors are the CCM world model's character entities.",
    inputSchema: {
      type: "object",
      properties: { project_id: { type: "integer", description: "Project ID (defaults to STORY_VAULT_PROJECT_ID)" } },
      required: [],
    },
    handler: async (args) => {
      const pid = (args.project_id as number) ?? DEFAULT_PROJECT_ID;
      if (!pid) throw new Error("project_id is required. Set STORY_VAULT_PROJECT_ID or pass it explicitly.");
      assertProject(pid);
      const rows = getDb().select().from(ccmActors).where(eq(ccmActors.projectId, pid)).orderBy(asc(ccmActors.name)).all();
      return rows.map(toActor);
    },
  },
  {
    name: "get_actor",
    description: "Get an actor's full profile by ID (attributes, state, goals, drives, beliefs, knowledge, capabilities, constraints, resources, habits, plans).",
    inputSchema: { type: "object", properties: { actor_id: { type: "integer", description: "Actor ID" } }, required: ["actor_id"] },
    handler: async (args) => {
      const a = getDb().select().from(ccmActors).where(eq(ccmActors.id, args.actor_id as number)).get();
      if (!a) throw new Error(`Actor #${args.actor_id} not found`);
      assertProject(a.projectId);
      return toActor(a);
    },
  },
  {
    name: "create_actor",
    description: "Create a new actor (character) in a project. `attributes` are stable traits (age, condition); `state` is the current world state (location, fatigue).",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "integer", description: "Project ID (defaults to STORY_VAULT_PROJECT_ID)" },
        name: { type: "string", description: "Actor name" },
        type: { type: "string", description: "Actor type (default: human)" },
        description: { type: "string", description: "Physical description and personality" },
        notes: { type: "string", description: "Private notes about this actor" },
        attributes: { type: "object", description: "Stable attributes (age, condition, abilities, custom fields)" },
        state: { type: "object", description: "Current world state (location, fatigue, emotions)" },
        goals: { type: "object", description: "Layered goals: { survival, functional, social, emotional, longTerm, narrative }" },
        drives: { type: "array", items: { type: "string" }, description: "Drives (autonomy, curiosity, fear, ...)" },
        beliefs: { type: "object", description: "Beliefs: { known, believed, uncertain, misconceptions }" },
        knowledge: { type: "array", items: { type: "string" }, description: "Known facts" },
        capabilities: { type: "array", items: { type: "string" }, description: "What the actor can do" },
        constraints: { type: "array", items: { type: "string" }, description: "Personal restraints" },
        resources: { type: "object", description: "Resources owned" },
        habits: { type: "array", items: { type: "string" }, description: "Habits" },
        plans: { type: "array", items: { type: "string" }, description: "Plans" },
      },
      required: ["name"],
    },
    handler: async (args) => {
      const pid = (args.project_id as number) ?? DEFAULT_PROJECT_ID;
      if (!pid) throw new Error("project_id is required. Set STORY_VAULT_PROJECT_ID or pass it explicitly.");
      assertProject(pid);

      // QA hardening: validate name before inserting.
      const name = assertValidActorName(args.name as string);
      assertUniqueActorName(pid, name);

      const result = getDb().insert(ccmActors).values({
        projectId: pid,
        name,
        type: (args.type as string) ?? "human",
        description: (args.description as string) ?? null,
        notes: (args.notes as string) ?? null,
        attributes: (args.attributes as Record<string, unknown>) ?? {},
        state: (args.state as Record<string, unknown>) ?? {},
        goals: (args.goals as Record<string, string[]>) ?? { survival: [], functional: [], social: [], emotional: [], longTerm: [], narrative: [] },
        drives: (args.drives as string[]) ?? [],
        beliefs: (args.beliefs as Record<string, string[]>) ?? { known: [], believed: [], uncertain: [], misconceptions: [] },
        knowledge: (args.knowledge as string[]) ?? [],
        capabilities: (args.capabilities as string[]) ?? [],
        constraints: (args.constraints as string[]) ?? [],
        resources: (args.resources as Record<string, unknown>) ?? {},
        habits: (args.habits as string[]) ?? [],
        plans: (args.plans as string[]) ?? [],
      }).returning().get();
      storageService.recomputeUsage(getLocalUserId());
      return toActor(result);
    },
  },
  {
    name: "update_actor",
    description: "Update an actor's non-canon fields (name, type, description, notes). To change state, attributes, goals, constraints, or other canon fields, use propose_actor_change so the change passes the CCE engine's validation gate.",
    inputSchema: {
      type: "object",
      properties: {
        actor_id: { type: "integer", description: "Actor ID" },
        name: { type: "string", description: "New name" },
        type: { type: "string", description: "New type" },
        description: { type: "string", description: "New description" },
        notes: { type: "string", description: "New notes" },
      },
      required: ["actor_id"],
    },
    handler: async (args) => {
      const aid = args.actor_id as number;
      const a = getDb().select().from(ccmActors).where(eq(ccmActors.id, aid)).get();
      if (!a) throw new Error(`Actor #${aid} not found`);
      assertProject(a.projectId);
      // Canon fields (state, attributes, constraints, capabilities, …) are
      // owned by the CCE engine — mutate them only via propose_actor_change.
      rejectCanonFields("update_actor", args, ACTOR_CANON_FIELDS, "propose_actor_change");
      // QA hardening: validate name when renaming.
      let name = args.name as string | undefined;
      if (name !== undefined) {
        name = assertValidActorName(name);
        assertUniqueActorName(a.projectId, name, aid);
      }
      const update: Record<string, unknown> = { updatedAt: new Date() };
      for (const field of ["name", "type", "description", "notes"] as const) {
        if (args[field] !== undefined) update[field] = args[field];
      }
      if (name !== undefined) update.name = name;
      getDb().update(ccmActors).set(update).where(eq(ccmActors.id, aid)).run();
      storageService.recomputeUsage(getLocalUserId());
      return toActor(getDb().select().from(ccmActors).where(eq(ccmActors.id, aid)).get()!);
    },
  },
  {
    name: "delete_actor",
    description: "Permanently delete an actor (character) from a project.",
    inputSchema: { type: "object", properties: { actor_id: { type: "integer", description: "Actor ID" } }, required: ["actor_id"] },
    handler: async (args) => {
      const aid = args.actor_id as number;
      const a = getDb().select().from(ccmActors).where(eq(ccmActors.id, aid)).get();
      if (!a) throw new Error(`Actor #${aid} not found`);
      assertProject(a.projectId);
      deleteActor(aid);
      return { success: true, deleted_actor_id: aid };
    },
  },

  // ── Environment tools (world model) ─────────────────────────────────────
  {
    name: "list_environments",
    description: "List all environments (locations) in a project, ordered by most recently updated.",
    inputSchema: {
      type: "object",
      properties: { project_id: { type: "integer", description: "Project ID (defaults to STORY_VAULT_PROJECT_ID)" } },
      required: [],
    },
    handler: async (args) => {
      const pid = (args.project_id as number) ?? DEFAULT_PROJECT_ID;
      if (!pid) throw new Error("project_id is required. Set STORY_VAULT_PROJECT_ID or pass it explicitly.");
      assertProject(pid);
      const rows = getDb().select().from(ccmEnvironments).where(eq(ccmEnvironments.projectId, pid)).orderBy(desc(ccmEnvironments.updatedAt)).all();
      return rows.map(toEnvironment);
    },
  },
  {
    name: "get_environment",
    description: "Get an environment's full definition by ID (state, resources, inhabitants, active processes).",
    inputSchema: { type: "object", properties: { environment_id: { type: "integer", description: "Environment ID" } }, required: ["environment_id"] },
    handler: async (args) => {
      const e = getDb().select().from(ccmEnvironments).where(eq(ccmEnvironments.id, args.environment_id as number)).get();
      if (!e) throw new Error(`Environment #${args.environment_id} not found`);
      assertProject(e.projectId);
      return toEnvironment(e);
    },
  },
  {
    name: "create_environment",
    description: "Create a new environment (location) in a project.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "integer", description: "Project ID (defaults to STORY_VAULT_PROJECT_ID)" },
        name: { type: "string", description: "Environment name" },
        type: { type: "string", description: "Type (default: location)" },
        attributes: { type: "object", description: "Stable attributes" },
        state: { type: "object", description: "Current state (occupancy, emergency level, ...)" },
        resources: { type: "object", description: "Resources available" },
        inhabitants: { type: "array", items: { type: "string" }, description: "Inhabitant actor names" },
        activeProcesses: { type: "array", items: { type: "string" }, description: "Active processes" },
        constraints: { type: "array", items: { type: "string" }, description: "Constraints" },
      },
      required: ["name"],
    },
    handler: async (args) => {
      const pid = (args.project_id as number) ?? DEFAULT_PROJECT_ID;
      if (!pid) throw new Error("project_id is required. Set STORY_VAULT_PROJECT_ID or pass it explicitly.");
      assertProject(pid);
      const result = getDb().insert(ccmEnvironments).values({
        projectId: pid,
        name: args.name as string,
        type: (args.type as string) ?? "location",
        attributes: (args.attributes as Record<string, unknown>) ?? {},
        state: (args.state as Record<string, unknown>) ?? {},
        resources: (args.resources as Record<string, unknown>) ?? {},
        inhabitants: (args.inhabitants as string[]) ?? [],
        accessibility: {},
        activeProcesses: (args.activeProcesses as string[]) ?? [],
        constraints: (args.constraints as string[]) ?? [],
      }).returning().get();
      storageService.recomputeUsage(getLocalUserId());
      return toEnvironment(result);
    },
  },
  {
    name: "update_environment",
    description: "Update an environment's non-canon fields (name, type). To change state, resources, inhabitants, or other canon fields, use propose_environment_change so the change passes the CCE engine's validation gate.",
    inputSchema: {
      type: "object",
      properties: {
        environment_id: { type: "integer", description: "Environment ID" },
        name: { type: "string", description: "New name" },
        type: { type: "string", description: "New type" },
      },
      required: ["environment_id"],
    },
    handler: async (args) => {
      const eid = args.environment_id as number;
      const e = getDb().select().from(ccmEnvironments).where(eq(ccmEnvironments.id, eid)).get();
      if (!e) throw new Error(`Environment #${eid} not found`);
      assertProject(e.projectId);
      rejectCanonFields("update_environment", args, ENVIRONMENT_CANON_FIELDS, "propose_environment_change");
      const update: Record<string, unknown> = { updatedAt: new Date() };
      for (const field of ["name", "type"] as const) {
        if (args[field] !== undefined) update[field] = args[field];
      }
      getDb().update(ccmEnvironments).set(update).where(eq(ccmEnvironments.id, eid)).run();
      storageService.recomputeUsage(getLocalUserId());
      return toEnvironment(getDb().select().from(ccmEnvironments).where(eq(ccmEnvironments.id, eid)).get()!);
    },
  },
  {
    name: "delete_environment",
    description: "Permanently delete an environment from a project.",
    inputSchema: { type: "object", properties: { environment_id: { type: "integer", description: "Environment ID" } }, required: ["environment_id"] },
    handler: async (args) => {
      const eid = args.environment_id as number;
      const e = getDb().select().from(ccmEnvironments).where(eq(ccmEnvironments.id, eid)).get();
      if (!e) throw new Error(`Environment #${eid} not found`);
      assertProject(e.projectId);
      deleteEnvironment(eid);
      return { success: true, deleted_environment_id: eid };
    },
  },

  // ── System tools (world model) ──────────────────────────────────────────
  {
    name: "list_systems",
    description: "List all systems (world mechanics: magic, weather, economy, biology, ...) in a project.",
    inputSchema: {
      type: "object",
      properties: { project_id: { type: "integer", description: "Project ID (defaults to STORY_VAULT_PROJECT_ID)" } },
      required: [],
    },
    handler: async (args) => {
      const pid = (args.project_id as number) ?? DEFAULT_PROJECT_ID;
      if (!pid) throw new Error("project_id is required. Set STORY_VAULT_PROJECT_ID or pass it explicitly.");
      assertProject(pid);
      const rows = getDb().select().from(ccmSystems).where(eq(ccmSystems.projectId, pid)).orderBy(desc(ccmSystems.updatedAt)).all();
      return rows.map(toSystem);
    },
  },
  {
    name: "get_system",
    description: "Get a system's full definition by ID (rules, constraints, active conditions, effects, exceptions).",
    inputSchema: { type: "object", properties: { system_id: { type: "integer", description: "System ID" } }, required: ["system_id"] },
    handler: async (args) => {
      const s = getDb().select().from(ccmSystems).where(eq(ccmSystems.id, args.system_id as number)).get();
      if (!s) throw new Error(`System #${args.system_id} not found`);
      assertProject(s.projectId);
      return toSystem(s);
    },
  },
  {
    name: "create_system",
    description: "Create a new system (world mechanism) in a project.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "integer", description: "Project ID (defaults to STORY_VAULT_PROJECT_ID)" },
        name: { type: "string", description: "System name" },
        type: { type: "string", description: "Type (default: system)" },
        rules: { type: "array", items: { type: "string" }, description: "Governing rules" },
        constraints: { type: "array", items: { type: "string" }, description: "Constraints" },
        activeConditions: { type: "array", items: { type: "string" }, description: "Active conditions" },
        effects: { type: "array", items: { type: "string" }, description: "Effects" },
        exceptions: { type: "array", items: { type: "string" }, description: "Exceptions" },
      },
      required: ["name"],
    },
    handler: async (args) => {
      const pid = (args.project_id as number) ?? DEFAULT_PROJECT_ID;
      if (!pid) throw new Error("project_id is required. Set STORY_VAULT_PROJECT_ID or pass it explicitly.");
      assertProject(pid);
      const result = getDb().insert(ccmSystems).values({
        projectId: pid,
        name: args.name as string,
        type: (args.type as string) ?? "system",
        rules: (args.rules as string[]) ?? [],
        constraints: (args.constraints as string[]) ?? [],
        activeConditions: (args.activeConditions as string[]) ?? [],
        effects: (args.effects as string[]) ?? [],
        exceptions: (args.exceptions as string[]) ?? [],
      }).returning().get();
      storageService.recomputeUsage(getLocalUserId());
      return toSystem(result);
    },
  },
  {
    name: "update_system",
    description: "Update a system's non-canon fields (name, type). To change rules, constraints, effects, or other canon fields, use propose_system_change so the change passes the CCE engine's validation gate.",
    inputSchema: {
      type: "object",
      properties: {
        system_id: { type: "integer", description: "System ID" },
        name: { type: "string", description: "New name" },
        type: { type: "string", description: "New type" },
      },
      required: ["system_id"],
    },
    handler: async (args) => {
      const sid = args.system_id as number;
      const s = getDb().select().from(ccmSystems).where(eq(ccmSystems.id, sid)).get();
      if (!s) throw new Error(`System #${sid} not found`);
      assertProject(s.projectId);
      rejectCanonFields("update_system", args, SYSTEM_CANON_FIELDS, "propose_system_change");
      const update: Record<string, unknown> = { updatedAt: new Date() };
      for (const field of ["name", "type"] as const) {
        if (args[field] !== undefined) update[field] = args[field];
      }
      getDb().update(ccmSystems).set(update).where(eq(ccmSystems.id, sid)).run();
      storageService.recomputeUsage(getLocalUserId());
      return toSystem(getDb().select().from(ccmSystems).where(eq(ccmSystems.id, sid)).get()!);
    },
  },
  {
    name: "delete_system",
    description: "Permanently delete a system from a project.",
    inputSchema: { type: "object", properties: { system_id: { type: "integer", description: "System ID" } }, required: ["system_id"] },
    handler: async (args) => {
      const sid = args.system_id as number;
      const s = getDb().select().from(ccmSystems).where(eq(ccmSystems.id, sid)).get();
      if (!s) throw new Error(`System #${sid} not found`);
      assertProject(s.projectId);
      deleteSystem(sid);
      return { success: true, deleted_system_id: sid };
    },
  },

  // ── Idea tools ───────────────────────────────────────────────────────────
  {
    name: "list_ideas",
    description: "List all ideas in a project, ordered by most recently updated.",
    inputSchema: {
      type: "object",
      properties: { project_id: { type: "integer", description: "Project ID (defaults to STORY_VAULT_PROJECT_ID)" } },
      required: [],
    },
    handler: async (args) => {
      const pid = (args.project_id as number) ?? DEFAULT_PROJECT_ID;
      if (!pid) throw new Error("project_id is required. Set STORY_VAULT_PROJECT_ID or pass it explicitly.");
      assertProject(pid);
      const rows = getDb().select().from(ideas).where(eq(ideas.projectId, pid)).orderBy(desc(ideas.updatedAt)).all();
      return rows.map(toIdea);
    },
  },
  {
    name: "get_idea",
    description: "Get an idea by ID, including its full content and linked scene.",
    inputSchema: { type: "object", properties: { idea_id: { type: "integer", description: "Idea ID" } }, required: ["idea_id"] },
    handler: async (args) => {
      const i = getDb().select().from(ideas).where(eq(ideas.id, args.idea_id as number)).get();
      if (!i) throw new Error(`Idea #${args.idea_id} not found`);
      assertProject(i.projectId);
      return toIdea(i);
    },
  },
  {
    name: "create_idea",
    description: "Create a new idea for a project. Optionally link it to a scene.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "integer", description: "Project ID (defaults to STORY_VAULT_PROJECT_ID)" },
        title: { type: "string", description: "Idea title" },
        content: { type: "string", description: "Full idea description" },
        linked_scene_id: { type: "integer", description: "Optional scene ID this idea relates to" },
      },
      required: ["title", "content"],
    },
    handler: async (args) => {
      const pid = (args.project_id as number) ?? DEFAULT_PROJECT_ID;
      if (!pid) throw new Error("project_id is required. Set STORY_VAULT_PROJECT_ID or pass it explicitly.");
      assertProject(pid);
      const result = getDb().insert(ideas).values({
        projectId: pid,
        title: args.title as string,
        content: args.content as string,
        linkedSceneId: (args.linked_scene_id as number) ?? null,
      }).returning().get();
      storageService.recomputeUsage(getLocalUserId());
      return toIdea(result);
    },
  },
  {
    name: "update_idea",
    description: "Update an idea's title, content, status, or linked scene.",
    inputSchema: {
      type: "object",
      properties: {
        idea_id: { type: "integer", description: "Idea ID" },
        title: { type: "string", description: "New title" },
        content: { type: "string", description: "New content" },
        status: { type: "string", enum: ["raw", "evaluating", "adopted", "discarded"], description: "New status" },
        linked_scene_id: { type: "integer", description: "Optional linked scene ID (null to unlink)" },
      },
      required: ["idea_id"],
    },
    handler: async (args) => {
      const iid = args.idea_id as number;
      const i = getDb().select().from(ideas).where(eq(ideas.id, iid)).get();
      if (!i) throw new Error(`Idea #${iid} not found`);
      assertProject(i.projectId);
      const update: Record<string, unknown> = { updatedAt: new Date() };
      if (args.title !== undefined) update.title = args.title;
      if (args.content !== undefined) update.content = args.content;
      if (args.status !== undefined) update.status = args.status;
      if (args.linked_scene_id !== undefined) update.linkedSceneId = args.linked_scene_id;
      getDb().update(ideas).set(update).where(eq(ideas.id, iid)).run();
      storageService.recomputeUsage(getLocalUserId());
      return toIdea(getDb().select().from(ideas).where(eq(ideas.id, iid)).get()!);
    },
  },
  {
    name: "delete_idea",
    description: "Permanently delete an idea.",
    inputSchema: { type: "object", properties: { idea_id: { type: "integer", description: "Idea ID" } }, required: ["idea_id"] },
    handler: async (args) => {
      const iid = args.idea_id as number;
      const i = getDb().select().from(ideas).where(eq(ideas.id, iid)).get();
      if (!i) throw new Error(`Idea #${iid} not found`);
      assertProject(i.projectId);
      getDb().delete(ideas).where(eq(ideas.id, iid)).run();
      storageService.recomputeUsage(getLocalUserId());
      return { success: true, deleted_idea_id: iid };
    },
  },

  // ── Main story tools ─────────────────────────────────────────────────────
  {
    name: "get_main_story",
    description: "Get the ordered list of scenes in the main story/manuscript, with their version info.",
    inputSchema: {
      type: "object",
      properties: { project_id: { type: "integer", description: "Project ID (defaults to STORY_VAULT_PROJECT_ID)" } },
      required: [],
    },
    handler: async (args) => {
      const pid = (args.project_id as number) ?? DEFAULT_PROJECT_ID;
      if (!pid) throw new Error("project_id is required. Set STORY_VAULT_PROJECT_ID or pass it explicitly.");
      assertProject(pid);
      const entries = getDb().select({
        id: mainStoryScenes.id,
        sceneId: mainStoryScenes.sceneId,
        versionId: mainStoryScenes.versionId,
        order: mainStoryScenes.order,
        sceneTitle: scenes.title,
        sceneStatus: scenes.status,
      }).from(mainStoryScenes)
        .innerJoin(scenes, eq(mainStoryScenes.sceneId, scenes.id))
        .where(eq(mainStoryScenes.projectId, pid))
        .orderBy(asc(mainStoryScenes.order))
        .all();
      return entries;
    },
  },
  {
    name: "add_scene_to_story",
    description: "Add a scene to the main story/manuscript. Uses the scene's latest version. Optionally specify an order position.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "integer", description: "Project ID (defaults to STORY_VAULT_PROJECT_ID)" },
        scene_id: { type: "integer", description: "Scene ID to add" },
        order: { type: "integer", description: "Optional sort position (defaults to end of story)" },
      },
      required: ["scene_id"],
    },
    handler: async (args) => {
      const pid = (args.project_id as number) ?? DEFAULT_PROJECT_ID;
      if (!pid) throw new Error("project_id is required. Set STORY_VAULT_PROJECT_ID or pass it explicitly.");
      const sid = args.scene_id as number;
      const scene = getDb().select().from(scenes).where(eq(scenes.id, sid)).get();
      if (!scene) throw new Error(`Scene #${sid} not found`);
      assertProject(scene.projectId);
      // Use the latest version.
      const latest = getDb().select().from(sceneVersions).where(eq(sceneVersions.sceneId, sid)).orderBy(desc(sceneVersions.createdAt)).get();
      if (!latest) throw new Error(`Scene #${sid} has no saved versions. Save a version first.`);
      const existing = getDb().select().from(mainStoryScenes)
        .where(and(eq(mainStoryScenes.projectId, pid), eq(mainStoryScenes.sceneId, sid))).get();
      if (existing) throw new Error(`Scene #${sid} is already in the main story.`);
      const maxOrder = getDb().select({ max: mainStoryScenes.order })
        .from(mainStoryScenes).where(eq(mainStoryScenes.projectId, pid)).orderBy(desc(mainStoryScenes.order)).get();
      const nextOrder = args.order !== undefined ? (args.order as number) : ((maxOrder?.max ?? 0) + 1);
      const result = getDb().insert(mainStoryScenes).values({
        projectId: pid,
        sceneId: sid,
        versionId: latest.id,
        order: nextOrder,
      }).returning().get();
      return { id: result.id, sceneId: result.sceneId, versionId: result.versionId, order: result.order };
    },
  },
  {
    name: "remove_scene_from_story",
    description: "Remove a scene from the main story/manuscript. The scene itself is not deleted.",
    inputSchema: {
      type: "object",
      properties: { project_id: { type: "integer", description: "Project ID (defaults to STORY_VAULT_PROJECT_ID)" }, scene_id: { type: "integer", description: "Scene ID to remove" } },
      required: ["scene_id"],
    },
    handler: async (args) => {
      const pid = (args.project_id as number) ?? DEFAULT_PROJECT_ID;
      if (!pid) throw new Error("project_id is required. Set STORY_VAULT_PROJECT_ID or pass it explicitly.");
      assertProject(pid);
      const sid = args.scene_id as number;
      const entry = getDb().select().from(mainStoryScenes)
        .where(and(eq(mainStoryScenes.projectId, pid), eq(mainStoryScenes.sceneId, sid))).get();
      if (!entry) throw new Error(`Scene #${sid} is not in the main story.`);
      getDb().delete(mainStoryScenes).where(eq(mainStoryScenes.id, entry.id)).run();
      return { success: true, removed_scene_id: sid };
    },
  },
  {
    name: "reorder_main_story",
    description: "Reorder the scenes in the main story. Provide an array of scene IDs in the desired order.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "integer", description: "Project ID (defaults to STORY_VAULT_PROJECT_ID)" },
        scene_ids: { type: "array", items: { type: "integer" }, description: "Array of scene IDs in the new order" },
      },
      required: ["scene_ids"],
    },
    handler: async (args) => {
      const pid = (args.project_id as number) ?? DEFAULT_PROJECT_ID;
      if (!pid) throw new Error("project_id is required. Set STORY_VAULT_PROJECT_ID or pass it explicitly.");
      assertProject(pid);
      const sceneIds = args.scene_ids as number[];
      const entries = getDb().select().from(mainStoryScenes).where(eq(mainStoryScenes.projectId, pid)).all();
      const entryMap = new Map(entries.map((e) => [e.sceneId, e]));
      for (const sid of sceneIds) {
        const entry = entryMap.get(sid);
        if (!entry) throw new Error(`Scene #${sid} is not in the main story.`);
      }
      getDb().transaction((tx) => {
        sceneIds.forEach((sid, idx) => {
          const entry = entryMap.get(sid)!;
          tx.update(mainStoryScenes).set({ order: idx + 1 }).where(eq(mainStoryScenes.id, entry.id)).run();
        });
      });
      return { success: true, new_order: sceneIds };
    },
  },

  // ── Project memory tools ─────────────────────────────────────────────────
  {
    name: "list_memory",
    description: "List all project memory entries (facts, rules, hypotheses, briefs), newest first.",
    inputSchema: {
      type: "object",
      properties: { project_id: { type: "integer", description: "Project ID (defaults to STORY_VAULT_PROJECT_ID)" } },
      required: [],
    },
    handler: async (args) => {
      const pid = (args.project_id as number) ?? DEFAULT_PROJECT_ID;
      if (!pid) throw new Error("project_id is required. Set STORY_VAULT_PROJECT_ID or pass it explicitly.");
      assertProject(pid);
      const rows = getDb().select().from(projectMemory).where(eq(projectMemory.projectId, pid)).orderBy(desc(projectMemory.createdAt)).all();
      return rows.map(toMemory);
    },
  },
  {
    name: "search_memory",
    description: "Search project memory entries by keyword. Returns matching entries.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "integer", description: "Project ID (defaults to STORY_VAULT_PROJECT_ID)" },
        query: { type: "string", description: "Search keyword" },
      },
      required: ["query"],
    },
    handler: async (args) => {
      const pid = (args.project_id as number) ?? DEFAULT_PROJECT_ID;
      if (!pid) throw new Error("project_id is required. Set STORY_VAULT_PROJECT_ID or pass it explicitly.");
      assertProject(pid);
      const query = `%${args.query as string}%`;
      const rows = getDb().select().from(projectMemory)
        .where(and(eq(projectMemory.projectId, pid), like(projectMemory.content, query)))
        .orderBy(desc(projectMemory.createdAt)).all();
      return rows.map(toMemory);
    },
  },
  {
    name: "add_memory",
    description: "Store a durable fact, rule, or hypothesis in the project's persistent memory. The AI agent reads this on every session.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "integer", description: "Project ID (defaults to STORY_VAULT_PROJECT_ID)" },
        category: { type: "string", enum: ["rule", "fact", "hypothesis", "project_brief", "core_directive"], description: "Category of memory entry" },
        content: { type: "string", description: "The memory content (1-3 sentences)" },
      },
      required: ["category", "content"],
    },
    handler: async (args) => {
      const pid = (args.project_id as number) ?? DEFAULT_PROJECT_ID;
      if (!pid) throw new Error("project_id is required. Set STORY_VAULT_PROJECT_ID or pass it explicitly.");
      assertProject(pid);
      const result = getDb().insert(projectMemory).values({
        projectId: pid,
        category: args.category as "rule" | "fact" | "hypothesis" | "project_brief" | "core_directive",
        content: args.content as string,
      }).returning().get();
      storageService.recomputeUsage(getLocalUserId());
      return toMemory(result);
    },
  },
  {
    name: "delete_memory",
    description: "Delete a memory entry by its ID.",
    inputSchema: { type: "object", properties: { memory_id: { type: "integer", description: "Memory entry ID" } }, required: ["memory_id"] },
    handler: async (args) => {
      const mid = args.memory_id as number;
      const mem = getDb().select({ id: projectMemory.id, projectId: projectMemory.projectId }).from(projectMemory).where(eq(projectMemory.id, mid)).get();
      if (!mem) throw new Error(`Memory entry #${mid} not found`);
      assertProject(mem.projectId);
      getDb().delete(projectMemory).where(eq(projectMemory.id, mid)).run();
      storageService.recomputeUsage(getLocalUserId());
      return { success: true, deleted_memory_id: mid };
    },
  },

  // ── Semantic advisory tools (CPU-only NLI, read-only) ─────────────────────
  // Advisory-only: these never gate, block, or alter any engine decision —
  // they produce suggestions/scores surfaced alongside existing output. The
  // ONNX model loads lazily on first use and is cached per process.
  {
    name: "check_semantic_consistency",
    description: "Advisory-only. Checks whether two pieces of free text contradict each other, entail one another, or are neutral, using a local CPU NLI model (Xenova/nli-deberta-v3-small). Returns { label: 'contradiction'|'entailment'|'neutral', score }. Informational — never blocks or alters any engine decision.",
    inputSchema: {
      type: "object",
      properties: {
        text_a: { type: "string", description: "First text (e.g. current state/attribute text)" },
        text_b: { type: "string", description: "Second text (e.g. proposed new text)" },
      },
      required: ["text_a", "text_b"],
    },
    handler: async (args) => {
      try {
        return await checkContradiction(args.text_a as string, args.text_b as string);
      } catch (error) {
        return { error: `Semantic model unavailable: ${error instanceof Error ? error.message : String(error)}`, label: "neutral", score: 0 };
      }
    },
  },
  {
    name: "suggest_tags",
    description: "Advisory-only. Suggests tags for a piece of text using zero-shot classification against a vocabulary you supply. Returns [{ tag, score }] sorted descending by score (no internal cutoff — you decide a threshold). Informational only; never affects engine state.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to classify" },
        vocabulary: { type: "array", items: { type: "string" }, description: "Candidate labels to score the text against" },
      },
      required: ["text", "vocabulary"],
    },
    handler: async (args) => {
      try {
        return await suggestTags(args.text as string, args.vocabulary as string[]);
      } catch (error) {
        return { error: `Semantic model unavailable: ${error instanceof Error ? error.message : String(error)}`, tags: [] };
      }
    },
  },

  // ─── Validated-write tools (CCE engine gateway) ───────────────────────────
  // External LLMs can propose structured state changes to the world model.
  // Each proposal passes through the engine's 6-layer validation gate; the
  // engine returns the verdict (accepted + applied, or rejectedLayer + reason
  // + guidance + advisoryFlags). This is the "LLM proposes, symbolic engine
  // validates" discipline, now available over MCP.
  {
    name: "propose_actor_change",
    description:
      "Propose a structured, engine-validated change to an ACTOR's state/attributes/goals/beliefs/etc. The proposal passes through the CCE's 6-layer validation gate. Returns { accepted, applied, rejectedLayer?, reason?, guidance?, advisoryFlags? }. Canon only changes if accepted.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "integer", description: "Project ID (defaults to STORY_VAULT_PROJECT_ID)" },
        simulation_id: { type: "integer", description: "Simulation ID — the engine reads the world from this run's config" },
        actor_id: { type: "integer", description: "Actor ID to change" },
        summary: { type: "string", description: "One-line human summary of the proposed change (used for candidate pressure)" },
        changes: {
          type: "array",
          description: "Structured state changes: { target: 'self' | 'actor:Name' | 'environment:Name' | 'relationship:A:B', field: dotted path, op: set|increment|append|remove, value }",
          items: {
            type: "object",
            properties: {
              target: { type: "string" },
              field: { type: "string" },
              op: { type: "string", enum: ["set", "increment", "append", "remove"] },
              value: { description: "New value (any JSON type)" },
            },
            required: ["target", "field", "op"],
          },
        },
        requires_knowledge: { type: "string", description: "Optional fact the actor must already know" },
        requires_capability: { type: "string", description: "Optional capability the actor must have" },
      },
      required: ["project_id", "simulation_id", "actor_id", "summary", "changes"],
    },
    handler: async (args) => {
      const pid = (args.project_id as number) ?? DEFAULT_PROJECT_ID;
      assertProject(pid);
      return await proposeActorChange(
        pid,
        args.simulation_id as number,
        args.actor_id as number,
        args.summary as string,
        args.changes as any[],
        { requiresKnowledge: args.requires_knowledge as string | undefined, requiresCapability: args.requires_capability as string | undefined }
      );
    },
  },
  {
    name: "propose_environment_change",
    description:
      "Propose a structured, engine-validated change to an ENVIRONMENT's state/resources/inhabitants/accessibility/activeProcesses/constraints. Passes through the CCE's 6-layer validation gate. Returns { accepted, applied, rejectedLayer?, reason?, guidance?, advisoryFlags? }.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "integer", description: "Project ID (defaults to STORY_VAULT_PROJECT_ID)" },
        simulation_id: { type: "integer", description: "Simulation ID" },
        environment_id: { type: "integer", description: "Environment ID to change" },
        summary: { type: "string", description: "One-line human summary of the proposed change" },
        changes: {
          type: "array",
          description: "Structured state changes (target is usually 'self' for the environment)",
          items: {
            type: "object",
            properties: {
              target: { type: "string" },
              field: { type: "string" },
              op: { type: "string", enum: ["set", "increment", "append", "remove"] },
              value: { description: "New value (any JSON type)" },
            },
            required: ["target", "field", "op"],
          },
        },
        requires_knowledge: { type: "string", description: "Optional required knowledge" },
        requires_capability: { type: "string", description: "Optional required capability" },
      },
      required: ["project_id", "simulation_id", "environment_id", "summary", "changes"],
    },
    handler: async (args) => {
      const pid = (args.project_id as number) ?? DEFAULT_PROJECT_ID;
      assertProject(pid);
      return await proposeEnvironmentChange(
        pid,
        args.simulation_id as number,
        args.environment_id as number,
        args.summary as string,
        args.changes as any[],
        { requiresKnowledge: args.requires_knowledge as string | undefined, requiresCapability: args.requires_capability as string | undefined }
      );
    },
  },
  {
    name: "propose_system_change",
    description:
      "Propose a structured, engine-validated change to a SYSTEM's rules/constraints/activeConditions/effects/exceptions. Passes through the CCE's 6-layer validation gate. Returns { accepted, applied, rejectedLayer?, reason?, guidance?, advisoryFlags? }.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "integer", description: "Project ID (defaults to STORY_VAULT_PROJECT_ID)" },
        simulation_id: { type: "integer", description: "Simulation ID" },
        system_id: { type: "integer", description: "System ID to change" },
        summary: { type: "string", description: "One-line human summary of the proposed change" },
        changes: {
          type: "array",
          description: "Structured state changes",
          items: {
            type: "object",
            properties: {
              target: { type: "string" },
              field: { type: "string" },
              op: { type: "string", enum: ["set", "increment", "append", "remove"] },
              value: { description: "New value (any JSON type)" },
            },
            required: ["target", "field", "op"],
          },
        },
        requires_knowledge: { type: "string", description: "Optional required knowledge" },
        requires_capability: { type: "string", description: "Optional required capability" },
      },
      required: ["project_id", "simulation_id", "system_id", "summary", "changes"],
    },
    handler: async (args) => {
      const pid = (args.project_id as number) ?? DEFAULT_PROJECT_ID;
      assertProject(pid);
      return await proposeSystemChange(
        pid,
        args.simulation_id as number,
        args.system_id as number,
        args.summary as string,
        args.changes as any[],
        { requiresKnowledge: args.requires_knowledge as string | undefined, requiresCapability: args.requires_capability as string | undefined }
      );
    },
  },
  {
    name: "propose_relationship_change",
    description:
      "Propose creating or updating a QUALITATIVE relationship between two actors (trust, familiarity, affection, resentment, dependence, fear, obligation, respect, knowledge). Passes through the CCE's 6-layer validation gate.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "integer", description: "Project ID (defaults to STORY_VAULT_PROJECT_ID)" },
        simulation_id: { type: "integer", description: "Simulation ID" },
        actor_a_id: { type: "integer", description: "First actor ID" },
        actor_b_id: { type: "integer", description: "Second actor ID" },
        summary: { type: "string", description: "One-line human summary of the proposed change" },
        data: {
          type: "object",
          description: "Qualitative relationship axes (any subset)",
          properties: {
            familiarity: { type: "string" },
            trust: { type: "string" },
            affection: { type: "string" },
            resentment: { type: "string" },
            dependence: { type: "string" },
            fear: { type: "string" },
            obligation: { type: "string" },
            respect: { type: "string" },
            knowledge: { type: "string" },
          },
        },
        requires_knowledge: { type: "string", description: "Optional required knowledge" },
        requires_capability: { type: "string", description: "Optional required capability" },
      },
      required: ["project_id", "simulation_id", "actor_a_id", "actor_b_id", "summary"],
    },
    handler: async (args) => {
      const pid = (args.project_id as number) ?? DEFAULT_PROJECT_ID;
      assertProject(pid);
      return await proposeRelationshipChange(
        pid,
        args.simulation_id as number,
        args.actor_a_id as number,
        args.actor_b_id as number,
        args.summary as string,
        (args.data as Record<string, string>) ?? {},
        { requiresKnowledge: args.requires_knowledge as string | undefined, requiresCapability: args.requires_capability as string | undefined }
      );
    },
  },
  {
    name: "list_relationships",
    description: "List all qualitative relationships between actors in a project.",
    inputSchema: {
      type: "object",
      properties: { project_id: { type: "integer", description: "Project ID (defaults to STORY_VAULT_PROJECT_ID)" } },
      required: [],
    },
    handler: async (args) => {
      const pid = (args.project_id as number) ?? DEFAULT_PROJECT_ID;
      assertProject(pid);
      return getProjectRelationships(pid);
    },
  },
  {
    name: "get_relationship",
    description: "Get one qualitative relationship between actors by ID.",
    inputSchema: {
      type: "object",
      properties: { relationship_id: { type: "integer", description: "Relationship ID" } },
      required: ["relationship_id"],
    },
    handler: async (args) => {
      const rid = args.relationship_id as number;
      const rel = getRelationshipById(rid);
      if (!rel) throw new Error(`Relationship #${rid} not found`);
      assertProject(rel.projectId);
      return rel;
    },
  },
  {
    name: "create_relationship",
    description: "Create a qualitative relationship between two actors in a project. Axes default to 'none'. Requires both actors to exist in the project.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "integer", description: "Project ID (defaults to STORY_VAULT_PROJECT_ID)" },
        actor_a_id: { type: "integer", description: "First actor ID" },
        actor_b_id: { type: "integer", description: "Second actor ID" },
        familiarity: { type: "string", description: "familiarity" },
        trust: { type: "string", description: "trust" },
        affection: { type: "string", description: "affection" },
        resentment: { type: "string", description: "resentment" },
        dependence: { type: "string", description: "dependence" },
        fear: { type: "string", description: "fear" },
        obligation: { type: "string", description: "obligation" },
        respect: { type: "string", description: "respect" },
        knowledge: { type: "string", description: "knowledge" },
        expectations: { type: "object", description: "Expectations record" },
        history: { type: "array", items: { type: "string" }, description: "Relationship history entries" },
      },
      required: ["actor_a_id", "actor_b_id"],
    },
    handler: async (args) => {
      const pid = (args.project_id as number) ?? DEFAULT_PROJECT_ID;
      assertProject(pid);
      const actorA = getDb().select().from(ccmActors).where(eq(ccmActors.id, args.actor_a_id as number)).get();
      const actorB = getDb().select().from(ccmActors).where(eq(ccmActors.id, args.actor_b_id as number)).get();
      if (!actorA || actorA.projectId !== pid) throw new Error(`Actor #${args.actor_a_id} does not exist in project #${pid}`);
      if (!actorB || actorB.projectId !== pid) throw new Error(`Actor #${args.actor_b_id} does not exist in project #${pid}`);
      const rel = createRelationship(pid, args.actor_a_id as number, args.actor_b_id as number, {
        familiarity: args.familiarity as string | undefined,
        trust: args.trust as string | undefined,
        affection: args.affection as string | undefined,
        resentment: args.resentment as string | undefined,
        dependence: args.dependence as string | undefined,
        fear: args.fear as string | undefined,
        obligation: args.obligation as string | undefined,
        respect: args.respect as string | undefined,
        knowledge: args.knowledge as string | undefined,
        expectations: args.expectations as Record<string, unknown> | undefined,
        history: args.history as string[] | undefined,
      });
      storageService.recomputeUsage(getLocalUserId());
      return rel;
    },
  },
  {
    name: "update_relationship",
    description: "Update qualitative axes of an existing relationship. Only provided fields change.",
    inputSchema: {
      type: "object",
      properties: {
        relationship_id: { type: "integer", description: "Relationship ID" },
        familiarity: { type: "string", description: "familiarity" },
        trust: { type: "string", description: "trust" },
        affection: { type: "string", description: "affection" },
        resentment: { type: "string", description: "resentment" },
        dependence: { type: "string", description: "dependence" },
        fear: { type: "string", description: "fear" },
        obligation: { type: "string", description: "obligation" },
        respect: { type: "string", description: "respect" },
        knowledge: { type: "string", description: "knowledge" },
        expectations: { type: "object", description: "Expectations record" },
        history: { type: "array", items: { type: "string" }, description: "Relationship history entries" },
      },
      required: ["relationship_id"],
    },
    handler: async (args) => {
      const rid = args.relationship_id as number;
      const rel = getRelationshipById(rid);
      if (!rel) throw new Error(`Relationship #${rid} not found`);
      assertProject(rel.projectId);
      const updated = updateRelationship(rid, {
        familiarity: args.familiarity as string | undefined,
        trust: args.trust as string | undefined,
        affection: args.affection as string | undefined,
        resentment: args.resentment as string | undefined,
        dependence: args.dependence as string | undefined,
        fear: args.fear as string | undefined,
        obligation: args.obligation as string | undefined,
        respect: args.respect as string | undefined,
        knowledge: args.knowledge as string | undefined,
        expectations: args.expectations as Record<string, unknown> | undefined,
        history: args.history as string[] | undefined,
      });
      storageService.recomputeUsage(getLocalUserId());
      return updated;
    },
  },
  {
    name: "delete_relationship",
    description: "Permanently delete a qualitative relationship by ID.",
    inputSchema: {
      type: "object",
      properties: { relationship_id: { type: "integer", description: "Relationship ID" } },
      required: ["relationship_id"],
    },
    handler: async (args) => {
      const rid = args.relationship_id as number;
      const rel = getRelationshipById(rid);
      if (!rel) throw new Error(`Relationship #${rid} not found`);
      assertProject(rel.projectId);
      deleteRelationship(rid);
      return { success: true, deleted_relationship_id: rid };
    },
  },

  // ─── Rule / constraint tools (world-authoring — required to build a rich MCP-only test world) ─
  {
    name: "list_rules",
    description: "List all CCM rules for a project (family, when/candidateEvents, priority, scope, enabled).",
    inputSchema: {
      type: "object",
      properties: { project_id: { type: "integer", description: "Project ID (defaults to STORY_VAULT_PROJECT_ID)" } },
      required: [],
    },
    handler: async (args) => {
      const pid = (args.project_id as number) ?? DEFAULT_PROJECT_ID;
      assertProject(pid);
      return getProjectRules(pid);
    },
  },
  {
    name: "create_rule",
    description: "Create a CCM rule (DSL). `family` is one of: actor, relationship, environment, biology, physics, social, temporal, narrative. `when` holds `{ conditions: [{field, op, value}], requiresPressure?, description? }`, `candidateEvents` holds possibilities (not certainties) with `{ id, summary, level, narrativeWeight, probability, stateChanges }`, `effects` holds rule-level side-effects. `scope` is the entity kind the rule ranges over (actor, environment, …).",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "integer", description: "Project ID (defaults to STORY_VAULT_PROJECT_ID)" },
        name: { type: "string", description: "Rule name" },
        family: { type: "string", enum: ["actor", "relationship", "environment", "biology", "physics", "social", "temporal", "narrative"], description: "Rule family" },
        when: { type: "object", description: "WHEN prerequisites: { conditions: [{field, op, value}], requiresPressure?, description? }" },
        candidateEvents: { type: "array", description: "Candidate events (possibilities): [{ id, summary, level, narrativeWeight, probability, stateChanges }, …]" },
        effects: { type: "array", description: "Rule-level stateChanges: [{ target, field, op, value }, …]" },
        priority: { type: "integer", description: "Sort priority (higher fires first)" },
        probability: { type: "number", description: "Rule probability (default 1)" },
        cooldown: { type: "integer", description: "Cooldown in ticks" },
        scope: { type: "string", description: "Scope kind: actor, environment, relationship, …" },
        enabled: { type: "boolean", description: "Enabled (default true)" },
      },
      required: ["project_id", "name"],
    },
    handler: async (args) => {
      const pid = (args.project_id as number) ?? DEFAULT_PROJECT_ID;
      assertProject(pid);
      return createRule(pid, args.name as string, {
        family: args.family as any,
        when: args.when as any,
        candidateEvents: args.candidateEvents as any,
        effects: args.effects as any,
        priority: args.priority as number | undefined,
        probability: args.probability as number | undefined,
        cooldown: args.cooldown as number | undefined,
        scope: args.scope as string | undefined,
        enabled: args.enabled as boolean | undefined,
      });
    },
  },
  {
    name: "update_rule",
    description: "Update a CCM rule's DSL fields (family, when, candidateEvents, effects, priority, probability, cooldown, scope, enabled). Only provided fields change.",
    inputSchema: {
      type: "object",
      properties: {
        rule_id: { type: "integer", description: "Rule ID" },
        name: { type: "string", description: "Rule name" },
        family: { type: "string", enum: ["actor", "relationship", "environment", "biology", "physics", "social", "temporal", "narrative"], description: "Rule family" },
        when: { type: "object", description: "WHEN prerequisites: { conditions: [{field, op, value}], requiresPressure?, description? }" },
        candidateEvents: { type: "array", description: "Candidate events (possibilities): [{ id, summary, level, narrativeWeight, probability, stateChanges }, …]" },
        effects: { type: "array", description: "Rule-level stateChanges: [{ target, field, op, value }, …]" },
        priority: { type: "integer", description: "Sort priority (higher fires first)" },
        probability: { type: "number", description: "Rule probability" },
        cooldown: { type: "integer", description: "Cooldown in ticks" },
        scope: { type: "string", description: "Scope kind: actor, environment, relationship, …" },
        enabled: { type: "boolean", description: "Enabled" },
      },
      required: ["rule_id"],
    },
    handler: async (args) => {
      const r = getRuleById(args.rule_id as number);
      if (!r) throw new Error(`Rule #${args.rule_id} not found`);
      assertProject(r.projectId);
      return updateRule(args.rule_id as number, {
        name: args.name as string | undefined,
        family: args.family as any,
        when: args.when as any,
        candidateEvents: args.candidateEvents as any,
        effects: args.effects as any,
        priority: args.priority as number | undefined,
        probability: args.probability as number | undefined,
        cooldown: args.cooldown as number | undefined,
        scope: args.scope as string | undefined,
        enabled: args.enabled as boolean | undefined,
      });
    },
  },
  {
    name: "delete_rule",
    description: "Delete a CCM rule by ID.",
    inputSchema: {
      type: "object",
      properties: { rule_id: { type: "integer", description: "Rule ID" } },
      required: ["rule_id"],
    },
    handler: async (args) => {
      const r = getRuleById(args.rule_id as number);
      if (!r) throw new Error(`Rule #${args.rule_id} not found`);
      assertProject(r.projectId);
      deleteRule(args.rule_id as number);
      return { success: true };
    },
  },
  {
    name: "validate_rule_target",
    description: "Read-only. Validates that every state-change target in a CCM rule (candidateEvents + effects) resolves against the current world (actors, environments, systems, relationships). Returns { resolved: [target…], unresolved: [{ target, kind, hint }] } with fuzzy 'did you mean …?' hints — use it before creating a rule to catch misnamed targets (e.g. environment 'TownSquare' vs 'HC_TownSquare').",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "integer", description: "Project ID (defaults to STORY_VAULT_PROJECT_ID)" },
        candidate_events: { type: "array", description: "Candidate events: [{ id, summary, level, narrativeWeight, probability, stateChanges: [{ target, field, op, value }] }]" },
        effects: { type: "array", description: "Rule-level stateChanges: [{ target, field, op, value }]" },
      },
      required: ["project_id"],
    },
    handler: async (args) => {
      const pid = (args.project_id as number) ?? DEFAULT_PROJECT_ID;
      assertProject(pid);
      const targets: string[] = [];
      const candidateEvents = (args.candidate_events as Array<Record<string, unknown>>) ?? [];
      for (const c of candidateEvents) {
        const changes = (c.stateChanges as Array<Record<string, unknown>>) ?? [];
        for (const ch of changes) if (typeof ch.target === "string") targets.push(ch.target);
      }
      const effects = (args.effects as Array<Record<string, unknown>>) ?? [];
      for (const e of effects) if (typeof e.target === "string") targets.push(e.target);
      const resolved: string[] = [];
      const unresolved: Array<{ target: string; kind: string; hint?: string }> = [];
      for (const t of targets) {
        const r = resolveRuleTarget(t);
        if (r.ok) resolved.push(t);
        else unresolved.push({ target: t, kind: r.kind, ...(r.hint ? { hint: r.hint } : {}) });
      }
      return { resolved, unresolved, total: targets.length };
    },
  },
  {
    name: "list_constraints",
    description: "List narrative constraints for a project (hard/soft/forbidden/range/temporal destinations).",
    inputSchema: {
      type: "object",
      properties: { project_id: { type: "integer", description: "Project ID (defaults to STORY_VAULT_PROJECT_ID)" } },
      required: [],
    },
    handler: async (args) => {
      const pid = (args.project_id as number) ?? DEFAULT_PROJECT_ID;
      assertProject(pid);
      return getProjectConstraints(pid);
    },
  },
  {
    name: "create_constraint",
    description: "Create a narrative constraint (a destination, NOT an instruction telling the engine how to reach it). E.g. two actors eventually become acquainted. `class`: hard/soft/forbidden/range/temporal.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "integer", description: "Project ID (defaults to STORY_VAULT_PROJECT_ID)" },
        name: { type: "string", description: "Constraint name" },
        class: { type: "string", enum: ["hard", "soft", "forbidden", "range", "temporal"], description: "Constraint class" },
        target: { type: "object", description: "Target description (what must eventually hold)" },
        description: { type: "string", description: "Longer human description" },
        deadline: { type: "integer", description: "Optional deadline in world minutes (deadline ≤ day*1440+minute)" },
        priority: { type: "integer", description: "Priority (default 1)" },
      },
      required: ["project_id", "name"],
    },
    handler: async (args) => {
      const pid = (args.project_id as number) ?? DEFAULT_PROJECT_ID;
      assertProject(pid);
      return createConstraint(pid, args.name as string, {
        class: args.class as any,
        target: args.target as any,
        description: args.description as string | undefined,
        deadline: args.deadline as number | undefined,
        priority: args.priority as number | undefined,
      });
    },
  },
  {
    name: "update_constraint",
    description: "Update a narrative constraint's class, target, description, deadline, or priority. Only provided fields change. `satisfied`/`satisfiedAt` can be set to mark a constraint as completed.",
    inputSchema: {
      type: "object",
      properties: {
        constraint_id: { type: "integer", description: "Constraint ID" },
        name: { type: "string", description: "Constraint name" },
        class: { type: "string", enum: ["hard", "soft", "forbidden", "range", "temporal"], description: "Constraint class" },
        target: { type: "object", description: "Target description (what must eventually hold)" },
        description: { type: "string", description: "Longer human description" },
        deadline: { type: "integer", description: "Optional deadline in world minutes" },
        priority: { type: "integer", description: "Priority" },
        satisfied: { type: "boolean", description: "Mark as satisfied (true) or unsatisfied (false)" },
        satisfiedAt: { type: "integer", description: "World-time tick when satisfied (optional)" },
      },
      required: ["constraint_id"],
    },
    handler: async (args) => {
      const c = getConstraintById(args.constraint_id as number);
      if (!c) throw new Error(`Constraint #${args.constraint_id} not found`);
      assertProject(c.projectId);
      return updateConstraint(args.constraint_id as number, {
        name: args.name as string | undefined,
        class: args.class as any,
        target: args.target as any,
        description: args.description as string | undefined,
        deadline: args.deadline as number | undefined,
        priority: args.priority as number | undefined,
        satisfied: args.satisfied as boolean | undefined,
        satisfiedAt: args.satisfiedAt as number | undefined,
      });
    },
  },
  {
    name: "delete_constraint",
    description: "Delete a narrative constraint by ID.",
    inputSchema: {
      type: "object",
      properties: { constraint_id: { type: "integer", description: "Constraint ID" } },
      required: ["constraint_id"],
    },
    handler: async (args) => {
      const c = getConstraintById(args.constraint_id as number);
      if (!c) throw new Error(`Constraint #${args.constraint_id} not found`);
      assertProject(c.projectId);
      deleteConstraint(args.constraint_id as number);
      return { success: true };
    },
  },

  // ─── Simulation / engine tools (CCE step loop gateway) ────────────────────
  // External LLMs can create simulation runs, advance the engine's step loop,
  // inspect the generated event history / causal ancestry / episodes /
  // skeletons, and render a skeleton into prose. The engine stays
  // deterministic: same seeds + same world ⇒ identical event streams.
  {
    name: "list_simulations",
    description: "List all simulation runs for a project.",
    inputSchema: {
      type: "object",
      properties: { project_id: { type: "integer", description: "Project ID (defaults to STORY_VAULT_PROJECT_ID)" } },
      required: [],
    },
    handler: async (args) => {
      const pid = (args.project_id as number) ?? DEFAULT_PROJECT_ID;
      assertProject(pid);
      return listSimulations(pid);
    },
  },
  {
    name: "create_simulation",
    description: "Create a new simulation run for a project. The engine reads the project's world model (actors, environments, systems, rules, relationships, constraints) from this run's config.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "integer", description: "Project ID (defaults to STORY_VAULT_PROJECT_ID)" },
        name: { type: "string", description: "Simulation name" },
        description: { type: "string", description: "Optional description" },
        world_seed: { type: "integer", description: "World seed (default 1) — affects world determinism" },
        simulation_seed: { type: "integer", description: "Simulation seed (default 1) — affects event generation" },
        settings: {
          type: "object",
          description: "Run settings: { tickMinutes?, maxEventsPerRun?, granularity? }",
          properties: {
            tickMinutes: { type: "integer" },
            maxEventsPerRun: { type: "integer" },
            granularity: { type: "string", enum: ["minute", "hour", "day"] },
          },
        },
      },
      required: ["project_id", "name"],
    },
    handler: async (args) => {
      const pid = (args.project_id as number) ?? DEFAULT_PROJECT_ID;
      assertProject(pid);
      const sim = createSimulation(pid, args.name as string, (args.description as string) ?? null, args.settings as any);
      if (!sim) throw new Error("Failed to create simulation");
      // createSimulation defaults to seeds 1/1; persist any requested seeds.
      if (args.world_seed !== undefined || args.simulation_seed !== undefined) {
        const seedUpdate = updateSimulation(sim.id, {
          ...(args.world_seed !== undefined ? { worldSeed: args.world_seed as number } : {}),
          ...(args.simulation_seed !== undefined ? { simulationSeed: args.simulation_seed as number } : {}),
        });
        return seedUpdate ?? sim;
      }
      return sim;
    },
  },
  {
    name: "get_simulation",
    description: "Get a simulation run's full config (seeds, clock, settings, status).",
    inputSchema: {
      type: "object",
      properties: { simulation_id: { type: "integer", description: "Simulation ID" } },
      required: ["simulation_id"],
    },
    handler: async (args) => {
      const sim = getSimulationById(args.simulation_id as number);
      if (!sim) throw new Error(`Simulation #${args.simulation_id} not found`);
      assertProject(sim.projectId);
      return sim;
    },
  },
  {
    name: "advance_simulation",
    description:
      "Advance the CCE engine's step loop for N ticks. The engine: advances the clock → drains the event queue → evaluates rules → rolls candidates (seeded PRNG) → validates → mutates world state → emits events → extracts episodes/skeletons. Returns counts + the engine summary. Deterministic for identical seeds + identical starting state.",
    inputSchema: {
      type: "object",
      properties: {
        simulation_id: { type: "integer", description: "Simulation ID" },
        ticks: { type: "integer", description: "Number of ticks/steps to run (1-1000)" },
      },
      required: ["simulation_id", "ticks"],
    },
    handler: async (args) => {
      const sim = getSimulationById(args.simulation_id as number);
      if (!sim) throw new Error(`Simulation #${args.simulation_id} not found`);
      assertProject(sim.projectId);
      const ticks = Math.max(1, Math.min(1000, Math.floor(args.ticks as number) || 1));
      return advanceSimulation(args.simulation_id as number, ticks);
    },
  },
  {
    name: "reset_simulation",
    description: "Clear a simulation's generated history (events, causal edges, queue, episodes, skeletons, snapshots). World model is untouched.",
    inputSchema: {
      type: "object",
      properties: { simulation_id: { type: "integer", description: "Simulation ID" } },
      required: ["simulation_id"],
    },
    handler: async (args) => {
      const sim = getSimulationById(args.simulation_id as number);
      if (!sim) throw new Error(`Simulation #${args.simulation_id} not found`);
      assertProject(sim.projectId);
      resetSimulation(args.simulation_id as number);
      return { success: true };
    },
  },
  {
    name: "snapshot_simulation",
    description: "Create a serialized world snapshot of a simulation for reproducibility / branching.",
    inputSchema: {
      type: "object",
      properties: { simulation_id: { type: "integer", description: "Simulation ID" } },
      required: ["simulation_id"],
    },
    handler: async (args) => {
      const sim = getSimulationById(args.simulation_id as number);
      if (!sim) throw new Error(`Simulation #${args.simulation_id} not found`);
      assertProject(sim.projectId);
      const id = insertSnapshot(args.simulation_id as number, 0, sim.clock as { day: number; minute: number }, sim);
      return { snapshotId: id };
    },
  },
  {
    name: "list_snapshots",
    description: "List serialized world snapshots of a simulation (newest first).",
    inputSchema: {
      type: "object",
      properties: { simulation_id: { type: "integer", description: "Simulation ID" } },
      required: ["simulation_id"],
    },
    handler: async (args) => {
      const sim = getSimulationById(args.simulation_id as number);
      if (!sim) throw new Error(`Simulation #${args.simulation_id} not found`);
      assertProject(sim.projectId);
      return listSnapshots(args.simulation_id as number);
    },
  },
  {
    name: "list_events",
    description: "List the generated event history of a simulation (newest first).",
    inputSchema: {
      type: "object",
      properties: {
        simulation_id: { type: "integer", description: "Simulation ID" },
        limit: { type: "integer", description: "Max events to return (default 500)" },
        level: { type: "string", enum: ["micro", "event"], description: "Filter by event level" },
      },
      required: ["simulation_id"],
    },
    handler: async (args) => {
      const sim = getSimulationById(args.simulation_id as number);
      if (!sim) throw new Error(`Simulation #${args.simulation_id} not found`);
      assertProject(sim.projectId);
      return listEvents(args.simulation_id as number, { limit: (args.limit as number) ?? 500, level: args.level as any });
    },
  },
  {
    name: "get_event",
    description: "Get a single generated event by ID (full record: trigger, action, transition, consequences, causalLoad, stateChanges...).",
    inputSchema: {
      type: "object",
      properties: { event_id: { type: "integer", description: "Event ID" } },
      required: ["event_id"],
    },
    handler: async (args) => {
      const event = getEventById(args.event_id as number);
      if (!event) throw new Error(`Event #${args.event_id} not found`);
      const sim = getSimulationById(event.simulationId);
      assertProject(sim!.projectId);
      return event;
    },
  },
  {
    name: "event_ancestry",
    description: "Walk the causal graph to find an event's causal parents/ancestors (why did this happen).",
    inputSchema: {
      type: "object",
      properties: {
        event_id: { type: "integer", description: "Event ID" },
        max_depth: { type: "integer", description: "Max depth to walk (default 5)" },
      },
      required: ["event_id"],
    },
    handler: async (args) => {
      const event = getEventById(args.event_id as number);
      if (!event) throw new Error(`Event #${args.event_id} not found`);
      const sim = getSimulationById(event.simulationId);
      assertProject(sim!.projectId);
      const ids = getEventAncestry(args.event_id as number, (args.max_depth as number) ?? 5);
      const events = ids.map((id) => getEventById(id)).filter(Boolean);
      return { eventId: event.id, ancestors: events };
    },
  },
  {
    name: "list_episodes",
    description: "List the story-extracted episodes of a simulation (clusters of events).",
    inputSchema: {
      type: "object",
      properties: { simulation_id: { type: "integer", description: "Simulation ID" } },
      required: ["simulation_id"],
    },
    handler: async (args) => {
      const sim = getSimulationById(args.simulation_id as number);
      if (!sim) throw new Error(`Simulation #${args.simulation_id} not found`);
      assertProject(sim.projectId);
      return listEpisodes(args.simulation_id as number);
    },
  },
  {
    name: "list_skeletons",
    description: "List the neutral scene skeletons produced by the story extractor for a simulation.",
    inputSchema: {
      type: "object",
      properties: { simulation_id: { type: "integer", description: "Simulation ID" } },
      required: ["simulation_id"],
    },
    handler: async (args) => {
      const sim = getSimulationById(args.simulation_id as number);
      if (!sim) throw new Error(`Simulation #${args.simulation_id} not found`);
      assertProject(sim.projectId);
      return listSkeletons(args.simulation_id as number);
    },
  },
  {
    name: "get_skeleton",
    description: "Get a single neutral scene skeleton by ID (purpose, beats, entry/exit state, turning point, ...).",
    inputSchema: {
      type: "object",
      properties: { skeleton_id: { type: "integer", description: "Skeleton ID" } },
      required: ["skeleton_id"],
    },
    handler: async (args) => {
      const skeleton = getSkeletonById(args.skeleton_id as number);
      if (!skeleton) throw new Error(`Skeleton #${args.skeleton_id} not found`);
      const sim = getSimulationById(skeleton.simulationId);
      assertProject(sim!.projectId);
      return skeleton;
    },
  },
  {
    name: "delete_skeleton",
    description: "Delete a scene skeleton by ID.",
    inputSchema: {
      type: "object",
      properties: { skeleton_id: { type: "integer", description: "Skeleton ID" } },
      required: ["skeleton_id"],
    },
    handler: async (args) => {
      const skeleton = getSkeletonById(args.skeleton_id as number);
      if (!skeleton) throw new Error(`Skeleton #${args.skeleton_id} not found`);
      const sim = getSimulationById(skeleton.simulationId);
      assertProject(sim!.projectId);
      deleteSkeleton(args.skeleton_id as number);
      return { success: true };
    },
  },
  {
    name: "render_skeleton",
    description:
      "Render a neutral scene skeleton into prose using the configured AI model. The result is STAGED as an agent proposal (nothing writes canon). Returns { proposalId, sceneId, sceneTitle, summary } — the caller/UI accepts or rejects the proposal. Mode-2 renderer.",
    inputSchema: {
      type: "object",
      properties: {
        skeleton_id: { type: "integer", description: "Skeleton ID" },
        scene_title: { type: "string", description: "Optional scene title (defaults to skeleton title)" },
      },
      required: ["skeleton_id"],
    },
    handler: async (args) => {
      return await renderSkeletonToProposal(args.skeleton_id as number, getLocalUserId(), { sceneTitle: args.scene_title as string | undefined });
    },
  },
];

// ─── MCP server setup ────────────────────────────────────────────────────────
/**
 * Configures the module with an already-open vault DB (used when the MCP
 * server is embedded in the running app process, instead of opening the
 * encrypted file itself).
 */
export function configureVault(
  dbInstance: BetterSQLite3Database<typeof schema>,
  userId: number
): void {
  db = dbInstance;
  localUserId = userId;
}

/**
 * Builds the MCP Server and registers the 37 tool handlers.
 * The vault must be configured first — either `initDb()` (standalone) or
 * `configureVault()` (embedded in the app).
 */
export function buildMcpServer(): Server {
  const server = new Server(
    { name: "story-vault", version: "2.0.0" },
    {
      capabilities: { tools: {} },
      instructions:
        CCM_CORE_LAW +
        "\n\nUse get_ccm_guidance for a specific framework rule instead of assuming or guessing it.",
    },
  );

  const toolMap = new Map<string, ToolDef>();
  const toolsList = TOOLS.map((t) => {
    toolMap.set(t.name, t);
    return { name: t.name, description: t.description, inputSchema: t.inputSchema };
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolsList }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const tool = toolMap.get(name);
    if (!tool) {
      return { content: [{ type: "text" as const, text: `Unknown tool: ${name}` }], isError: true };
    }
    // Enforce required fields from the tool's inputSchema before invoking the
    // handler — the SDK does not validate arguments for us, and leaking raw
    // SQLite/implementation errors (e.g. "NOT NULL constraint failed") to MCP
    // clients is unhelpful.
    const missing = missingRequiredFields(tool, (args as Record<string, unknown>) ?? {});
    if (missing.length > 0) {
      return {
        content: [{ type: "text" as const, text: `Missing required field${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}` }],
        isError: true,
      };
    }
    try {
      const result = await tool.handler((args as Record<string, unknown>) ?? {});
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
    }
  });

  return server;
}

/**
 * Returns the names of required tool arguments that are missing from `args`
 * (undefined or null). Uses the tool's `inputSchema.required` list.
 */
function missingRequiredFields(tool: ToolDef, args: Record<string, unknown>): string[] {
  const required = tool.inputSchema.required;
  if (!Array.isArray(required)) return [];
  return required.filter((field) => args[field] === undefined || args[field] === null);
}

/**
 * Starts a Streamable HTTP MCP server on `http://127.0.0.1:<port>/mcp`.
 *
 * Each new `initialize` request creates a fresh Server + transport pair,
 * allowing clients (Qwen Studio, etc.) to reconnect/reset sessions without
 * hitting "Server already initialized". The SDK can only `connect()` one
 * transport per `Server` instance, so a fresh Server is needed per session.
 *
 * `allowedHosts` controls the Host header validation (defaults to localhost).
 */
export async function startMcpHttpServer(
  port: number,
  allowedHosts?: string[]
): Promise<void> {
  // Map of session-ID → { server, transport } for active sessions.
  const sessions = new Map<
    string,
    { server: Server; transport: StreamableHTTPServerTransport }
  >();
  let lastSessionId = "none";

  const app = express();
  app.use(express.json());
  if (allowedHosts && allowedHosts.length > 0) {
    app.use(hostHeaderValidation(allowedHosts));
  } else {
    app.use(localhostHostValidation());
  }

  app.all("/mcp", async (req, res) => {
    try {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      const body = (req.body ?? {}) as { method?: string };

      // New initialize → create a fresh Server + transport (avoids "already initialized").
      if (body.method === "initialize") {
        const freshServer = buildMcpServer();
        const freshTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
        });
        await freshServer.connect(freshTransport);
        await freshTransport.handleRequest(req, res, req.body);
        // The session ID is set by the transport after handling initialize.
        if (freshTransport.sessionId) {
          sessions.set(freshTransport.sessionId, {
            server: freshServer,
            transport: freshTransport,
          });
          lastSessionId = freshTransport.sessionId;
        }
        // Prune old sessions (keep last 5 for a local app).
        if (sessions.size > 5) {
          const keys = Array.from(sessions.keys());
          for (const k of keys.slice(0, keys.length - 5)) {
            sessions.delete(k);
          }
        }
        return;
      }

      // Route to existing session.
      const target =
        (sessionId && sessions.get(sessionId)) ||
        sessions.get(lastSessionId);
      if (!target) {
        res.status(400).json({
          jsonrpc: "2.0",
          error: { code: -32000, message: "No active session" },
          id: null,
        });
        return;
      }
      await target.transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("MCP handler error:", err);
      if (!res.headersSent) {
        res.status(500).json({ error: "MCP handler error: " + (err instanceof Error ? err.message : String(err)) });
      }
    }
  });

  app.listen(port, "127.0.0.1", () => {
    console.error(`Story Vault MCP server (HTTP) listening on http://127.0.0.1:${port}/mcp`);
    debugLog(`HTTP transport listening on http://127.0.0.1:${port}/mcp`);
  });
}

/** Standalone entry point (dist/mcp.js): opens the vault, runs STDIO or HTTP. */
export async function runStandalone(): Promise<void> {
  initDb();
  const server = buildMcpServer();

  if (TRANSPORT_MODE === "http") {
    const httpHosts = process.env.STORY_VAULT_MCP_HOSTS
      ? ["127.0.0.1", "localhost", ...process.env.STORY_VAULT_MCP_HOSTS.split(",").map((s) => s.trim())]
      : undefined;
    await startMcpHttpServer(HTTP_PORT, httpHosts);
  } else {
    // STDIO transport (default).
    const transport = new StdioServerTransport();
    const origSend = transport.send.bind(transport);
    transport.send = async (msg) => {
      try {
        const parsed = msg as { method?: string; id?: unknown; result?: { content?: unknown[] } };
        const isErr = (msg as { error?: unknown }).error !== undefined;
        const contentLen = Array.isArray(parsed?.result?.content)
          ? (parsed.result.content as unknown[]).length
          : -1;
        debugLog(
          `STDIO send: ${isErr ? "error" : "response"} id=${JSON.stringify(parsed.id)} method=${JSON.stringify(
            parsed.method
          )} contentParts=${contentLen}`
        );
      } catch { /* ignore */ }
      return origSend(msg);
    };
    transport.onmessage = (msg) => {
      try {
        const parsed = msg as {
          method?: string;
          id?: unknown;
          params?: {
            protocolVersion?: string;
            capabilities?: unknown;
            name?: string;
            arguments?: unknown;
          };
        };
        if (parsed?.method === "initialize") {
          debugLog(
            `STDIO recv: initialize id=${JSON.stringify(parsed.id)} protocolVersion=${JSON.stringify(
              parsed.params?.protocolVersion
            )} capabilities=${JSON.stringify(parsed.params?.capabilities)}`
          );
        } else if (parsed?.method === "tools/call") {
          debugLog(
            `STDIO recv: tools/call id=${JSON.stringify(parsed.id)} tool=${JSON.stringify(
              parsed.params?.name
            )} args=${JSON.stringify(parsed.params?.arguments)}`
          );
        } else {
          debugLog(`STDIO recv: ${parsed?.method ?? "response"} id=${JSON.stringify(parsed?.id)}`);
        }
      } catch { /* ignore */ }
    };
    transport.onerror = (err) => {
      debugLog(`STDIO transport error: ${err.message}`);
    };
    transport.onclose = () => {
      debugLog("STDIO transport closed");
    };
    await server.connect(transport);
    debugLog("STDIO transport connected — server ready");
    console.error("Story Vault MCP server (STDIO) running");
  }
}
