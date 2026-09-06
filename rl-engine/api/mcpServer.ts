#!/usr/bin/env node
/**
 * Generic Environment MCP Server (Phase B).
 *
 * Speaks JSON-RPC 2.0 over stdio with MCP-style framing (Initialize /
 * tools/list / tools/call), zero dependencies. Exposes the generic §21 API
 * as `env_*` tools — the canon gate holds: nothing mutates world state
 * except `env_step` (and `env_reset`, which starts a new episode).
 *
 * Environment:
 *   RL_ENGINE_DATA_DIR      — workspace dir for saved specs + dossier (default <repo>/data)
 *   RL_ENGINE_TRACE_FILE    — where the call trace is written (default <dataDir>/trace.json)
 *   RL_ENGINE_SPEC_BUILTIN  — optional ";"-seeded list of `<id>=<label>=<file>` builtin specs
 *
 * Framing: newline-delimited JSON-RPC (LSP-style Content-Length framing is
 * also accepted for requests).
 */

import readline from "node:readline";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Action, Environment, EnvironmentSpecification } from "../core/types";
import { compileEnvironment } from "../environment/compiler";
import { validateEnvironment } from "../environment/validator";
import { specId, checkSpecVersion } from "../environment/specification";
import { createEnvironment } from "../environment/environment";
import { TrajectoryRecorder } from "../episode/trajectory";
import type { TrajectoryStep } from "../episode/trajectory";
import { gradeDossier, findReferenceSpec, ruleIntegrityDivergences } from "../../benchmark/grader/grader";
import { TraceWriter } from "./trace";
import { SpecStore } from "./specStore";

// ── config ───────────────────────────────────────────────────────────────────

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DATA_DIR = process.env.RL_ENGINE_DATA_DIR
  ? path.resolve(process.env.RL_ENGINE_DATA_DIR)
  : path.join(ROOT, "data");
const TRACE_FILE = process.env.RL_ENGINE_TRACE_FILE
  ? path.resolve(process.env.RL_ENGINE_TRACE_FILE)
  : path.join(DATA_DIR, "trace.json");
/** Phase H: per-run token minted by the trusted harness; never exposed to the
 *  agent. Present → the trace is HMAC-signed and the dossier is gradeable. */
const RUN_TOKEN = process.env.RL_RUN_TOKEN;

function parseBuiltins(): { id: string; label: string; file: string }[] {
  const out: { id: string; label: string; file: string }[] = [];
  for (const part of (process.env.RL_ENGINE_SPEC_BUILTIN ?? "").split(";")) {
    const m = /^([^=]+)=([^=]+)=(.+)$/.exec(part.trim());
    if (m) out.push({ id: m[1], label: m[2], file: path.resolve(m[3]) });
  }
  // Fallback so a bare `node api/mcpServer.ts` still has something to serve.
  if (out.length === 0) {
    const starter = path.join(ROOT, "benchmark/scenario/spec.json");
    const reference = path.join(ROOT, "rl-engine/domain-packs/harmon-creek/spec.json");
    if (fs.existsSync(starter)) out.push({ id: "starter", label: "Starter spec (4 deliberate defects)", file: starter });
    if (fs.existsSync(reference)) out.push({ id: "harmon-creek", label: "Harmon Creek Regional Hospital (reference)", file: reference });
    const extra: [string, string, string][] = [
      ["insurance-claims", "Insurance Claims Center (reference)", "rl-engine/domain-packs/insurance-claims/spec.json"],
      ["legal-filing", "Legal Filing Office (reference)", "rl-engine/domain-packs/legal-filing/spec.json"],
      ["hr-onboarding", "HR Onboarding Hub (reference)", "rl-engine/domain-packs/hr-onboarding/spec.json"],
      ["hospital-billing", "Hospital Billing Bridge (reference)", "rl-engine/domain-packs/hospital-billing/spec.json"],
    ];
    for (const [id, label, rel] of extra) {
      const file = path.join(ROOT, rel);
      if (fs.existsSync(file)) out.push({ id, label, file });
    }
  }
  return out;
}

// ── session state ────────────────────────────────────────────────────────────

const trace = new TraceWriter(TRACE_FILE, RUN_TOKEN);
const store = new SpecStore(DATA_DIR, parseBuiltins());

type Session = {
  spec: EnvironmentSpecification | null;
  specRef: string | null;
  env: Environment | null;
  seed: number | string | null;
  recorder: TrajectoryRecorder | null;
  stepCounter: number;
  terminated: boolean;
  truncated: boolean;
  /** Completed episode segments: [{seed, steps}] — replay evidence for the grader. */
  episodes: { seed: number | string; steps: number }[];
  /** Seed the current episode segment started with. */
  segmentSeed: number | string | null;
  /** Steps recorded in the current segment so far. */
  segmentSteps: number;
};

