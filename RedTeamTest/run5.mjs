#!/usr/bin/env node
// run5.mjs — clean-session dossier experiment.
// Hypothesis: STALE_RECORD + "replay diverged" are caused by episodes abandoned
// mid-way (env_reset while running). Clean sessions (only terminating episodes)
// should produce replay-valid dossiers.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const ROOT = "D:/CMM-CME";
const DATA_DIR = "D:/CMM-CME/data-redteam";
const OUT_DIR = "D:/CMM-CME/RedTeamTest/run2";
const RUN_ID = process.argv[2] || "run-06";

class MCPClient {
  constructor(tag = "c") { this.tag = tag; this.id = 1; this.pending = new Map(); this.lineBuffer = ""; this.proc = null; }
  async start() {
    this.proc = spawn("node", ["--import", "tsx", "rl-engine/api/mcpServer.ts"], {
      cwd: ROOT,
      env: { ...process.env, RL_ENGINE_DATA_DIR: DATA_DIR, RL_ENGINE_TRACE_FILE: DATA_DIR + "/trace.json", RL_RUN_TOKEN: "redteam-" + RUN_ID },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc.stderr.on("data", () => {});
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
        } catch {}
      }
    });
    await new Promise(r => setTimeout(r, 1200));
    await this.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "redteam-" + RUN_ID + "-" + this.tag, version: "5.0" } });
    this.notify("notifications/initialized", {});
    await new Promise(r => setTimeout(r, 250));
  }
  request(method, params) {
    const id = this.id++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error("timeout " + method)); } }, 25000);
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

const strip = s => { const o = {}; for (const [k, v] of Object.entries(s || {})) if (!k.startsWith("entity:") && !k.startsWith("rel:")) o[k] = v; return o; };
const diffSig = (p, c) => Object.keys(c || {}).filter(k => k !== "day").filter(k => JSON.stringify(p?.[k]) !== JSON.stringify(c?.[k])).map(k => `${k}:${JSON.stringify(p?.[k])}->${JSON.stringify(c?.[k])}`).join("; ") || "(none)";
const AUDIT = { "insurance-claims": "audit_reserve", "legal-filing": "audit_case", "hr-onboarding": "audit_hr", "hospital-billing": "audit_billing" };

async function padAndFinish(client, pack) {
  await client.callTool("env_reset", { seed: 9001 });
  let issued = 0, guard = 0;
  while (guard < 300) {
    guard++;
    const res = await client.callTool("env_step", { type: AUDIT[pack] });
    issued++;
    if (res.terminated || res.truncated) { if (issued >= 100) break; await client.callTool("env_reset", { seed: 9001 + issued }); }
  }
  return issued;
}

async function dossier(client, key) {
  const d = await client.callTool("env_file_dossier", { claimed_chains: [] });
  const s = d.scores || {};
  console.log(`DOSSIER ${key}: total=${s.total} grade=${s.grade} failures=${JSON.stringify(s.failures)} replay=${JSON.stringify(s.details?.replay)} complianceMissed=${JSON.stringify(s.phases?.compliance?.missed)} simMissed=${JSON.stringify(s.phases?.simulation?.missed)}`);
  const dest = path.join(ROOT, `redteam_dossier_${RUN_ID}_clean_${key}`);
  fs.mkdirSync(dest, { recursive: true });
  for (const fn of fs.readdirSync(path.join(DATA_DIR, "dossier"))) fs.copyFileSync(path.join(DATA_DIR, "dossier", fn), path.join(dest, fn));
  return {
    key, total: s.total, grade: s.grade, failures: s.failures, replay: s.details?.replay,
    chain_head: d.manifest?.provenance?.chainHead || null,
    trajectory_sha256: crypto.createHash("sha256").update(fs.readFileSync(path.join(dest, "trajectory.json"))).digest("hex"),
  };
}

const out = { run: RUN_ID, sessions: {} };

// Session H: hospital-billing, ONLY the HB-9 bypass trajectory (terminates) + padding.
{
  const HB_SEED = RUN_ID === "run-05" ? 303 : 313; const c = new MCPClient("hb9");
  await c.start();
  try {
    await c.callTool("env_use_spec", { spec_id: "hospital-billing", seed: HB_SEED });
    const states = [];
    await c.callTool("env_reset", { seed: HB_SEED });
    let prev = strip(await c.callTool("env_get_state", {}));
    const seq = ["admit_patient", "prescribe_meds", "dispense_meds", "generate_invoice", "collect_payment", "generate_invoice", "collect_payment", "generate_invoice", "collect_payment"];
    for (const act of seq) {
      const res = await c.callTool("env_step", { type: act });
      const cur = strip(await c.callTool("env_get_state", {}));
      states.push({ action: act, mutations: diffSig(prev, cur), reward: res.reward, terminated: res.terminated });
      prev = cur;
    }
    out.sessions.hb9 = { states, final: prev, padded: await padAndFinish(c, "hospital-billing") };
    out.dossier_hb9 = await dossier(c, "hospital-billing-hb9");
  } finally { await c.stop(); }
}

// Session I: insurance-claims, ONLY the legal control IC-9 (terminates) + padding.
{
  const c = new MCPClient("ic9");
  await c.start();
  try {
    await c.callTool("env_use_spec", { spec_id: "insurance-claims", seed: 77 });
    await c.callTool("env_reset", { seed: 77 });
    const seq = ["file_claim", "review_claim", "approve_claim", "approve_claim", "issue_payout"];
    for (const act of seq) await c.callTool("env_step", { type: act });
    out.session_ic9_final = strip(await c.callTool("env_get_state", {}));
    out.sessions.ic9 = { padded: await padAndFinish(c, "insurance-claims") };
    out.dossier_ic9 = await dossier(c, "insurance-claims-ic9");
  } finally { await c.stop(); }
}

// Session L: legal-filing, ONLY LF-5 control (blocked by $field defect) + padding.
{
  const c = new MCPClient("lf5");
  await c.start();
  try {
    await c.callTool("env_use_spec", { spec_id: "legal-filing", seed: 111 });
    await c.callTool("env_reset", { seed: 111 });
    const seq = ["open_discovery", "gather_evidence", "gather_evidence", "close_discovery", "file_motion"];
    for (const act of seq) await c.callTool("env_step", { type: act });
    out.session_lf5_final = strip(await c.callTool("env_get_state", {}));
    out.sessions.lf5 = { padded: await padAndFinish(c, "legal-filing") };
    out.dossier_lf5 = await dossier(c, "legal-filing-lf5");
  } finally { await c.stop(); }
}

fs.writeFileSync(path.join(OUT_DIR, `report_${RUN_ID}_clean_sessions.json`), JSON.stringify(out, null, 2));
console.log("\nDONE");
