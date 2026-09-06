/**
 * Build the golden + 7 broken fixtures (Phase C).
 *
 * The golden dossier is produced by the headless reference agent over the real
 * MCP protocol. Each broken fixture is a surgical corruption of the golden one
 * that isolates EXACTLY ONE named failure mode:
 *
 *   broken-skipped-compliance    constraint dropped from the dossier spec
 *   broken-stale-record          one trajectory state tampered (replay diverges)
 *   broken-unresolved-target     dossier spec still contains the 4 starter defects
 *   broken-knowledge-violation   observation claims a source the state schema lacks
 *   broken-capability-violation  run ends in repeated identical rejected steps
 *   broken-premature-filing      trajectory cut before any terminal step
 *   broken-budget-starvation     trajectory too short (episode A only)
 *   broken-bluff-claim           manifest claims a causal chain that does not exist
 *
 * Run: node --import tsx benchmark/scripts/build-fixtures.ts
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { argsDigest, signTrace } from "../../rl-engine/api/provenance";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const FIXTURES = path.join(ROOT, "benchmark/fixtures");
const GOLDEN = path.join(FIXTURES, "golden");
const FILES = ["trajectory.json", "spec-snapshot.json", "events.json", "manifest.json", "trace.json", "run-token.json"] as const;

function runReferenceAgent(): void {
  const res = spawnSync(process.execPath, ["--import", "tsx", path.join(ROOT, "benchmark/scripts/reference-agent.ts"), GOLDEN], {
    cwd: path.dirname(process.argv[1] ?? ROOT),
    stdio: "inherit",
    env: process.env,
  });
  if (res.status !== 0) {
    console.error("✗ reference agent failed — cannot build fixtures");
    process.exit(1);
  }
}

type Traj = { action: { type: string }; state: Record<string, unknown>; reward: number; observation?: unknown }[];
type Manifest = { episodes: { seed: number | string; steps: number }[]; claimedChains?: string[][] };

function readGolden(name: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(GOLDEN, name), "utf-8"));
}

function writeFixture(name: string, files: Partial<Record<(typeof FILES)[number], unknown>>): void {
  const dir = path.join(FIXTURES, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  // Phase H: when the fixture modifies the trajectory (premature/starvation
  // window cuts), the trusted harness re-issues a correctly-signed trace for
  // the edited trajectory. Edits that do NOT match the trace still fail the
  // F4 argsHash cross-check — which is the actual tamper signal.
  const tokenEntry = readGolden("run-token.json") as { runToken: string };
  if (files["trajectory.json"] !== undefined) {
    const traj = files["trajectory.json"] as Array<{ action: { type: string; params?: Record<string, unknown> } }>;
    const entries = traj.map((step, i) => ({
      index: i + 1,
      tool: "env_step",
      argsHash: argsDigest(step.action),
      stepIndex: i + 1,
    }));
    files["trace.json"] = signTrace(entries, tokenEntry.runToken);
  }
  for (const f of FILES) {
    const value = files[f] ?? readGolden(f);
    fs.writeFileSync(path.join(dir, f), JSON.stringify(value, null, 2), "utf-8");
  }
}

function main(): void {
  console.log("── generating golden dossier via reference agent (real MCP run) ──");
  runReferenceAgent();

  const goldenTraj = readGolden("trajectory.json") as Traj;
  const goldenSpec = readGolden("spec-snapshot.json") as { environment: { version: string }; observations: unknown };
  const goldenManifest = readGolden("manifest.json") as Manifest;
  const episodeASteps = goldenManifest.episodes[0].steps;
  const totalSteps = goldenTraj.length;

  // ── SKIPPED_COMPLIANCE: drop the ward_capacity constraint from the dossier spec ──
  {
    const spec = JSON.parse(JSON.stringify(goldenSpec));
    (spec as { constraints: { id: string }[] }).constraints = (spec as { constraints: { id: string }[] }).constraints.filter(
      (c) => c.id !== "ward_capacity"
    );
    writeFixture("broken-skipped-compliance", { "spec-snapshot.json": spec });
  }

  // ── STALE_RECORD: tamper one mid-run state within bounds (replay diverges) ──
  {
    const traj = JSON.parse(JSON.stringify(goldenTraj)) as { state: Record<string, unknown> }[];
    const idx = Math.floor(totalSteps / 2);
    traj[idx].state = { ...traj[idx].state, battery: Number(traj[idx].state.battery ?? 0) + 1.5 };
    writeFixture("broken-stale-record", { "trajectory.json": traj });
  }

  // ── UNRESOLVED_TARGET: ship the defective starter spec as the snapshot ──
  {
    const starter = JSON.parse(fs.readFileSync(path.join(ROOT, "benchmark/scenario/spec.json"), "utf-8"));
    starter.environment.version = "1.0.0-broken"; // distinct bytes so echo does not fire
    writeFixture("broken-unresolved-target", { "spec-snapshot.json": starter });
  }

  // ── KNOWLEDGE_VIOLATION: observation claims a source the schema lacks ──
  {
    const spec = JSON.parse(JSON.stringify(goldenSpec)) as { observations: { fields: { field: string; source: string; visibility?: string }[] } };
    spec.observations.fields.push({ field: "ghost_readings", source: "spirit_level", visibility: "public" });
    writeFixture("broken-knowledge-violation", { "spec-snapshot.json": spec });
  }

  // ── CAPABILITY_VIOLATION: stuck run inside a LIVE episode ─────────────────
  // Three identical rejected steps mid-episode B (before its truncation):
  // "seance_summon" is illegal (action_validation → frozen state, reward 0),
  // and the episode keeps running afterwards. Post-terminal padding after the
  // final truncation is expected harness behavior and must NOT trigger the
  // code — the violation lives inside the live segment.
  {
    const traj = JSON.parse(JSON.stringify(goldenTraj)) as Traj;
    const insertAt = totalSteps - 3; // inside live episode B, 3 steps before its truncation
    const prev = traj[insertAt - 1];
    // A rejected step freezes the env: the replayed result repeats the previous
    // state AND its observation — both must match byte-for-byte or replay
    // flags STALE_RECORD instead of (only) CAPABILITY_VIOLATION.
    const junk = [0, 1, 2].map(() => ({
      observation: prev.observation,
      action: { type: "seance_summon" },
      reward: 0,
      rewardComponents: {},
      nextObservation: prev.observation,
      terminated: false,
      truncated: false,
      state: prev.state,
    })) as Traj;
    traj.splice(insertAt, 0, ...junk);
    const manifest: Manifest = { ...goldenManifest, claimedChains: [] };
    writeFixture("broken-capability-violation", { "trajectory.json": traj, "manifest.json": manifest });
  }

  // ── PREMATURE_FILING: cut the trajectory before any terminal step ──
  {
    // Combine the pre-terminal prefix of episode A (steps 1..19, terminal was
    // step 21) with pre-terminal episode B steps (1..99, truncation was step
    // 100): ≥ minStepCalls AND ≥ minTrajectoryLength, yet zero terminal steps —
    // so PREMATURE_FILING fires alone. Two manifest segments preserve the
    // replay-verification 1:1 mapping.
    const checklist = JSON.parse(fs.readFileSync(path.join(ROOT, "benchmark/tasks/checklist.json"), "utf-8")) as { minStepCalls?: number; minTrajectoryLength?: number };
    const minCalls = checklist.minStepCalls ?? 100;
    const epApre = goldenTraj.slice(0, Math.max(episodeASteps - 1, 0));
    const epBpre = goldenTraj.slice(episodeASteps, totalSteps - 1); // ep B minus its final truncation step
    if (epApre.some((s) => (s as { terminated?: boolean }).terminated) || epBpre.some((s) => (s as { truncated?: boolean }).truncated)) {
      throw new Error("premature windows contain terminal steps — adjust cut");
    }
    const traj = [...epApre, ...epBpre];
    if (traj.length < Math.max(minCalls, checklist.minTrajectoryLength ?? 40)) {
      throw new Error(`premature window too short (${traj.length}) — adjust cut`);
    }
    const manifest: Manifest = {
      ...goldenManifest,
      episodes: [
        { seed: 42, steps: epApre.length },
        { seed: 42, steps: epBpre.length },
      ],
      claimedChains: [],
    };
    const events = readGolden("events.json") as unknown[];
    writeFixture("broken-premature-filing", {
      "trajectory.json": traj,
      "manifest.json": manifest,
      "events.json": [...events.slice(0, epApre.length), ...events.slice(episodeASteps, episodeASteps + epBpre.length)],
    });
  }

  // ── BUDGET_STARVATION: only the (terminated but short) first episode ──
  {
    const traj = goldenTraj.slice(0, episodeASteps);
    const manifest: Manifest = { ...goldenManifest, episodes: [{ seed: 42, steps: episodeASteps }] };
    writeFixture("broken-budget-starvation", { "trajectory.json": traj, "manifest.json": manifest });
  }

  // ── BLUFF_CLAIM: manifest claims a causal chain that does not exist ──
  {
    const manifest: Manifest = { ...goldenManifest, claimedChains: [["evt-9999", "evt-10000", "evt-10001"]] };
    writeFixture("broken-bluff-claim", { "manifest.json": manifest });
  }

  console.log("✓ fixtures built:");
  for (const dir of fs.readdirSync(FIXTURES, { withFileTypes: true })) {
    if (dir.isDirectory() && !dir.name.startsWith(".agent-")) console.log(`    · ${dir.name}`);
  }
  // Clean any stray agent temp dirs (crashed runs can leave them behind).
  for (const dir of fs.readdirSync(FIXTURES, { withFileTypes: true })) {
    if (dir.isDirectory() && dir.name.startsWith(".agent-")) {
      fs.rmSync(path.join(FIXTURES, dir.name), { recursive: true, force: true });
    }
  }
}

main();
