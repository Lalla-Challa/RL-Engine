/**
 * Trace provenance (Phase H, §40 hardening — audit findings F1 + F4).
 *
 * Threat model: the agent is the untrusted party; the harness (which spawns
 * the MCP server and later runs the grader) is trusted. The harness mints a
 * fresh per-run token that the agent never receives — it is passed via the
 * server's process environment and handed to the grader alongside the dossier.
 *
 * The server derives an HMAC-SHA256 key from the token and signs every trace
 * entry chain-style: digest_i = HMAC(key, entry_i ++ digest_{i-1}). Deleting,
 * reordering, replaying, or editing any entry (or appending forged ones)
 * breaks every subsequent digest and the recorded chainHead.
 *
 * Boundary note: the token protects against agents operating through the MCP
 * protocol. An agent with arbitrary host-level code execution (reading other
 * processes' environments) is host compromise and out of scope.
 */

import { createHash, createHmac, randomBytes } from "node:crypto";

import { canonicalJson } from "../core/state";

export const TRACE_FORMAT = "rl-trace-v2";
const GENESIS = "rl-trace-v2:genesis";
const KEY_CONTEXT = "rl-engine-trace-v1";

/** Harness-side: mint a fresh per-run token (never revealed to the agent). */
export function mintRunToken(): string {
  return randomBytes(32).toString("hex");
}

/** Server/grader-side: derive the signing key from the run token. */
export function deriveTraceKey(runToken: string): string {
  return createHmac("sha256", runToken).update(KEY_CONTEXT).digest("hex");
}

/** Canonical digest of a tool-call argument envelope (F4 cross-check anchor). */
export function argsDigest(args: unknown): string {
  return createHash("sha256").update(canonicalJson(args ?? {})).digest("hex").slice(0, 16);
}

export type TraceEntry = {
  index: number;
  tool: string;
  argsHash: string;
  stepIndex?: number;
  /** HMAC chain digest — present only when the run token was provided. */
  digest?: string;
};

export type TraceFile = {
  format: typeof TRACE_FORMAT;
  algorithm: "HMAC-SHA256" | "none";
  signed: boolean;
  entries: TraceEntry[];
  chainHead: string;
};

/** Compute the chain digest for one entry (shared by writer and verifier). */
export function entryDigest(key: string, entry: { index: number; tool: string; argsHash: string; stepIndex?: number }, prevDigest: string): string {
  return createHmac("sha256", key)
    .update(canonicalJson({ index: entry.index, tool: entry.tool, argsHash: entry.argsHash, stepIndex: entry.stepIndex, prevDigest }))
    .digest("hex");
}

/** Sign a set of entries into the v2 trace file shape. */
export function signTrace(entries: TraceEntry[], runToken: string): TraceFile {
  const key = deriveTraceKey(runToken);
  let prev = GENESIS;
  const signed = entries.map((e) => {
    const digest = entryDigest(key, e, prev);
    prev = digest;
    return { ...e, digest };
  });
  return { format: TRACE_FORMAT, algorithm: "HMAC-SHA256", signed: true, entries: signed, chainHead: prev };
}

/** Verify a trace file's HMAC chain against the run token. */
export function verifyTraceChain(file: TraceFile, runToken: string): { ok: boolean; reason?: string } {
  if (file.format !== TRACE_FORMAT) return { ok: false, reason: `unknown trace format "${(file as { format?: string }).format}"` };
  if (!file.signed || file.algorithm !== "HMAC-SHA256") return { ok: false, reason: "trace is unsigned" };
  const key = deriveTraceKey(runToken);
  let prev = GENESIS;
  for (const e of file.entries) {
    const expected = entryDigest(key, e, prev);
    if (e.digest !== expected) return { ok: false, reason: `entry ${e.index}: digest mismatch (edited, forged, or out of order)` };
    prev = e.digest;
  }
  if (file.chainHead !== prev) return { ok: false, reason: "chainHead mismatch (entries appended or truncated)" };
  return { ok: true };
}
