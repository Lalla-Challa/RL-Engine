#!/usr/bin/env node
// Recon: list MCP tools, specs, and dump full specification for a pack via MCP only.
import { spawn } from "node:child_process";
import fs from "node:fs";

const ROOT = "D:/CMM-CME";
const DATA_DIR = "D:/CMM-CME/data-redteam";
const OUT_DIR = "D:/CMM-CME/RedTeamTest/run2";

class MCPClient {
  constructor() {
    this.id = 1; this.pending = new Map(); this.lineBuffer = ""; this.proc = null;
  }
  async start() {
    this.proc = spawn("node", ["--import", "tsx", "rl-engine/api/mcpServer.ts"], {
      cwd: ROOT,
      env: { ...process.env, RL_ENGINE_DATA_DIR: DATA_DIR, RL_ENGINE_TRACE_FILE: DATA_DIR + "/trace.json", RL_RUN_TOKEN: "redteam-run-02" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc.stderr.on("data", d => process.stderr.write("[srv] " + d.toString()));
    this.proc.stdout.on("data", data => {
      this.lineBuffer += data.toString();
      let idx;
      while ((idx = this.lineBuffer.indexOf("\n")) >= 0) {
        const line = this.lineBuffer.slice(0, idx).trim();
        this.lineBuffer = this.lineBuffer.slice(idx + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id !== undefined && msg.id !== null && this.pending.has(msg.id)) {
            const { resolve, reject } = this.pending.get(msg.id);
            this.pending.delete(msg.id);
            if (msg.error) reject(new Error(JSON.stringify(msg.error)));
            else resolve(msg.result);
          }
        } catch (e) { /* ignore */ }
      }
    });
    await new Promise(r => setTimeout(r, 1000));
    await this.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "recon", version: "1.0" } });
    this.notify("notifications/initialized", {});
    await new Promise(r => setTimeout(r, 200));
  }
  request(method, params) {
    const id = this.id++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error("timeout " + method)); } }, 15000);
    });
  }
  notify(method, params) { this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n"); }
  async callTool(name, args = {}) {
    const res = await this.request("tools/call", { name, arguments: args });
    if (res?.content?.[0]?.text) {
      try { return JSON.parse(res.content[0].text); } catch { return res.content[0].text; }
    }
    return res;
  }
  async stop() { if (this.proc) { this.proc.kill(); await new Promise(r => setTimeout(r, 400)); } }
}

const pack = process.argv[2] || "insurance-claims";
fs.mkdirSync(OUT_DIR, { recursive: true });
const client = new MCPClient();
await client.start();
const out = {};
try {
  out.tools = await client.request("tools/list", {});
  out.toolNames = out.tools.tools.map(t => t.name);
  console.log("TOOLS:", JSON.stringify(out.toolNames));
  // dump tool schemas briefly
  fs.writeFileSync(`${OUT_DIR}/tools.json`, JSON.stringify(out.tools, null, 2));

  out.listSpecs = await client.callTool("env_list_specs", {});
  console.log("SPECS:", JSON.stringify(out.listSpecs).slice(0, 1200));

  const use = await client.callTool("env_use_spec", { spec_id: pack, seed: 42 });
  out.use = use;
  console.log("USE:", JSON.stringify(use).slice(0, 800));

  out.spec = await client.callTool("env_get_specification", {});
  fs.writeFileSync(`${OUT_DIR}/spec_${pack}.json`, JSON.stringify(out.spec, null, 2));
  console.log(`Spec written to ${OUT_DIR}/spec_${pack}.json (len=${JSON.stringify(out.spec).length})`);

  out.state0 = await client.callTool("env_get_state", {});
  console.log("STATE0:", JSON.stringify(out.state0).slice(0, 800));

  // probe one illegal step to see what a rejection looks like
  const probeAction = pack === "insurance-claims" ? "issue_payout"
    : pack === "legal-filing" ? "file_motion"
    : pack === "hr-onboarding" ? "issue_credentials" : "collect_payment";
  out.probeStep = await client.callTool("env_step", { type: probeAction });
  console.log("PROBE STEP (illegal, fresh state):", JSON.stringify(out.probeStep));
  out.stateAfterProbe = await client.callTool("env_get_state", {});
  console.log("STATE AFTER PROBE:", JSON.stringify(out.stateAfterProbe).slice(0, 800));
  out.eventsAfterProbe = await client.callTool("env_get_events", {});
  console.log("EVENTS:", JSON.stringify(out.eventsAfterProbe).slice(0, 1200));
} finally {
  await client.stop();
  fs.writeFileSync(`${OUT_DIR}/recon_${pack}.json`, JSON.stringify(out, (k,v) => v === undefined ? null : v, 2));
}