const session: Session = {
  spec: null, specRef: null, env: null, seed: null, recorder: null,
  stepCounter: 0, terminated: false, truncated: false, episodes: [],
  segmentSeed: null, segmentSteps: 0,
};

function requireEnv(): Environment {
  if (!session.env) throw new Error("no environment bound — call env_use_spec first");
  return session.env;
}

function requireSpec(): EnvironmentSpecification {
  if (!session.spec) throw new Error("no spec bound — call env_use_spec first");
  return session.spec;
}

function bindSession(spec: EnvironmentSpecification, ref: string, seed: number | string): void {
  session.spec = spec;
  session.specRef = ref;
  session.env = createEnvironment(spec, seed);
  session.env.reset(seed);
  session.seed = seed;
  session.recorder = new TrajectoryRecorder();
  session.stepCounter = 0;
  session.terminated = false;
  session.truncated = false;
  session.episodes = [];
  session.segmentSeed = seed;
  session.segmentSteps = 0;
}

function recordStep(action: Action, result: ReturnType<Environment["step"]>): void {
  session.recorder?.record({
    observation: result.observation,
    action: action as unknown as TrajectoryStep["action"],
    reward: result.reward,
    rewardComponents: result.rewardComponents,
    nextObservation: result.observation,
    terminated: result.terminated,
    truncated: result.truncated,
    state: result.state ?? {},
  });
  session.segmentSteps++;
  if (result.terminated) session.terminated = true;
  if (result.truncated) session.truncated = true;
}

// ── tools ────────────────────────────────────────────────────────────────────

