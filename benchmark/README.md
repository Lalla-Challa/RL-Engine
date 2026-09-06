# Harmon Creek Regional Hospital — Regulated Facility Commissioning

A scored, **fully offline** benchmark built on the generic RL environment engine (`rl-engine/`). An agent commissions a synthetic hospital through the MCP protocol: it must detect and repair spec defects, operate the environment for 100+ atomic `step()` calls, reach a terminated **and** a truncated episode, and file a dossier — which the grader then verifies against the engine's own event graph.

No API keys. No network. No LLM required (a headless scripted reference agent is included).

## Quickstart (single command)

```bash
./run_benchmark.sh        # Linux/macOS/Git Bash — or run_benchmark.cmd on Windows
```

The cycle: offline readiness check → headless reference agent runs the golden loop over **real MCP stdio JSON-RPC** and files a dossier → grader scores it → golden fixture classification (perfect dossier = 100/100; every broken fixture = its exact named failure code).

**Offline install note:** the only runtime dependency is the `tsx` TypeScript loader, vendored in `vendor/node_modules/` and committed. After cloning, nothing is downloaded — `run_benchmark.sh` uses the vendored loader and works air-gapped. (One-time setup if you ever need to re-vendor: `cd vendor && npm install --offline`.)

## How the brief's must-haves are satisfied

| Must-have | Implementation | Where to verify |
|---|---|---|
| ≥100 tool calls, long-horizon | The golden loop makes **130+ real MCP `tools/call`** including **≥100 `env_step`**; each runs the full 6-layer validation + atomic transition. `trace.json` (written by the *runtime*, not the harness) records every call with an args hash and step index. | `benchmark/dossier/trace.json`, fixture `trace.json` |
| Real tool use, not a transcript | Every call mutates a live SQL-free engine session via `rl-engine/api/mcpServer.ts` (JSON-RPC 2.0 stdio, MCP framing). The reference agent *is* an MCP client speaking the wire protocol to a child process. | `rl-engine/testing/mcp-golden-loop.ts`, `benchmark/scripts/reference-agent.ts` |
| Verifiable end state | A filed dossier: `trajectory.json` + `events.json` + `manifest.json` + `spec-snapshot.json` + `trace.json` + `scores.json`. The grader **replays the recorded actions** through the recorded spec+seed and requires the states to reproduce. | `benchmark/dossier/`, `benchmark/grader/grader.ts` |
| Partial credit | 100-point rubric over 5 phases; every phase lists `missed[]`. Fixtures demonstrate partial scores (65/90/93/95). | `scores.json` in any dossier |
| Named failure modes from real evidence | 7 codes + bluff detection, each derived from dossier forensics — see table below. | `scores.json → failures[]` |
| No shortcut / anti-bluff | SHA-256 echo detection (dossier spec identical to the seeded starter/reference = cheated), state-novelty scoring (fabricated repetition), and **claim verification**: any causal chain the dossier claims must exist edge-by-edge in the recorded event graph. | `scores.json → antiBluff`, `details.bluffChain` |
| Everything graded is discoverable | The grader reads only files inside the dossier + the repo's own reference spec and checklist. No hidden oracle. | `benchmark/grader/grader.ts` |
| Self-contained and offline | Engine is dependency-free; tsx vendored; no network calls anywhere in the cycle. | `run_benchmark.sh` |
| Pseudonymised data | All actors/roles/places are synthetic (Mara, Finn, Kael, Harmon Creek…). No real patient/client/employee data. | `benchmark/scenario/spec.json` |
| Documented rights | Engine + harness MIT; scenario + fixtures CC-BY-4.0. Full audit below. | `LICENSE.md`, `DATA_LICENSE.md` |

### Failure-mode → evidence map

| Code | Trigger (all from dossier forensics, never mocked) |
|---|---|
| `PROVENANCE_FAILURE` | The trace is unsigned, its HMAC chain does not verify against the run token, or its `env_step` argsHashes (scoped to the final binding epoch) do not cross-check against the trajectory. |
| `UNRESOLVED_TARGET` | The dossier's own `spec-snapshot.json` fails compilation with `unknown_target` errors (starter defects never fixed). |
| `SKIPPED_COMPLIANCE` | A constraint the domain reference declares is missing/weakened in the dossier spec, a trajectory state violates a declared range/forbidden constraint, or a **rule's compliance precondition was removed / rule deleted or disabled** vs the domain reference (matched by `environment.id`; the failure names the rule and the missing condition). |
| `STALE_RECORD` | Replaying the dossier's spec + seed + recorded actions does not reproduce the recorded states (the records don't match the world they claim). |
| `KNOWLEDGE_VIOLATION` | The observation model references sources that don't exist in the state schema — the run claims to know what nothing could have observed. |
| `CAPABILITY_VIOLATION` | ≥3 consecutive identical rejected steps (zero reward, state unchanged) **inside a live episode segment** — the agent never recovered to a legal action. Post-terminal padding after an episode's terminal step is expected harness behavior and never counts. |
| `PREMATURE_FILING` | No terminated/truncated step anywhere in the trajectory (or empty/missing trajectory). |
| `BUDGET_STARVATION` | Trajectory below `minTrajectoryLength` or runtime trace below `minStepCalls` (from `tasks/checklist.json`). |
| `BLUFF_CLAIM` | A causal chain claimed in `manifest.claimedChains` does not exist edge-by-edge in `events.json`. |

