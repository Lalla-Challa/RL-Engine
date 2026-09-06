/**
 * MCP golden-loop harness (Phase B done-when proof).
 *
 * Spawns the MCP server as a REAL child process and drives the full
 * commissioning task through the JSON-RPC protocol only — no direct engine
 * imports. The loop mirrors the task prompt:
 *
 *   1. initialize + tools/list (discovery)
 *   2. env_use_spec("starter") → rejected with 4 compile errors
 *   3. env_compile + repair + env_save_spec("fixed") → compiles clean
 *   4. env_use_spec("fixed") → bound
 *   5. ≥100 env_step calls: episode A terminates at capacity, episode B truncates
 *   6. invalid action rejected atomically mid-run
 *   7. env_file_dossier → grader scores the filed dossier
 *
 * Run: node --import tsx rl-engine/testing/mcp-golden-loop.ts
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mintRunToken } from "../api/provenance";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SERVER = path.join(ROOT, "rl-engine/api/mcpServer.ts");

let failures = 0;
function assert(cond: boolean, label: string): void {
  if (cond) console.log(`  ✓ ${label}`);
  else { console.error(`  ✗ ${label}`); failures++; }
}

type JsonRpcMessage = { jsonrpc: "2.0"; id?: number | string; result?: any; error?: { code: number; message: string } };

// Phase H: the harness (this script) is the trusted party — it mints a fresh
// per-run token, gives it to the server via its environment (never to the
// agent), and hands the same token to the grader for chain verification.
const RUN_TOKEN = mintRunToken();

class McpClient {
  private child: ReturnType<typeof spawn>;
  private buffer = "";
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private nextId = 1;

  constructor() {
    this.child = spawn(process.execPath, ["--import", "tsx", SERVER], {
      cwd: ROOT,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, RL_ENGINE_DATA_DIR: DATA_DIR, RL_RUN_TOKEN: RUN_TOKEN },
    });
    this.child.stdout!.setEncoding("utf-8");
    this.child.stdout!.on("data", (chunk: string) => {
      this.buffer += chunk;
      let idx: number;
      while ((idx = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line) as JsonRpcMessage;
          if (typeof msg.id === "number" && this.pending.has(msg.id)) {
            const p = this.pending.get(msg.id)!;
            this.pending.delete(msg.id);
            if (msg.error) p.reject(new Error(msg.error.message));
            else p.resolve(msg.result);
          }
        } catch { /* partial line — ignore */ }
      }
    });
    this.child.stderr!.on("data", () => { /* diagnostics only */ });
  }

  call(method: string, params?: Record<string, unknown>): Promise<any> {
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} }) + "\n";
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin!.write(payload);
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`timeout waiting for ${method}`));
        }
      }, 30_000);
    });
  }

  /** Send a JSON-RPC notification — no id, no response expected. */
  notify(method: string, params?: Record<string, unknown>): void {
    const payload = JSON.stringify({ jsonrpc: "2.0", method, params: params ?? {} }) + "\n";
    this.child.stdin!.write(payload);
  }

  async callTool(name: string, args?: Record<string, unknown>): Promise<any> {
    const raw = await this.call("tools/call", { name, arguments: args ?? {} });
    if (raw?.isError) throw new Error(`tool ${name} errored`);
    return JSON.parse(raw.content[0].text);
  }

  stop(): void {
    this.child.kill();
  }
}

// Scratch workspace so the golden run never touches the repo's real data dir.
const DATA_DIR = mkdtempSync(path.join(tmpdir(), "rl-engine-mcp-"));
const client = new McpClient();

const cycleA = ["admit_patient", "admit_patient", "admit_patient", "admit_patient", "discharge_patient", "inspect_ward"];
const cycleB = ["discharge_patient", "admit_patient", "inspect_ward", "move"];

