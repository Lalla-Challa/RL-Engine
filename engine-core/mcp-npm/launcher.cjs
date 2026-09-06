#!/usr/bin/env node
/**
 * Story Vault MCP — runtime launcher (pure JS, no native dependencies).
 *
 * Why this exists: some MCP clients (e.g. Qwen Studio) spawn `npx` using their
 * bundled Bun runtime instead of Node.js. Bun segfaults on the native
 * SQLCipher addon, so the real server (`server.cjs`) must run under Node.js.
 *
 *   - Under Node.js: load server.cjs in-process (zero overhead).
 *   - Under Bun:    spawn the system `node` binary and run server.cjs as a
 *                   child, forwarding stdio/signals.
 *
 * Node resolution (Windows-safe): $STORY_VAULT_NODE override → `node` on PATH →
 * standard install paths → the Windows-style `Path` env var. Qwen Studio passes
 * a Unix-style `PATH` but a full Windows `Path`, so we check both.
 */
"use strict";

const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

const SERVER_PATH = path.join(__dirname, "server.cjs");

function debugLog(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  const targets = new Set();
  if (process.env.STORY_VAULT_DATA_DIR) {
    targets.add(path.join(process.env.STORY_VAULT_DATA_DIR, "mcp-debug.log"));
  }
  targets.add(path.resolve(process.cwd(), "mcp-debug.log"));
  for (const t of targets) {
    try { fs.appendFileSync(t, line, "utf-8"); } catch { /* ignore */ }
  }
}

function isExecutable(p) {
  try {
    const st = fs.statSync(p);
    return st.isFile();
  } catch {
    return false;
  }
}

function resolveNode() {
  if (process.env.STORY_VAULT_NODE && isExecutable(process.env.STORY_VAULT_NODE)) {
    return process.env.STORY_VAULT_NODE;
  }
  // Common Windows install locations.
  const candidates = [
    "C:\\Program Files\\nodejs\\node.exe",
    path.join(process.env.ProgramFiles || "C:\\Program Files", "nodejs", "node.exe"),
    path.join(process.env["ProgramFiles(x86)"] || "", "nodejs", "node.exe"),
    path.join(process.env.LOCALAPPDATA || "", "Programs", "nodejs", "node.exe"),
  ].filter(Boolean);
  for (const c of candidates) {
    if (isExecutable(c)) return c;
  }
  // Windows-style Path env var (Qwen passes this even when PATH is Unix-style).
  const winPath = process.env.Path || process.env.PATH || "";
  for (const dir of winPath.split(";")) {
    if (!dir) continue;
    const p = path.join(dir, "node.exe");
    if (isExecutable(p)) return p;
  }
  return "node"; // last resort: rely on PATH lookup
}

function runUnderNode() {
  const nodeBin = resolveNode();
  debugLog(`launcher: spawning server via ${nodeBin}`);
  const child = spawn(nodeBin, [SERVER_PATH, ...process.argv.slice(2)], {
    stdio: "inherit",
  });
  const forward = (sig) => {
    try { child.kill(sig); } catch { /* ignore */ }
  };
  process.on("SIGINT", () => forward("SIGINT"));
  process.on("SIGTERM", () => forward("SIGTERM"));
  child.on("exit", (code, signal) => {
    process.exit(code !== null ? code : signal ? 1 : 0);
  });
  child.on("error", (err) => {
    const msg =
      `[story-vault-mcp] failed to spawn Node.js ("${nodeBin}"): ${err.message}\n` +
      "Install Node.js >= 18 and ensure it is on PATH, or set STORY_VAULT_NODE.";
    debugLog(`launcher FAILED: ${msg}`);
    console.error(msg);
    process.exit(1);
  });
}

if (process.versions && process.versions.bun) {
  // Qwen Studio / Bun: delegate to the real Node.js runtime.
  runUnderNode();
} else {
  // Standard Node.js: run the server in-process.
  require(SERVER_PATH);
}
