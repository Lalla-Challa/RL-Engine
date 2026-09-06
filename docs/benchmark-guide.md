# Benchmark Author Guide

How to create, grade, and maintain golden fixtures for a benchmark built on `rl-engine`. For environment authoring itself, read `rl-engine/domain-packs/README.md` first.

## 1. The shape of a benchmark

```
benchmark/
├── scenario/   spec.json (STARTER — deliberately defective) + scenario.json (hashes)
├── tasks/      task.md (the agent's prompt) + checklist.json (minimums)
├── grader/     grader.ts — forensic 100-pt scorer
├── fixtures/   golden/ + 8 broken/ (checked-in, regenerable)
├── scripts/    build-scenario · reference-agent · build-fixtures · test-fixtures · grade-dossier
└── dossier/    where a live run files its artifacts
```

A **dossier** is what an agent files after working; the grader scores it from five files: `trajectory.json`, `spec-snapshot.json`, `events.json`, `manifest.json` (seeds + episode segments + claimed causal chains), and `trace.json` (runtime MCP call trace). Everything the grader checks is derived from those files — there is no hidden oracle.

## 2. Producing a golden fixture

The reference agent is a headless script (no LLM, no API keys) that drives the real MCP server over stdio JSON-RPC:

```bash
node --import tsx benchmark/scripts/reference-agent.ts benchmark/fixtures/golden
```

It performs the full golden loop — discover tools, hit the starter spec's compile defects, repair, reset, ≥100 real `env_step` calls, reach a terminal state, self-verify causal chains from the event graph, file the dossier, grade itself — and asserts 100/100 before writing anything.

To produce a golden dossier for a DIFFERENT domain pack, parameterize the agent: the spec comes from `rl-engine/domain-packs/<pack>/spec.json`, and the scripted action cycle lives at the top of `reference-agent.ts`. Keep the protocol purity: the agent must never import the engine directly.

## 3. Generating broken fixtures

```bash
node --import tsx benchmark/scripts/build-fixtures.ts
node --import tsx benchmark/scripts/test-fixtures.ts
```

`build-fixtures.ts` regenerates `golden/` then derives each broken fixture by a **surgical corruption** of the golden dossier. Each broken fixture must trigger exactly ONE named failure code — the classification test asserts `failures.length === 1`. Current corruption recipes:

| Fixture | Corruption | Expected code |
|---|---|---|
| skipped-compliance | delete a constraint from `spec-snapshot.json` | `SKIPPED_COMPLIANCE` |
| stale-record | bump one mid-run state value (replay diverges) | `STALE_RECORD` |
| unresolved-target | ship the defective starter as the snapshot (distinct `version` so the echo check stays clean) | `UNRESOLVED_TARGET` |
| knowledge-violation | add an observation source not in the state schema | `KNOWLEDGE_VIOLATION` |
| capability-violation | insert 3 identical rejected steps inside a LIVE episode (frozen observation/state byte-matched so replay stays exact) | `CAPABILITY_VIOLATION` |
| rule-weaken (compliance tamper) | delete a compliance precondition from a rule in `spec-snapshot.json` | `SKIPPED_COMPLIANCE` (names the rule) |
| premature-filing | cut a pre-terminal window ≥ `minTrajectoryLength` | `PREMATURE_FILING` |
| budget-starvation | ship only the short first episode | `BUDGET_STARVATION` |
| bluff-claim | add a `claimedChains` path absent from `events.json` | `BLUFF_CLAIM` |

When authoring a new corruption, keep it isolated: run `test-fixtures.ts` and fix anything that leaks a second code (e.g., a truncated trajectory that also drops below `minTrajectoryLength` fires two codes — choose a window above the minimum instead).

## 4. Grading a dossier

```bash
node --import tsx benchmark/scripts/grade-dossier.ts benchmark/dossier
```

The 100-point rubric: World Completeness 25 · Compliance 20 · Simulation Operation 25 (includes **replay verification**: the recorded spec+seed+actions must reproduce the recorded states) · Causality 15 (walked from the event graph: events, edges, chain depth, multi-parent convergence, claimed chains) · Dossier & Filing 15 (files present, not an echoed starter, novel content, no bluff). Thresholds: ≥80 pass, ≥40 partial, else fail.

Anti-bluff: SHA-256 echo vs the defective starter; state-novelty (fabricated repetition); claimed-chain existence edge-by-edge in the event graph.

## 5. Provenance (Phase H)

Every dossier trace.json is an rl-trace-v2 document: entries are signed chain-style with HMAC-SHA256 under a per-run token minted by the trusted harness (never exposed to the agent). The grader:

1. verifies the chain — any edit, deletion, reorder, or append breaks every subsequent digest — else PROVENANCE_FAILURE;
2. recomputes each env_step entry args digest from the trajectory and cross-checks it against the signed trace (audit finding F4) — else PROVENANCE_FAILURE. The cross-check is scoped to the FINAL binding epoch: entries before the last `env_use_spec` belong to discarded recordings and are skipped (rebinds legitimately reset the recorder).

Token flow: harness mints → server env (RL_RUN_TOKEN) → grader (ctx.runToken, or run-token.json in the fixture dir — a trusted harness artifact). Unsigned traces are rejected outright.

Deployment seeds: dossiers declare their own seeds in manifest.json and the grader replays with whatever seeds the run used — deployment MUST randomize seeds per session (never ship the default 42 to an agent) so pre-recorded trajectories fail replay verification.

## 6. Rules

1. **Fixtures are data, immutable once referenced** — bump `environment.version` and regenerate rather than editing content (see `VERSIONING.md`).
2. **No LLM and no network in the loop** — the reference agent and grader run fully offline.
3. **Grader changes need fixture updates** — if you touch `grader.ts`, rerun `build-fixtures.ts` + `test-fixtures.ts`; CI fails otherwise.
4. **Determinism is the substrate** — a golden dossier is only reproducible because the engine is (spec §44); never introduce wall-clock data into a dossier.