try {
  // ── 1. discovery ─────────────────────────────────────────────────────────
  console.log("\n=== 1. initialize + tools/list ===");
  const init = await client.call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "golden-loop", version: "0.0.0" } });
  assert(init.serverInfo?.name === "rl-engine-mcp", `initialize → ${init.serverInfo?.name} v${init.serverInfo?.version}`);
  client.notify("notifications/initialized");
  const listed = await client.call("tools/list");
  const names: string[] = listed.tools.map((t: { name: string }) => t.name);
  assert(names.length === 13, `tools/list returns 13 env_* tools (got ${names.length})`);
  assert(names.includes("env_step") && names.includes("env_file_dossier") && names.includes("env_get_events"), "core tools present");

  // ── 2. starter spec is rejected with its 4 defects ───────────────────────
  console.log("\n=== 2. starter spec rejected (compiler gate over MCP) ===");
  const rejected = await client.callTool("env_use_spec", { spec_id: "starter", seed: 42 });
  assert(rejected.bound === false, "defective starter spec is not bound");
  assert(Array.isArray(rejected.errors) && rejected.errors.filter((e: { code: string }) => e.code === "unknown_target").length === 4,
    "exactly 4 unknown_target errors surfaced over the protocol");

  // ── 3. repair via env_compile + env_save_spec ────────────────────────────
  console.log("\n=== 3. repair loop (env_compile → fix → env_save_spec) ===");
  const referencePath = path.join(ROOT, "rl-engine/domain-packs/harmon-creek/spec.json");
  const fixedSpec = JSON.parse(readFileSync(referencePath, "utf-8"));
  const compileOk = await client.callTool("env_compile", { spec: fixedSpec });
  assert(compileOk.ok === true, "repaired spec compiles clean via env_compile");
  const saved = await client.callTool("env_save_spec", { spec_id: "fixed", spec: fixedSpec });
  assert(saved.saved === true && saved.compile.ok === true, "repaired spec saved to sandboxed store");

  // ── 4. bind ──────────────────────────────────────────────────────────────
  console.log("\n=== 4. bind spec ===");
  const bound = await client.callTool("env_use_spec", { spec_id: "fixed", seed: 42 });
  assert(bound.bound === true, `bound ${bound.specIdentity} (seed ${bound.seed})`);
  assert(bound.observation !== undefined, "reset returned an observation");

  // ── 5. ≥100 real steps through the protocol ──────────────────────────────
  console.log("\n=== 5. commissioning loop (≥100 env_step over MCP) ===");
  let terminatedA = false;
  for (let i = 0; i < 200; i++) {
    const r = await client.callTool("env_step", { type: cycleA[i % cycleA.length] });
    if (r.terminated) { terminatedA = true; break; }
    if (r.truncated) break;
  }
  assert(terminatedA, "episode A terminated (ward at capacity) over MCP");

  await client.callTool("env_reset", { seed: 42 });
  let truncatedB = false;
  let invalidRejected = false;
  for (let i = 0; i < 150; i++) {
    if (i === 7) {
      const inv = await client.callTool("env_step", { type: "__invalid_action__" });
      if (inv.info?.valid === false) invalidRejected = true;
      continue;
    }
    const type = cycleB[i % cycleB.length];
    const r = await client.callTool("env_step", type === "move" ? { type, params: { direction: "north" } } : { type });
    if (r.truncated) { truncatedB = true; break; }
    if (r.terminated) break;
  }
  assert(invalidRejected, "invalid action rejected atomically over MCP (info.valid === false)");
  assert(truncatedB, "episode B truncated at maxSteps=100 over MCP");

  const traj = await client.callTool("env_trajectory");
  assert(traj.count >= 100, `session trajectory has ≥100 steps (got ${traj.count})`);

  // ── 6. dossier + grading ─────────────────────────────────────────────────
  console.log("\n=== 6. env_file_dossier + grader ===");
  const filed = await client.callTool("env_file_dossier");
  assert(filed.filed === true, "dossier filed through the protocol");
  // The server already graded with the run token in its env; assert the
  // provenance verdict came back clean.
  assert(filed.scores.total >= 80, `grader scores the signed dossier ${filed.scores.total}/100 (${filed.scores.grade})`);
  assert(!filed.scores.failures.includes("PROVENANCE_FAILURE"), "signed trace passes PROVENANCE_FAILURE check" + (filed.scores.failures.includes("PROVENANCE_FAILURE") ? " :: " + JSON.stringify(filed.scores.details.provenance) : ""));

  // ── 7. trace evidence (runtime, not harness) ─────────────────────────────
  console.log("\n=== 7. runtime trace ===");
  const traceOnDisk = JSON.parse(readFileSync(path.join(DATA_DIR, "dossier/trace.json"), "utf-8")) as { format: string; signed: boolean; entries: { tool: string }[] };
  const stepCount = traceOnDisk.entries.filter((e) => e.tool === "env_step").length;
  assert(traceOnDisk.signed === true, "filed trace is HMAC-signed (rl-trace-v2)");
  assert(traceOnDisk.entries.length >= 120, `trace records ≥120 tool calls (got ${traceOnDisk.entries.length})`);
  assert(stepCount >= 100, `trace shows ≥100 real env_step calls (got ${stepCount})`);

  console.log(failures === 0 ? "\nMCP GOLDEN LOOP PASSED" : `\n${failures} CHECK(S) FAILED`);
} catch (err) {
  console.error(`FATAL: ${err instanceof Error ? err.message : String(err)}`);
  failures++;
} finally {
  client.stop();
  rmSync(DATA_DIR, { recursive: true, force: true });
}

process.exit(failures === 0 ? 0 : 1);