const TOOLS: {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => unknown;
}[] = [
  {
    name: "env_list_specs",
    description: "List available environment specifications (builtin seeded + saved).",
    inputSchema: { type: "object", properties: {}, required: [] },
    handler: () => ({ specs: store.list() }),
  },
  {
    name: "env_get_specification",
    description: "Return the full EnvironmentSpecification currently bound to the session.",
    inputSchema: { type: "object", properties: {}, required: [] },
    handler: () => requireSpec(),
  },
  {
    name: "env_compile",
    description: "Compile + validate a spec object WITHOUT binding it. Returns { ok, errors, warnings } (§32/§33) — use this to inspect a defective spec before repair.",
    inputSchema: { type: "object", properties: { spec: { type: "object", description: "EnvironmentSpecification JSON" } }, required: ["spec"] },
    handler: (args) => {
      const spec = args.spec as EnvironmentSpecification;
      const compiled = compileEnvironment(spec);
      const validated = compiled.ok ? validateEnvironment(spec) : null;
      return {
        ok: compiled.ok && (validated?.valid ?? false),
        errors: [...compiled.errors, ...(validated?.valid ? [] : (validated?.errors ?? []))],
        warnings: compiled.warnings,
      };
    },
  },
  {
    name: "env_save_spec",
    description: "Persist a spec object under an id in the sandboxed spec store. Mutates the spec store only — never world state. Returns the compile report for convenience.",
    inputSchema: { type: "object", properties: { spec_id: { type: "string" }, spec: { type: "object" } }, required: ["spec_id", "spec"] },
    handler: (args) => {
      const saved = store.save(args.spec_id as string, args.spec as EnvironmentSpecification);
      const compiled = compileEnvironment(args.spec as EnvironmentSpecification);
      return { ...saved, compile: { ok: compiled.ok, errorCount: compiled.errors.length, warnings: compiled.warnings } };
    },
  },
  {
    name: "env_use_spec",
    description:
      "Bind a spec by id (from env_list_specs) or an inline spec object and reset(seed). Defective specs are NOT bound — the response carries the compile errors so you can repair and retry.",
    inputSchema: {
      type: "object",
      properties: { spec_id: { type: "string" }, spec: { type: "object" }, seed: { description: "number or string (default 42)" } },
      required: [],
    },
    handler: (args) => {
      let spec: EnvironmentSpecification | null = null;
      let ref = "";
      if (typeof args.spec_id === "string") {
        spec = store.get(args.spec_id);
        if (!spec) throw new Error(`unknown spec id: ${args.spec_id}`);
        ref = args.spec_id;
      } else if (args.spec && typeof args.spec === "object") {
        spec = args.spec as EnvironmentSpecification;
        ref = "inline";
      } else {
        throw new Error("provide spec_id or spec");
      }
      const compiled = compileEnvironment(spec);
      if (!compiled.ok) {
        return {
          bound: false,
          errors: compiled.errors,
          warnings: compiled.warnings,
          hint: "fix the errors (env_save_spec the repaired spec, then env_use_spec again)",
        };
      }
      const seed = args.seed !== undefined ? (args.seed as number | string) : 42;
      bindSession(spec, ref, seed);
      // Run-06 R6 (bind-time provenance, informational): when a domain
      // reference exists, report rule-integrity divergences at bind time
      // instead of only at dossier time. Never blocks — repairing the
      // defective starter requires binding modified specs.
      let complianceNotice: string[] | undefined;
      if (compiled.ok) {
        const refSpec = findReferenceSpec(ROOT, spec.environment?.id);
        if (refSpec) {
          const divergences = ruleIntegrityDivergences(spec, refSpec);
          if (divergences.length > 0) complianceNotice = divergences;
        }
      }
      return {
        bound: true,
        spec_id: ref,
        specIdentity: specId(spec),
        spec_version: checkSpecVersion(spec),
        ...(complianceNotice ? { complianceNotice } : {}),
        seed,
        observation: session.env!.reset(seed).observation,
      };
    },
  },
  {
    name: "env_step",
    description:
      "Advance one step: { type, params? }. Runs the 6-layer pipeline (§15) atomically (§16) — rejected actions never mutate state and return info.valid=false with the failing layer.",
    inputSchema: {
      type: "object",
      properties: { type: { type: "string" }, params: { type: "object", description: "optional action parameters" } },
      required: ["type"],
    },
    handler: (args) => {
      const env = requireEnv();
      const action: Action = { type: args.type as string, ...(args.params !== undefined ? { params: args.params as Record<string, unknown> } : {}) };
      const result = env.step(action);
      recordStep(action, result);
      return result;
    },
  },
  {
    name: "env_reset",
    description: "Reset the bound environment (optionally with a new seed) and start a fresh trajectory.",
    inputSchema: { type: "object", properties: { seed: { description: "number or string (default: last used seed)" } }, required: [] },
    handler: (args) => {
      const env = requireEnv();
      const seed = args.seed !== undefined ? (args.seed as number | string) : session.seed ?? 42;
      // Close out the previous segment on EVERY reset — including abandoned
      // (non-terminal) ones. The recorder accumulates across episodes, and the
      // grader replays per-segment from manifest boundaries; dropping an
      // abandoned segment here desynchronizes the manifest from the trajectory
      // and flags every later segment STALE_RECORD (run-06 R5 false positives).
      if (session.segmentSeed !== null && session.segmentSteps > 0) {
        session.episodes.push({ seed: session.segmentSeed, steps: session.segmentSteps });
      }
      const result = env.reset(seed);
      // NOTE: stepCounter is intentionally NOT reset — trace stepIndex maps
      // 1:1 onto trajectory positions across the whole run (F4 cross-check).
      session.terminated = false;
      session.truncated = false;
      session.seed = seed;
      session.segmentSeed = seed;
      session.segmentSteps = 0;
      return result;
    },
  },
  {
    name: "env_get_action_space",
    description: "Return the bound environment's ActionSpace definitions (§5).",
    inputSchema: { type: "object", properties: {}, required: [] },
    handler: () => requireEnv().getActionSpace(),
  },
  {
    name: "env_get_observation_space",
    description: "Return the bound environment's ObservationSpace definition (§17).",
    inputSchema: { type: "object", properties: {}, required: [] },
    handler: () => requireEnv().getObservationSpace(),
  },
  {
    name: "env_get_state",
    description: "Return the full internal state (a superset of the observation when partially observable).",
    inputSchema: { type: "object", properties: {}, required: [] },
    handler: () => requireEnv().getState(),
  },
  {
    name: "env_get_events",
    description: "Return the event log (§24): one event per step with causal parent links (§25) — the evidence the grader walks for causality scoring.",
    inputSchema: { type: "object", properties: {}, required: [] },
    handler: () => ({ events: session.env?.getEvents?.() ?? [] }),
  },
  {
    name: "env_trajectory",
    description: "Return the session trajectory so far (steps, rewards, components, terminations).",
    inputSchema: { type: "object", properties: {}, required: [] },
    handler: () => {
      const steps = session.recorder?.getTrajectory() ?? [];
      return { count: steps.length, steps };
    },
  },
  {
    name: "env_file_dossier",
    description:
      "File the dossier: writes trajectory.json, spec-snapshot.json, events.json, manifest.json (seeds + episode segments + claimedChains) and trace.json into the dossier dir, then grades THAT dossier. Pass claimed_chains (arrays of event ids) to claim causal chains — the grader verifies each claimed edge exists in the event graph. Refuses while the episode is still running.",
    inputSchema: {
      type: "object",
      properties: { claimed_chains: { type: "array", items: { type: "array", items: { type: "string" } }, description: "claimed causal chains as event-id paths [ancestor, …, descendant]" } },
      required: [],
    },
    handler: (args) => {
      const spec = requireSpec();
      const steps = session.recorder?.getTrajectory() ?? [];
      if (steps.length === 0) throw new Error("nothing to file — run env_step first");
      if (!session.terminated && !session.truncated) {
        throw new Error("PREMATURE_FILING: episode still running — reach terminated/truncated before filing");
      }
      const episodes = [...session.episodes];
      if (session.segmentSeed !== null && session.segmentSteps > 0) {
        episodes.push({ seed: session.segmentSeed, steps: session.segmentSteps });
      }

      const dossierDir = path.join(DATA_DIR, "dossier");
      fs.mkdirSync(dossierDir, { recursive: true });
      fs.writeFileSync(path.join(dossierDir, "trajectory.json"), JSON.stringify(steps, null, 2), "utf-8");
      fs.writeFileSync(path.join(dossierDir, "spec-snapshot.json"), JSON.stringify(spec, null, 2), "utf-8");
      fs.writeFileSync(path.join(dossierDir, "events.json"), JSON.stringify(session.env?.getEvents?.() ?? [], null, 2), "utf-8");
      const traceFile = trace.export();
      fs.writeFileSync(path.join(dossierDir, "trace.json"), JSON.stringify(traceFile, null, 2), "utf-8");
      fs.writeFileSync(path.join(dossierDir, "manifest.json"), JSON.stringify({
        spec_id: session.specRef,
        specIdentity: specId(spec),
        episodes,
        claimedChains: Array.isArray(args.claimed_chains) ? args.claimed_chains : [],
        provenance: {
          signed: traceFile.signed,
          algorithm: traceFile.algorithm,
          chainHead: traceFile.chainHead,
          entries: traceFile.entries.length,
        },
      }, null, 2), "utf-8");
      const scores = gradeDossier(dossierDir, { repoRoot: ROOT, write: true, runToken: RUN_TOKEN });
      return { filed: true, dossierDir, scores };
    },
  },
];

