/**
 * TraceWriter — runtime call trace (Phase B + Phase H provenance).
 * Every MCP tools/call is appended with an index, the tool name, and a
 * canonical hash of its arguments. env_step entries additionally carry the
 * step index. Written continuously so a crashed run still leaves evidence.
 *
 * Phase H: when the harness provides a run token (RL_RUN_TOKEN), each entry
 * is signed chain-style (HMAC-SHA256, see api/provenance.ts) and the trace
 * file carries the full chain — the grader rejects unsigned or chain-broken
 * traces (PROVENANCE_FAILURE). The trace is per-server-run (fresh on start):
 * run evidence, not a persistent ledger.
 */

import fs from "node:fs";
import path from "node:path";

import { argsDigest, deriveTraceKey, entryDigest, TRACE_FORMAT } from "./provenance";
import type { TraceEntry, TraceFile } from "./provenance";

const GENESIS = "rl-trace-v2:genesis";

export class TraceWriter {
  private entries: TraceEntry[] = [];
  private prevDigest = GENESIS;
  private readonly key: string | null;
  private readonly hasToken: boolean;

  constructor(private readonly file: string, runToken?: string) {
    this.hasToken = typeof runToken === "string" && runToken.length > 0;
    this.key = this.hasToken ? deriveTraceKey(runToken!) : null;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.flush();
  }

  record(tool: string, args: unknown, stepIndex?: number): void {
    const entry: TraceEntry = { index: this.entries.length + 1, tool, argsHash: argsDigest(args) };
    if (stepIndex !== undefined) entry.stepIndex = stepIndex;
    if (this.key) {
      entry.digest = entryDigest(this.key, entry, this.prevDigest);
      this.prevDigest = entry.digest;
    }
    this.entries.push(entry);
    this.flush();
  }

  count(): number {
    return this.entries.length;
  }

  countOf(tool: string): number {
    return this.entries.filter((e) => e.tool === tool).length;
  }

  getEntries(): TraceEntry[] {
    return [...this.entries];
  }

  /** v2 trace file shape (signed when a run token was provided). */
  export(): TraceFile {
    if (this.key) {
      return {
        format: TRACE_FORMAT,
        algorithm: "HMAC-SHA256",
        signed: true,
        entries: this.entries.map((e) => ({ ...e })),
        chainHead: this.prevDigest,
      };
    }
    return { format: TRACE_FORMAT, algorithm: "none", signed: false, entries: this.getEntries(), chainHead: "" };
  }

  private flush(): void {
    fs.writeFileSync(this.file, JSON.stringify(this.export(), null, 2), "utf-8");
  }
}
