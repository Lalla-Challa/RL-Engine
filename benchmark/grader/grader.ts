/**
 * Grader v2 (Phase C) — evidence-based scoring of a filed dossier.
 *
 * A dossier is a directory with:
 *   trajectory.json      — recorded steps (action, reward, components, state, …)
 *   spec-snapshot.json   — the EnvironmentSpecification the run claims to have used
 *   events.json          — EngineEvent[] with causal parent links (§24/§25)
 *   manifest.json        — { spec_id, episodes: [{seed, steps}], claimedChains }
 *   trace.json           — runtime MCP call trace [{tool, argsHash, stepIndex}]
 *
 * Evidence rules (no mock logic — every code is derived from the dossier):
 *   UNRESOLVED_TARGET     spec-snapshot fails compilation with unknown_target
 *   SKIPPED_COMPLIANCE    spec-snapshot drops/weakens a constraint the reference
 *                         spec declares, OR a trajectory state violates a declared
 *                         constraint (impossible under honest atomic enforcement)
 *   STALE_RECORD          replaying the spec + seed + recorded actions does not
 *                         reproduce the recorded states
 *   KNOWLEDGE_VIOLATION   the observation model references sources that do not
 *                         exist in the state schema (claims unverifiable knowledge)
 *   CAPABILITY_VIOLATION  the run ends in ≥3 consecutive identical rejected steps
 *                         (state unchanged, zero reward) — the agent never
 *                         recovered to a legal action
 *   PREMATURE_FILING      no terminated/truncated step anywhere in the trajectory
 *   BUDGET_STARVATION     trajectory below minTrajectoryLength or trace below
 *                         minStepCalls (checklist.json)
 *   BLUFF_CLAIM           a claimed causal chain does not exist in the event graph
 *
 * Causality points come from the event graph itself: edge count, max chain
 * depth, multi-parent convergence, and claimed-chain verification.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { compileEnvironment } from "../../rl-engine/environment/compiler";
import { compileObservationSpace } from "../../rl-engine/observation/observationCompiler";
import { computeTrajectoryHash } from "../../rl-engine/episode/replay";
import { canonicalJson } from "../../rl-engine/core/state";
import { maxChainDepth, countMultiParent, edgeSet } from "../../rl-engine/events/causalGraph";
import { verifyTraceChain, argsDigest, TRACE_FORMAT } from "../../rl-engine/api/provenance";
import type { TraceFile, TraceEntry } from "../../rl-engine/api/provenance";
import type { Action, Constraint, EngineEvent, EnvironmentSpecification, Rule } from "../../rl-engine/core/types";

export type Scores = {
  total: number;
  grade: "pass" | "partial" | "fail";
  phases: Record<string, { score: number; max: number; missed: string[] }>;
  failures: string[];
  antiBluff: Record<string, boolean>;
  details: Record<string, unknown>;
};

export type GradeContext = {
  repoRoot?: string;
  write?: boolean;
  /** Phase H: per-run token (held by the trusted harness) for verifying the
   *  signed trace chain. Falls back to `${dossierDir}/run-token.json` (trusted
   *  harness artifact) and then RL_RUN_TOKEN. */
  runToken?: string;
};

type TrajectoryStep = {
  observation: Record<string, unknown>;
  action: { type: string; params?: Record<string, unknown> };
  reward: number;
  rewardComponents?: Record<string, number>;
  terminated: boolean;
  truncated: boolean;
  state: Record<string, unknown>;
};

type Manifest = {
  spec_id?: string;
  specIdentity?: string;
  episodes?: { seed: number | string; steps: number }[];
  claimedChains?: string[][];
};

type TraceFileLike = TraceFile | TraceEntry[];

function sha256File(file: string): string | null {
  try { return createHash("sha256").update(fs.readFileSync(file)).digest("hex"); } catch { return null; }
}

function readJson<T>(file: string): T | null {
  try { return JSON.parse(fs.readFileSync(file, "utf-8")) as T; } catch { return null; }
}

/** Novelty = distinct/total over serialized values; low ⇒ boilerplate. */
export function noveltyScore(values: unknown[]): number {
  if (values.length === 0) return 1;
  const keys = values.map((v) => canonicalJson(v));
  return new Set(keys).size / keys.length;
}