// ── JSON-RPC plumbing (MCP stdio framing) ────────────────────────────────────

function send(msg: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function handleRequest(req: { jsonrpc: string; id?: number | string | null; method: string; params?: Record<string, unknown> }): void {
  const isNotification = req.id === undefined || req.id === null;
  const respond = (result: unknown): void => {
    if (!isNotification) send({ jsonrpc: "2.0", id: req.id, result });
  };
  const respondError = (code: number, message: string): void => {
    if (!isNotification) send({ jsonrpc: "2.0", id: req.id, error: { code, message } });
  };

  if (req.method === "initialize") {
    trace.record("initialize", req.params ?? {});
    respond({
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "rl-engine-mcp", version: "0.1.0" },
    });
    return;
  }
  if (req.method === "notifications/initialized") return;
  if (req.method === "ping") { respond({}); return; }

  if (req.method === "tools/list") {
    respond({ tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) });
    return;
  }

  if (req.method === "tools/call") {
    const name = String(req.params?.name ?? "");
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) { respondError(-32602, `unknown tool: ${name}`); return; }
    const args = (req.params?.arguments ?? {}) as Record<string, unknown>;
    try {
      const stepIndex = name === "env_step" ? ++session.stepCounter : undefined;
      trace.record(name, args, stepIndex);
      const result = tool.handler(args);
      respond({ content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      respond({ content: [{ type: "text", text: JSON.stringify({ isError: true, error: message }, null, 2) }], isError: true });
    }
    return;
  }

  respondError(-32601, `method not found: ${req.method}`);
}

function main(): void {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    // Newline-delimited JSON, with optional LSP-style Content-Length framing.
    const framed = /^(?:Content-Length:\s*\d+\s*\r?\n\r?\n)?(\{[\s\S]*\})$/.exec(trimmed);
    const body = framed ? framed[1] : trimmed;
    let req: { jsonrpc: string; id?: number | string | null; method: string; params?: Record<string, unknown> };
    try {
      req = JSON.parse(body) as typeof req;
    } catch {
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
      return;
    }
    if (req.jsonrpc !== "2.0" || typeof req.method !== "string") {
      send({ jsonrpc: "2.0", id: req.id ?? null, error: { code: -32600, message: "invalid request" } });
      return;
    }
    handleRequest(req);
  });
  rl.on("close", () => process.exit(0));
}

// Only run the stdio loop when executed directly (not when imported).
const invoked = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invoked === fileURLToPath(import.meta.url)) main();

export { TOOLS, handleRequest, session, store, trace };