> Reference matching note: the grader locates each dossier's domain reference by scanning `rl-engine/domain-packs/*/spec.json` for the same `environment.id` — pack directory names may differ from ids. Foreign-domain dossiers are graded on replay + their own declared constraints only.

## Fixtures (checked in, regenerable)

```bash
node vendor/node_modules/tsx/dist/cli.mjs benchmark/scripts/build-fixtures.ts   # regenerate
node vendor/node_modules/tsx/dist/cli.mjs benchmark/scripts/test-fixtures.ts    # classify
```

| Fixture | Expected result |
|---|---|
| `golden/` | **100/100**, zero failures (produced by the reference agent over real MCP) |
| `broken-skipped-compliance/` | `SKIPPED_COMPLIANCE` only (90/100) |
| `broken-stale-record/` | `STALE_RECORD` only (90/100) |
| `broken-unresolved-target/` | `UNRESOLVED_TARGET` only (65/100) |
| `broken-knowledge-violation/` | `KNOWLEDGE_VIOLATION` only (95/100) |
| `broken-capability-violation/` | `CAPABILITY_VIOLATION` only (100/100 — passes points, fails forensics). Encodes a genuine stuck run: 3 illegal `seance_summon` steps inside live episode B *before* its truncation, replay-consistent (frozen observation/state byte-matched). |
| `broken-premature-filing/` | `PREMATURE_FILING` only (95/100) |
| `broken-budget-starvation/` | `BUDGET_STARVATION` only (95/100) |
| `broken-bluff-claim/` | `BLUFF_CLAIM` only (93/100) |

## Scoring — 100 points

| Phase | Points | Basis |
|---|---|---|
| World Completeness | 25 | spec present · compiles · version pinned · validator clean |
| Compliance | 20 | no unresolved targets · constraints & rule preconditions intact vs the domain reference & never violated · observations verifiable |
| Simulation Operation | 25 | ≥min steps · terminal reached · **replay-consistent** · trace ≥min calls |
| Causality (event graph) | 15 | ≥10 events · ≥5 edges · chain depth ≥2 · multi-parent convergence · claimed chains verified |
| Dossier & Filing | 15 | all files present · not an echo · novel content · no bluff claims |

Grade thresholds: ≥80 pass · ≥40 partial · else fail.

## Layout

```
benchmark/
├── README.md · LICENSE.md (MIT) · DATA_LICENSE.md (CC-BY-4.0)
├── scenario/          spec.json (starter, 4 deliberate defects) + scenario.json
├── tasks/             task.md + checklist.json (minStepCalls/minTrajectoryLength)
├── grader/grader.ts   evidence-based grader (replay, constraints, event graph, anti-bluff)
├── scripts/           reference-agent.ts · build-fixtures.ts · test-fixtures.ts · grade-dossier.ts · verify-offline.ts · build-scenario.ts
├── fixtures/          golden/ + 8 broken fixtures (checked in, regenerable)
├── harness/           call-counter.ts
└── dossier/           your filed run lands here (via quickstart)
```

## Connecting your own agent

The engine exposes an MCP server (stdio, JSON-RPC 2.0, zero dependencies):

```bash
node vendor/node_modules/tsx/dist/cli.mjs rl-engine/api/mcpServer.ts
```

Tools: `env_list_specs`, `env_get_specification`, `env_compile`, `env_save_spec`, `env_use_spec`, `env_step`, `env_reset`, `env_get_action_space`, `env_get_observation_space`, `env_get_state`, `env_get_events`, `env_trajectory`, `env_file_dossier`. The task prompt your agent should follow is `tasks/task.md`.

## Rights audit (DATA_LICENSE)

| Content | License | Notes |
|---|---|---|
| `rl-engine/**`, `benchmark/grader|scripts|harness/**` | MIT (Faisal Iqbal, 2026) | Original code, no third-party restrictions |
| `benchmark/scenario/**` (starter spec, scenario metadata) | CC-BY-4.0 | Synthetic; derived from the CCM framework (MIT) |
| `benchmark/fixtures/**` (golden + broken dossiers) | CC-BY-4.0 | Machine-generated from the scenario by the reference agent; no human data |
| `benchmark/tasks/**` (task prompt, checklist) | CC-BY-4.0 | Original text |
| Vendored `vendor/node_modules/tsx` | MIT (its own LICENSE) | Build-time loader only, not part of the graded artifact |

No real-world, personal, or third-party copyrighted data is included anywhere in this repository. Full text: `LICENSE.md` and `DATA_LICENSE.md`.