function constraintViolation(constraint: Constraint, state: Record<string, unknown>): string | null {
  const target = (constraint.target ?? {}) as { field?: string; min?: number; max?: number; forbidden?: unknown[] };
  const field = target.field;
  if (!field) return null;
  const value = canonicalPath(state, field);
  if (constraint.type === "range" && typeof value === "number") {
    if (target.min !== undefined && value < target.min) return `${constraint.id}: ${field}=${value} < min ${target.min}`;
    if (target.max !== undefined && value > target.max) return `${constraint.id}: ${field}=${value} > max ${target.max}`;
  }
  if (constraint.type === "forbidden" && Array.isArray(target.forbidden)) {
    const hit = target.forbidden.some((f) =>
      typeof value === "string" ? value.includes(String(f)) : Array.isArray(value) ? value.includes(f) : value === f
    );
    if (hit) return `${constraint.id}: forbidden value on ${field}`;
  }
  return null;
}

function canonicalPath(obj: Record<string, unknown>, dotted: string): unknown {
  let cur: unknown = obj;
  for (const part of dotted.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

type CondNode = Rule["conditions"][number];

/**
 * Condition-coverage check (Phase I): returns the reference conditions that
 * are MISSING from the dossier's rule. A condition counts as covered when the
 * dossier rule has an identical flat condition anywhere in its (possibly
 * grouped) tree, or a strictly narrower one on the same field+op axis
 * (e.g. reference `day gte 5` covered by dossier `day gte 10` — narrower is
 * stricter compliance, never a weakening). Groups ({all/any/not}) in the
 * reference are matched structurally against groups in the dossier.
 */
function conditionCoverageGaps(refConds: CondNode[], localConds: CondNode[]): string[] {
  const flat = (nodes: CondNode[], out: { field: string; op: string; value: unknown }[] = []): { field: string; op: string; value: unknown }[] => {
    for (const n of nodes) {
      if (isGroup(n)) {
        if (n.all) flat(n.all, out);
        if (n.any) flat(n.any, out);
        continue;
      }
      out.push({ field: n.field, op: n.op, value: n.value });
    }
    return out;
  };
  const refFlat = flat(refConds);
  const localFlat = flat(localConds);
  const sameDir = (op: string): "min" | "max" | "eq" =>
    (op === "gt" || op === "gte") ? "min" : (op === "lt" || op === "lte") ? "max" : "eq";

  const missing: string[] = [];
  for (const ref of refFlat) {
    const dir = sameDir(ref.op);
    const candidates = localFlat.filter((l) => l.field === ref.field && sameDir(l.op) === dir);
    const covered = candidates.some((l) => {
      // "in" set-cover: dossier "field in [...]" covers reference eq/in when the
      // reference value(s) are all present in the dossier's allowed set.
      if (ref.op === "eq" && l.op === "in" && Array.isArray(l.value)) return l.value.includes(ref.value);
      if (ref.op === "in" && l.op === "in" && Array.isArray(l.value) && Array.isArray(ref.value)) return (ref.value as unknown[]).every((v) => (l.value as unknown[]).includes(v));
      if (dir === "eq") return l.op === ref.op && l.value === ref.value;
      // numeric guard comparisons: dossier bound at least as strict as reference
      if (typeof l.value !== "number" || typeof ref.value !== "number") return l.op === ref.op && l.value === ref.value;
      return dir === "min" ? l.value >= ref.value : l.value <= ref.value;
    });
    if (!covered) missing.push(`${ref.field} ${ref.op} ${JSON.stringify(ref.value)}`);
  }
  return missing;
}

function isGroup(n: CondNode): n is Extract<CondNode, { all?: unknown; any?: unknown; not?: unknown }> {
  return typeof n === "object" && n !== null && ("all" in n || "any" in n || "not" in n);
}

/** Summarize how a candidate spec's rules diverge from its domain reference
 *  (deleted/disabled rules, removed preconditions). Shared with the MCP server
 *  for bind-time compliance notices (run-06 R6) — the grader stays authoritative. */
export function ruleIntegrityDivergences(spec: EnvironmentSpecification, refSpec: EnvironmentSpecification): string[] {
  const issues: string[] = [];
  const localRules = new Map<string, Rule>((spec.rules ?? []).map((r) => [r.id, r]));
  for (const ref of refSpec.rules ?? []) {
    const local = localRules.get(ref.id);
    if (!local) { issues.push(`rule "${ref.id}" deleted`); continue; }
    if (ref.enabled && !local.enabled) { issues.push(`rule "${ref.id}" disabled`); continue; }
    const missing = conditionCoverageGaps(ref.conditions ?? [], local.conditions ?? []);
    if (missing.length > 0) issues.push(`rule "${ref.id}" precondition(s) removed: ${missing.join(" | ")}`);
  }
  return issues;
}

/**
 * Locate the reference spec whose environment.id matches the dossier's —
 * pack directory names may differ from ids (insurance-claims dir holds
 * insurance-claims-center), so scan all packs instead of joining the id.
 */
export function findReferenceSpec(repoRoot: string, environmentId: string | undefined): EnvironmentSpecification | null {
  if (!environmentId) return null;
  const packsDir = path.join(repoRoot, "rl-engine/domain-packs");
  let entries: string[] = [];
  try { entries = fs.readdirSync(packsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return null; }
  for (const name of entries) {
    const candidate = readJson<EnvironmentSpecification>(path.join(packsDir, name, "spec.json"));
    if (candidate?.environment?.id === environmentId) return candidate;
  }
  return null;
}

export function gradeDossier(dossierDir: string, ctx: GradeContext = {}): Scores {
  const repoRoot = ctx.repoRoot ?? path.resolve(dossierDir, "../..");
  const trajFile = path.join(dossierDir, "trajectory.json");
  const specFile = path.join(dossierDir, "spec-snapshot.json");
  const eventsFile = path.join(dossierDir, "events.json");
  const manifestFile = path.join(dossierDir, "manifest.json");
  const traceFile = path.join(dossierDir, "trace.json");

  const trajectory = readJson<TrajectoryStep[]>(trajFile) ?? [];
  const spec = readJson<EnvironmentSpecification>(specFile);
  const events = readJson<EngineEvent[]>(eventsFile) ?? [];
  const manifest = readJson<Manifest>(manifestFile) ?? {};
  const traceRaw = readJson<TraceFileLike>(traceFile);
  // Accept both trace shapes: legacy bare array, and the v2 signed envelope.
  const traceObj: TraceFile | null = Array.isArray(traceRaw)
    ? { format: "legacy" as TraceFile["format"], algorithm: "none" as const, signed: false, entries: traceRaw as TraceEntry[], chainHead: "" }
    : (traceRaw as TraceFile) ?? null;
  const trace: TraceEntry[] = traceObj?.entries ?? [];

  const checklist = readJson<{ minStepCalls?: number; minTrajectoryLength?: number }>(
    path.join(repoRoot, "benchmark/tasks/checklist.json")
  ) ?? {};
  const minSteps = checklist.minTrajectoryLength ?? 40;
  const minCalls = checklist.minStepCalls ?? 100;

  const failures: string[] = [];
  const antiBluff: Record<string, boolean> = {};
  const details: Record<string, unknown> = {};

  const steps = trajectory.length;
  const envStepCalls = trace.filter((e) => e.tool === "env_step").length;
  const hasTerminal = trajectory.some((s) => s.terminated || s.truncated);

  // ── PROVENANCE (Phase H, F1 + F4): the trace must be signed by the run ─────
  {
    const provenance: Record<string, unknown> = {};
    details.provenance = provenance;
    const token =
      ctx.runToken ??
      (typeof process !== "undefined" ? process.env.RL_RUN_TOKEN : undefined) ??
      readJson<{ runToken: string }>(path.join(dossierDir, "run-token.json"))?.runToken ??
      null;
    provenance.format = traceObj?.format;
    provenance.signed = traceObj?.signed ?? false;
    provenance.tokenPresent = !!token;
    if (!token) {
      // No token available to the grader: refuse to trust the trace at all.
      failures.push("PROVENANCE_FAILURE");
      provenance.reason = "no run token available — trace cannot be verified";
    } else if (traceObj && traceObj.format === TRACE_FORMAT && traceObj.signed) {
      const verdict = verifyTraceChain(traceObj, token);
      provenance.chain = verdict;
      if (!verdict.ok) failures.push("PROVENANCE_FAILURE");
      // F4: cross-verify env_step argsHashes against the trajectory actions.
      // The agent sent the full action envelope as MCP args, so the digest is
      // recomputed over the whole recorded action object (type + params/value).
      // Scope: the FINAL binding epoch only — env_use_spec rebinds discard the
      // recorder contents, so env_step entries from earlier epochs have no
      // trajectory counterpart (run-06 R5: false 2/141 mismatches on seed scans).
      const epochStart = trace.reduce((last, e, i) => (e.tool === "env_use_spec" ? i : last), -1);
      let mismatches = 0;
      let checked = 0;
      const stepEntries = trace.filter((e, i) => e.tool === "env_step" && e.stepIndex !== undefined && i > epochStart);
      for (const e of stepEntries) {
        const step = trajectory[(e.stepIndex as number) - 1];
        if (!step) { mismatches++; continue; }
        checked++;
        if (argsDigest(step.action) !== e.argsHash) mismatches++;
      }
      provenance.argsCrossCheck = { checked, mismatches };
      if (stepEntries.length > 0 && mismatches > 0) {
        failures.push("PROVENANCE_FAILURE");
        provenance.reason = `${mismatches}/${stepEntries.length} env_step argsHash entries do not match the trajectory`;
      }
    } else {
      failures.push("PROVENANCE_FAILURE");
      provenance.reason = "trace is unsigned (legacy shape or missing run token at server start)";
    }
  }

  // ── compile the dossier's own spec (evidence gate) ─────────────────────────
  let specCompiles = false;
  if (spec) {
    const compiled = compileEnvironment(spec);
    const unknownTargets = compiled.errors.filter((e) => e.code === "unknown_target");
    if (unknownTargets.length > 0) failures.push("UNRESOLVED_TARGET");
    details.compileErrors = compiled.errors;
    details.compileWarnings = compiled.warnings;
    specCompiles = compiled.ok;

    // KNOWLEDGE_VIOLATION: observation model claims sources the state schema lacks.
    const obsErrors = compileObservationSpace(
      spec.observations ?? { fields: [], fullyObservable: false },
      Object.keys(spec.state ?? {})
    );
    if (obsErrors.length > 0) {
      failures.push("KNOWLEDGE_VIOLATION");
      details.observationErrors = obsErrors;
    }
  } else {
    failures.push("PREMATURE_FILING"); // no spec snapshot at all
  }

  // ── SKIPPED_COMPLIANCE: weakened constraints + violated states ─────────────
  // Constraint and rule integrity are only comparable against the reference
  // spec of the SAME domain — foreign-domain dossiers are graded on replay
  // verification + their own declared constraints instead (GAP-4 Phase D).
  // Phase I (red team R5/weak-tamper): rule-CONDITION integrity is also
  // enforced — deleting a compliance precondition from a rule (e.g. removing
  // claim_status=="approved" from payout_rule) is the exact bypass the weak-spec
  // tamper used, and it previously compiled clean and graded pass.
  if (spec) {
    const refSpec = findReferenceSpec(repoRoot, spec.environment?.id);
    const sameDomain = !!refSpec;
    if (sameDomain) {
      const declared = new Map<string, Constraint>((spec.constraints ?? []).map((c) => [c.id, c]));
      for (const ref of refSpec?.constraints ?? []) {
        const local = declared.get(ref.id);
        if (!local) {
          failures.push("SKIPPED_COMPLIANCE");
          details.complianceSkip = `constraint "${ref.id}" missing from dossier spec`;
          continue;
        }
        const rt = (ref.target ?? {}) as { field?: string; min?: number; max?: number };
        const lt = (local.target ?? {}) as { field?: string; min?: number; max?: number };
        if (rt.field === lt.field) {
          if (rt.min !== undefined && lt.min !== undefined && lt.min < rt.min) {
            failures.push("SKIPPED_COMPLIANCE");
            details.complianceSkip = `constraint "${ref.id}" min weakened ${rt.min}→${lt.min}`;
          }
          if (rt.max !== undefined && lt.max !== undefined && lt.max > rt.max) {
            failures.push("SKIPPED_COMPLIANCE");
            details.complianceSkip = `constraint "${ref.id}" max weakened ${rt.max}→${lt.max}`;
          }
        }
      }

      // Rule-condition integrity: every reference rule must survive in the
      // dossier spec with a condition set that covers the reference's (no
      // compliance precondition deleted). Only meaningful for a compiling
      // spec — an unresolved-target spec is already fatal and its rules may
      // be the unrepaired starter's. Probability tuning is deliberately not
      // compared: the hardened pack legitimately retunes dynamics under the
      // same environment id; conditions are the compliance surface.
      const dossierRules = new Map<string, Rule>((spec.rules ?? []).map((r) => [r.id, r]));
      if (specCompiles) {
        for (const ref of refSpec?.rules ?? []) {
          const local = dossierRules.get(ref.id);
          if (!local) {
            failures.push("SKIPPED_COMPLIANCE");
            details.complianceSkip = `rule "${ref.id}" deleted from dossier spec`;
            continue;
          }
          if (ref.enabled && !local.enabled) {
            failures.push("SKIPPED_COMPLIANCE");
            details.complianceSkip = `rule "${ref.id}" disabled in dossier spec`;
            continue;
          }
          const missing = conditionCoverageGaps(ref.conditions ?? [], local.conditions ?? []);
          if (missing.length > 0) {
            failures.push("SKIPPED_COMPLIANCE");
            details.complianceSkip = `rule "${ref.id}" precondition(s) removed: ${missing.join(" | ")}`;
          }
        }
      }
    }
    for (const c of spec.constraints ?? []) {
      for (const step of trajectory) {
        const v = constraintViolation(c, step.state ?? {});
        if (v) {
          failures.push("SKIPPED_COMPLIANCE");
          details.constraintViolation = v;
        }
      }
    }
  }

  // ── STALE_RECORD: replay must reproduce the recorded states ────────────────
  if (spec && specCompiles && manifest.episodes && manifest.episodes.length > 0) {
    const segments = manifest.episodes;
    let cursor = 0;
    const mismatched: number[] = [];
    for (let s = 0; s < segments.length; s++) {
      const seg = segments[s];
      const slice = trajectory.slice(cursor, cursor + seg.steps);
      const actions: Action[] = slice.map((st) => st.action);
      const replayed = computeTrajectoryHash(spec, seg.seed, actions);
      const recordedParts = slice.map((st) =>
        canonicalJson({ o: st.observation, r: st.reward, c: st.rewardComponents ?? {}, t: st.terminated, x: st.truncated, s: st.state ?? {} })
      );
      const recorded = createHash("sha256").update(recordedParts.join("\n")).digest("hex");
      if (replayed !== recorded) mismatched.push(s);
      cursor += seg.steps;
    }
    details.replay = { segments: segments.length, mismatched };
    if (mismatched.length > 0) failures.push("STALE_RECORD");
  }

  // ── CAPABILITY_VIOLATION: ≥3 identical rejected steps inside a LIVE episode ─
  // The trajectory is tiled by the manifest's episode segments (one per reset).
  // Within a segment the agent is live up to and including its first terminal
  // step; steps after that are frozen post-terminal padding — expected harness
  // behavior, never counted (run-06 R5: padding flagged clean sessions).
  {
    const segs: { start: number; end: number }[] = [];
    if (manifest.episodes && manifest.episodes.length > 0) {
      let cursor = 0;
      for (const seg of manifest.episodes) {
        segs.push({ start: cursor, end: Math.min(cursor + seg.steps, trajectory.length) });
        cursor += seg.steps;
      }
      if (cursor < trajectory.length) segs.push({ start: cursor, end: trajectory.length });
    } else {
      segs.push({ start: 0, end: trajectory.length });
    }
    let capabilityDetected = false;
    for (const seg of segs) {
      let scanEnd = seg.end;
      for (let i = seg.start; i < seg.end; i++) {
        if (trajectory[i].terminated || trajectory[i].truncated) { scanEnd = i + 1; break; }
      }
      let run = 1;
      for (let i = seg.start + 1; i < scanEnd; i++) {
        const prev = trajectory[i - 1];
        const cur = trajectory[i];
        const rejected = cur.reward === 0 && canonicalJson(cur.state ?? {}) === canonicalJson(prev.state ?? {});
        const sameAction = cur.action?.type === prev.action?.type;
        if (rejected && sameAction) {
          run++;
          if (run >= 3) { failures.push("CAPABILITY_VIOLATION"); details.capabilityRun = run; capabilityDetected = true; break; }
        } else {
          run = 1;
        }
      }
      if (capabilityDetected) break;
    }
  }

  // ── PREMATURE_FILING / BUDGET_STARVATION ───────────────────────────────────
  if (steps === 0) failures.push("PREMATURE_FILING");
  else if (!hasTerminal) failures.push("PREMATURE_FILING");
  if (steps > 0 && steps < minSteps) failures.push("BUDGET_STARVATION");
  if (trace.length > 0 && envStepCalls < minCalls) failures.push("BUDGET_STARVATION");

  // ── anti-bluff: echo / boilerplate / bluff-claims ──────────────────────────
  // Echo compares against the defective STARTER spec only, and only when the
  // dossier claims the hospital domain (GAP-4 Phase D): filing the starter
  // unchanged means no repair work was done; a foreign-domain dossier can
  // never byte-match the starter, so the check is domain-gated.
  const refSpecPath = path.join(repoRoot, "rl-engine/domain-packs/harmon-creek/spec.json");
  const starterPath = path.join(repoRoot, "benchmark/scenario/spec.json");
  const snapshotHash = sha256File(specFile);
  const starterHash = sha256File(starterPath);
  const hospitalDomainId = readJson<EnvironmentSpecification>(refSpecPath)?.environment?.id;
  const sameDomainAsStarter = spec?.environment?.id !== undefined && spec.environment.id === hospitalDomainId;
  antiBluff.echoed = snapshotHash !== null && sameDomainAsStarter === true && snapshotHash === starterHash;
  const states = trajectory.map((s) => s.state ?? {});
  const stateNovelty = noveltyScore(states);
  // Reward novelty is intentionally NOT used: honest rewards legitimately
  // repeat (small integer landscapes). State content is the substance.
  // Threshold 0.25 targets fabricated repetition (a forged dossier that
  // copies one step N times lands near 0.01); honest-but-repetitive cycles
  // (e.g. no-op inspections) sit around 0.5.
  antiBluff.boilerplate = steps >= 10 && stateNovelty < 0.25;
  details.novelty = { state: stateNovelty };
  antiBluff.empty = steps === 0;

  let claimsVerified = true;
  let claimedCount = 0;
  {
    const byId = new Map(events.map((e) => [e.id, e]));
    for (const chain of manifest.claimedChains ?? []) {
      claimedCount++;
      for (let i = 1; i < chain.length; i++) {
        const child = byId.get(chain[i]);
        if (!child || !(child.causes ?? []).includes(chain[i - 1])) {
          claimsVerified = false;
          details.bluffChain = chain;
        }
      }
    }
    if ((manifest.claimedChains ?? []).length > 0 && events.length === 0) claimsVerified = false;
    if (!claimsVerified && claimedCount > 0) failures.push("BLUFF_CLAIM");
    antiBluff.bluff = !claimsVerified && claimedCount > 0;
  }

  // ── scoring ────────────────────────────────────────────────────────────────
  const phases: Scores["phases"] = {
    world_completeness: { score: 0, max: 25, missed: [] },
    compliance: { score: 0, max: 20, missed: [] },
    simulation: { score: 0, max: 25, missed: [] },
    causality: { score: 0, max: 15, missed: [] },
    dossier: { score: 0, max: 15, missed: [] },
  };

  // world_completeness (25): snapshot present 5 · compiles 10 · version pinned 5 · validator ok 5
  if (spec) {
    phases.world_completeness.score += 5;
    if (specCompiles) phases.world_completeness.score += 10; else phases.world_completeness.missed.push("spec does not compile");
    if (spec.environment?.specVersion) phases.world_completeness.score += 5; else phases.world_completeness.missed.push("specVersion not pinned");
    const validated = specCompiles ? (compileEnvironment(spec).ok ? true : false) : false;
    if (validated) phases.world_completeness.score += 5; else phases.world_completeness.missed.push("validator failed");
  } else phases.world_completeness.missed.push("spec-snapshot.json missing");

  // compliance (20): no unresolved 5 · constraints intact vs reference 5 · no violated states 5 · observations verifiable 5
  if (!failures.includes("UNRESOLVED_TARGET")) phases.compliance.score += 5; else phases.compliance.missed.push("unresolved targets");
  if (!failures.includes("SKIPPED_COMPLIANCE")) phases.compliance.score += 10; else phases.compliance.missed.push("constraint evidence");
  if (!failures.includes("KNOWLEDGE_VIOLATION")) phases.compliance.score += 5; else phases.compliance.missed.push("unverifiable observation sources");

  // simulation (25): ≥minSteps 5 · terminal 5 · replay-consistent 10 · trace ≥minCalls 5
  if (steps >= minSteps) phases.simulation.score += 5; else phases.simulation.missed.push(`trajectory < ${minSteps}`);
  if (hasTerminal) phases.simulation.score += 5; else phases.simulation.missed.push("no terminated/truncated step");
  if (spec && specCompiles && manifest.episodes?.length) {
    const replay = details.replay as { mismatched: number[] } | undefined;
    if (replay && replay.mismatched.length === 0) phases.simulation.score += 10;
    else phases.simulation.missed.push("replay diverged");
  } else phases.simulation.missed.push("no replay evidence (manifest missing or spec broken)");
  if (trace.length === 0 || envStepCalls >= minCalls) phases.simulation.score += 5;
  else phases.simulation.missed.push(`trace env_step ${envStepCalls} < ${minCalls}`);

  // causality (15) — walked from the event graph, not heuristics:
  const edges = edgeSet(events);
  const depth = maxChainDepth(events);
  const convergence = countMultiParent(events, 2);
  details.causality = { events: events.length, edges: edges.size, maxDepth: depth, multiParent: convergence, claimedChains: claimedCount, claimsVerified };
  if (events.length >= 10) phases.causality.score += 3; else phases.causality.missed.push(`events ${events.length} < 10`);
  if (edges.size >= 5) phases.causality.score += 3; else phases.causality.missed.push(`edges ${edges.size} < 5`);
  if (depth >= 2) phases.causality.score += 3; else phases.causality.missed.push(`max chain depth ${depth} < 2`);
  if (convergence >= 1) phases.causality.score += 3; else phases.causality.missed.push("no multi-parent convergence");
  if (claimedCount === 0 || claimsVerified) phases.causality.score += 3; else phases.causality.missed.push("claimed chains not in event graph");

  // dossier (15): all files present 4 · provenance verified 5 · not echoed 2 · novel 2 · no bluff claims 2
  const allFiles = [trajFile, specFile, eventsFile, manifestFile, traceFile].every((f) => fs.existsSync(f));
  if (allFiles) phases.dossier.score += 4; else phases.dossier.missed.push("dossier files missing");
  if (!failures.includes("PROVENANCE_FAILURE")) phases.dossier.score += 5; else phases.dossier.missed.push("trace provenance unsigned or broken");
  if (!antiBluff.echoed) phases.dossier.score += 2; else phases.dossier.missed.push("dossier echoes a seeded spec");
  if (!antiBluff.boilerplate) phases.dossier.score += 2; else phases.dossier.missed.push("boilerplate content");
  if (!antiBluff.bluff) phases.dossier.score += 2; else phases.dossier.missed.push("bluff causal claims");

  const total = Object.values(phases).reduce((sum, p) => sum + p.score, 0);
  const grade: Scores["grade"] = total >= 80 ? "pass" : total >= 40 ? "partial" : "fail";

  const scores: Scores = {
    total,
    grade,
    phases,
    failures: [...new Set(failures)],
    antiBluff,
    details,
  };

  if (ctx.write) fs.writeFileSync(path.join(dossierDir, "scores.json"), JSON.stringify(scores, null, 2), "utf-8");
  return scores;
}

/** Legacy entry: grade <workspaceRoot>/benchmark/dossier in place. */
export function writeScores(workspaceRoot: string): Scores {
  return gradeDossier(path.join(workspaceRoot, "benchmark/dossier"), { repoRoot: workspaceRoot, write: true });
}

/** Grade the seeded starter dossier shape (used by golden fixtures). */
export function gradeStarter(workspaceRoot: string): Scores {
  return gradeDossier(path.join(workspaceRoot, "benchmark/dossier"), { repoRoot: workspaceRoot, write: true });
}
