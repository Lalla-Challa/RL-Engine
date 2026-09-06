#!/usr/bin/env node
/**
 * Standalone entry point for the Story Vault MCP server.
 * Bundled as `dist/mcp.js` (and `mcp/npm/dist/index.cjs`).
 */
import { runStandalone } from "./mcp";

runStandalone().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});