# CMM-CME — Generic RL Environment Engine + Commissioning Benchmark

A **domain-independent reinforcement-learning environment engine** and a **buyer-ready scored benchmark** built on it. Any domain — logistics, trading, healthcare, insurance, legal, HR — is a declarative JSON **spec**, never a new harness: `EnvironmentSpecification → compiler → sandboxed runtime → reset()/step(action)` with atomic transitions, 6-layer validation, composable rewards, partial observability, and deterministic replay (Software Architecture Specification v1.0, §1–47).

Deterministic (seeded, replayable, hash-verified), atomic (invalid actions never mutate state), zero runtime dependencies (one-time dev-toolchain install from a committed lockfile; the grading cycle makes no network calls), and persistence-outside-kernel.

## Repository layout

| Path | What it is |
|---|---|
| `rl-engine/` | The engine: `core/` (state, rules, transitions, validation, randomness), `environment/` (runtime, compiler, validator, snapshots), `observation/`, `reward/`, `episode/`, `events/`, `persistence/`, `rl/` (trainer seam), `api/` (MCP server, provenance), `testing/` (gates), `domain-packs/` (8 declarative packs) |
| `benchmark/` | The scored commissioning benchmark: forensic grader, golden + broken fixtures, reference agent, task brief |
| `docs/` | Tutorial, benchmark author guide, migration notes |
| `docs/engine-architecture-specification.md` | The Software Architecture Specification (§1–47) the engine implements |
| `RedTeamTest/` | Authorized red-team engagement: consolidated report + reusable harness (`report.md` is the entry point) |
| `roadmap.md` | Living roadmap — phases with exit criteria, no timelines |
| `VERSIONING.md` | Semver for the engine, content hashes for frozen artifacts, the Rule-4B core ledger |

## Quickstart (one command, 100% offline)

```bash
./run_benchmark.sh        # or: run_benchmark.cmd on Windows
```

Runs a full grading cycle: offline readiness check → headless reference agent drives the golden loop over the real MCP protocol → forensic grader scores the filed dossier → all 9 fixtures classified (perfect = 100/100, each broken fixture = its exact named failure code).

## The engine in one paragraph

You write a JSON `EnvironmentSpecification`: a typed state schema, entities/relationships, an action space (discrete, parameterized, continuous, multiDiscrete, conditional), rules with composable conditions and effects (including declarative `$field`/`$mul`/`$sub` math), range/forbidden constraints, partial observations, weighted reward components, and termination. The compiler validates it (unknown targets, impossible probabilities, circular references — before training ever starts); the runtime executes `reset()/step()` through an atomic clone → validate → commit-or-discard pipeline where rejections name their §15 validation layer. Same spec + seed + actions → byte-identical trajectory, hash-verifiable.

```bash
# One-time toolchain install (tsx loader + typescript, from the committed lockfile)
npm ci --prefix vendor

# Drive it over MCP (JSON-RPC 2.0 stdio, 13 env_* tools — zero dependencies)
node vendor/node_modules/tsx/dist/cli.mjs rl-engine/api/mcpServer.ts
# Or run the full test battery
node vendor/node_modules/tsx/dist/cli.mjs rl-engine/testing/smoke.ts
node vendor/node_modules/tsx/dist/cli.mjs rl-engine/testing/pack-pipeline.ts   # all 8 packs: compile → smoke → determinism → properties → grade
```

## Domain packs (8)

`harmon-creek` (healthcare) · `harmon-creek-hard` (hidden-parameter hardened variant) · `warehouse-logistics` · `trading-market` · `insurance-claims` · `legal-filing` · `hr-onboarding` · `hospital-billing` (cross-system EHR↔Pharmacy↔Billing).

Every pack is pure JSON and passes the same generic pipeline (compile → validate → smoke → determinism gate → property suite → forensic grade) with **zero engine edits** — that's the reusability proof. Authoring contract and the compliance patterns that survived adversarial review: [`rl-engine/domain-packs/README.md`](rl-engine/domain-packs/README.md).

## The benchmark

A buyer-oriented evaluation harness for long-horizon agentic work: ≥100 real tool calls over MCP, verifiable end state, partial credit via reward components, and **named failure modes derived from dossier forensics** — `SKIPPED_COMPLIANCE`, `STALE_RECORD`, `PREMATURE_FILING`, `CAPABILITY_VIOLATION`, `KNOWLEDGE_VIOLATION`, `UNRESOLVED_TARGET`, `BUDGET_STARVATION`, `BLUFF_CLAIM`, `PROVENANCE_FAILURE`. Anti-bluff is structural: HMAC chain-signed traces, echo detection, state-novelty scoring, and claim-vs-event-graph verification. Details: [`benchmark/README.md`](benchmark/README.md).

## Provenance & security posture

Every dossier trace is an `rl-trace-v2` document, chain-signed with HMAC-SHA256 under a per-run token held by the trusted harness (never exposed to the agent). The grader verifies the chain, cross-checks every `env_step` args digest against the trajectory, replays the spec + seed + actions, and enforces rule-condition integrity against the domain reference. Core-integrity is enforced by a hash manifest with a documented-gap ledger (Rule 4B, GAP-1..5). All of this is CI-proven on Windows + Ubuntu (`.github/workflows/ci.yml`).

## Red-team verified

Two authorized red-team engagements ran against the compliance packs through a caged MCP-only agent (26 probes each, independent seeds). Run 1 found one confirmed bypass (a double-billing loop) and one engine defect; all findings were remediated (Phase I). Run 2 verified **0/26 bypasses** under new seeds and the grader caught the spec tamper by rule name. Full process, performance, and results: [`RedTeamTest/report.md`](RedTeamTest/report.md).

## Status

Phases A–J complete: engine, MCP server, buyer-ready grader + fixtures, 8 domain packs with a core-integrity ledger, persistence + cross-process replay, reference trainer, CI + security pass, procurement audit remediation (cryptographic provenance, hidden parameters, hardened variant), and two red-team remediation/verification cycles. All gates green.

## License

Engine + harness: MIT ([`benchmark/LICENSE.md`](benchmark/LICENSE.md)). Benchmark scenario + fixture data: CC-BY-4.0 ([`benchmark/DATA_LICENSE.md`](benchmark/DATA_LICENSE.md)). All data is synthetic — no real persons, companies, or institutions.
