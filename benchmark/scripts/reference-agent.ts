/**
 * Headless reference agent (Phase C) — a scripted, non-LLM client that drives
 * the MCP server through the exact golden loop and files a perfect dossier.
 * Pure stdio JSON-RPC; no API keys, no network.
 *
 * Run:      node --import tsx benchmark/scripts/reference-agent.ts
 * Output:   <outDir> (default benchmark/fixtures/golden) — a complete dossier
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mintRunToken } from "../../rl-engine/api/provenance";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SERVER = path.join(ROOT, "rl-engine/api/mcpServer.ts");

class McpClient {
  private child: ReturnType<typeof spawn>;
  private buffer = "";
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private nextId = 1;

  constructor(dataDir: string, runToken: string) {
    this.child = spawn(process.execPath, ["--import", "tsx", SERVER], {
      cwd: ROOT,
      stdio: ["pipe", "pipe", "ignore"],
      env: { ...process.env, RL_ENGINE_DATA_DIR: dataDir, RL_RUN_TOKEN: runToken },
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
          const msg = JSON.parse(line);
          if (typeof msg.id === "number" && this.pending.has(msg.id)) {
            const p = this.pending.get(msg.id)!;
            this.pending.delete(msg.id);
            msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
          }
        } catch { /* ignore */ }
      }
    });
  }
  call(method: string, params?: Record<string, unknown>): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} }) + "\n");
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`timeout ${method}`)); } }, 30_000);
    });
  }
  /** JSON-RPC notification — no id, no response expected. */
  notify(method: string, params?: Record<string, unknown>): void {
    this.child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method, params: params ?? {} }) + "\n");
  }
  async callTool(name: string, args?: Record<string, unknown>): Promise<any> {
    const raw = await this.call("tools/call", { name, arguments: args ?? {} });
    if (raw?.isError) throw new Error(`tool ${name} errored`);
    return JSON.parse(raw.content[0].text);
  }
  stop(): void { this.child.kill(); }
}

const cycleA = ["admit_patient", "admit_patient", "admit_patient", "admit_patient", "discharge_patient", "inspect_ward"];
const cycleB = ["discharge_patient", "admit_patient", "inspect_ward", "move"];

async function main(): Promise<void> {
  // ── CLI: <outDir> [--spec <path>] [--starter <path>] [--seed <n>] ──────────
  const args = process.argv.slice(2);
  const outDir = path.resolve(args[0] && !args[0].startsWith("--") ? args[0] : path.join(ROOT, "benchmark/fixtures/golden"));
  const specPath = args.includes("--spec") ? path.resolve(args[args.indexOf("--spec") + 1]) : path.join(ROOT, "rl-engine/domain-packs/harmon-creek/spec.json");
  const starterPath = args.includes("--starter") ? path.resolve(args[args.indexOf("--starter") + 1]) : path.join(ROOT, "benchmark/scenario/spec.json");
  const seed = args.includes("--seed") ? Number(args[args.indexOf("--seed") + 1]) : 42;

  // Phase H: the harness mints the per-run token and hands it to the server's
  // environment AND to the grader — the agent (tool calls) never sees it.
  const runToken = mintRunToken();

  const dataDir = fs.mkdtempSync(path.join(path.dirname(outDir), ".agent-"));
  const client = new McpClient(dataDir, runToken);

  try {
    await client.call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "reference-agent", version: "1.0.0" } });
    client.notify("notifications/initialized");

    // Repair: the reference agent writes the corrected spec from the canonical pack.
    const fixedSpec = JSON.parse(fs.readFileSync(specPath, "utf-8"));
    await client.callTool("env_save_spec", { spec_id: "fixed", spec: fixedSpec });
    await client.callTool("env_use_spec", { spec_id: "fixed", seed });

    // Episode A — admit-heavy until terminated.
    let actionsA = 0;
    for (let i = 0; i < 200; i++) {
      const r = await client.callTool("env_step", { type: cycleA[i % cycleA.length] });
      actionsA++;
      if (r.terminated || r.truncated) break;
    }
    // Episode B — until truncated at maxSteps=100.
    await client.callTool("env_reset", { seed });
    let actionsB = 0;
    for (let i = 0; i < 150; i++) {
      const type = cycleB[i % cycleB.length];
      const r = await client.callTool("env_step", type === "move" ? { type, params: { direction: "north" } } : { type });
      actionsB++;
      if (r.truncated || r.terminated) break;
    }

    // Verify claims against the event graph before filing (self-check).
    const { events } = await client.callTool("env_get_events");
    const byId = new Map<string, { causes: string[] }>(events.map((e: { id: string; causes: string[] }) => [e.id, e]));
    const chains: string[][] = [];
    // Claim the two deepest verified chains from the actual graph.
    const depthOf = (id: string, seen = new Set<string>()): number => {
      if (seen.has(id)) return 1;
      seen.add(id);
      const parents = byId.get(id)?.causes ?? [];
      return parents.length === 0 ? 1 : 1 + Math.max(...parents.map((p) => depthOf(p, seen)));
    };
    const sorted = [...byId.keys()].sort((a, b) => depthOf(b) - depthOf(a));
    for (const id of sorted.slice(0, 2)) {
      const chain: string[] = [];
      let cur: string | undefined = id;
      while (cur) { chain.unshift(cur); cur = byId.get(cur)?.causes[0]; }
      if (chain.length >= 2) chains.push(chain);
    }

    const filed = await client.callTool("env_file_dossier", { claimed_chains: chains });
    const scores = filed.scores;

    // Copy the filed dossier into the fixture directory. The run token is
    // stored alongside as a trusted harness artifact so graders (and fixture
    // tests) can verify the chain without re-minting.
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.mkdirSync(outDir, { recursive: true });
    for (const f of ["trajectory.json", "spec-snapshot.json", "events.json", "manifest.json", "trace.json", "scores.json"]) {
      fs.copyFileSync(path.join(dataDir, "dossier", f), path.join(outDir, f));
    }
    fs.writeFileSync(path.join(outDir, "run-token.json"), JSON.stringify({ runToken }, null, 2), "utf-8");
    console.log(`✓ golden dossier generated at ${outDir}`);
    console.log(`  scores: ${scores.total}/100 (${scores.grade})  failures: ${scores.failures.join(",") || "none"}`);
    if (scores.total < 100 || scores.failures.includes("PROVENANCE_FAILURE")) {
      console.error("✗ reference agent did NOT produce a perfect dossier");
      process.exit(1);
    }
  } finally {
    client.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
