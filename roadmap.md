# Roadmap — Generic RL Environment Engine + Commissioning Benchmark

Living document. It tracks **objectives**, **current reality**, and the **work ahead**. Progress is measured by exit criteria, not dates — a phase is done when its "done when" list is green, whether that happens quickly or slowly.

---

## 1. Mission (the objective)

Turn the original story simulator into a **domain-independent RL environment engine** and a **buyer-ready scored benchmark**, so that any future domain (logistics, trading, scheduling, healthcare, games) is a declarative JSON spec — never a new harness.

Three top-level objectives:

1. **O1 — Generic engine.** `rl-engine/` implements the Software Architecture Specification (§1–47): declarative `EnvironmentSpecification` → compiler → sandboxed runtime → `reset()/step(action)` with atomic transitions, 6-layer validation, composable rewards, partial observability, deterministic replay.
2. **O2 — Benchmark fit.** The commissioning benchmark satisfies every must-have of the brief: ≥100 real tool calls, verifiable end state, partial credit, named failure modes, anti-bluff, offline, pseudonymised, licensed.
3. **O3 — Reusability proof.** Multiple domain packs run on the same core with **zero engine edits**, proving the one-time investment pays back.

---

## 1b. Procurement audit register (frontier-model buyer, long-horizon agentic tasks)

A Senior Technical Evaluator / Procurement Auditor review graded this deliverable against the buyer's seven must-haves. Verdict: **FIT WITH CONDITIONS** — all seven requirements pass with re-verified evidence (127 tool calls / 121 `env_step` / 7 tools in the live trace; all 9 fixtures classified exactly; grader purity clean; offline packaging verified). The conditions below are the open work; **Phase H** implements them.

| # | Severity | Finding | Disposition |
|---|---|---|---|
| **F1** | Medium-High | Provenance is not cryptographically bound to the protocol — replay proves a trajectory is *world-consistent*, but a resourced agent could generate it via the engine library directly and hand-assemble a dossier, bypassing MCP; the runtime trace corroborates but is unsigned. | **H1 — signed trace provenance** |
| **F2** | Medium | Deterministic environment → optimal policy precomputable; evaluation risks measuring plan-then-replay rather than sustained operation. | **H2 — deployment randomization** |
| **F3** | Medium | Difficulty is procedural more than cognitive — fix-4-typos and a scripted cycle are modest for a frontier model. | **H3 — hardened scenario variant** |
| **F4** | Low | Trace `argsHash` entries are corroborating only, not cross-verified against trajectory actions. | Folded into H1 |
| **F5** | Low | Non-Windows CI runners need `npm ci --prefix vendor` (network) — vendored esbuild binary is platform-specific. | **H4 — cross-platform CI** |

---

## 2. Where we are right now

> **Tree note (2026-09-06):** `engine-core/` (the legacy CCM/CCE reference mirror, which bundled the vendor's public `story-vault-mcp` packages) has been **removed from the repository** to keep the artifact self-contained. The architecture specification it hosted now lives at `docs/engine-architecture-specification.md`; historical mentions of `engine-core/` below describe superseded states.

### Shipped and verified

| Area | State |
|---|---|
| **Engine core** | `core/` complete: typed state schema (§6), 11 effect ops + composable `all/any/not/contains` conditions (§11–12), atomic transitions (clone → validate → commit-or-discard, §16), seeded `RandomService` (§28), validation pipeline (§15) |
| **Environment** | `createEnvironment` with the full `step(action)` pipeline (validate action → evaluate rules → atomic transition → reward → observation → termination → `StepResult`); 7-stage compiler with reference resolution (§32); environment validator (§33) |
| **Observation & reward** | Declarative partial observability (`Observation ⊂ State`, §17); composable rewards `R = Σ component × weight` with per-component breakdown (§18–19) |
| **Episode layer** | Lifecycle, `TrajectoryRecorder` (§26), `replay(spec, seed, actions)` → byte-identical trajectory (§27, §44) |
| **Supporting layers** | Events + causal graph (§24–25), plugin interface + sandboxed function registry (§30–31), persistence outside the kernel (§29), thin `Policy`/`Trainer` interfaces (§34–38), determinism/environment/property test harnesses (§45) |
| **Domain pack #1** | `domain-packs/harmon-creek/spec.json` — the legacy story world runs as pure JSON with zero `ccm/` imports (§46 Phase 9) |
| **Benchmark** | Starter spec with 4 deliberate compiler-level defects; task prompt + checklist; 100-pt grader (5 phases, partial credit, named failures, 4 anti-bluff checks); call counter; build/verify/grade scripts |
| **Verification** | End-to-end smoke: 22/22 checks — defect detection, atomic invalid-action rejection, terminated + truncated episodes, 122 real `step()` calls, reward composition proven, identical replay, **grader 100/100**. `tsc --strict` clean. Legacy story-engine smoke still green from its canonical location |

### Known gaps (honest list)

- **MCP surface still speaks the old story protocol** — 78 CCM tools; nothing exposes `reset/step/getActionSpace/getObservationSpace/getSpecification` to an external agent client yet.
- **RL layer is interfaces only** — `RandomPolicy` and `NoopTrainer` exist; no reference trainer, replay buffer is naive.
- **Persistence is file-based** — specs and trajectories are JSON files; no DB adapter, no snapshots/restore of engine state.
- **Grader depth is basic** — causality is scored as "reward components present", not by walking the causal graph; call-count enforcement is not wired to the trace file; failure-mode codes are only partially emitted.
- **One domain pack** — domain-independence is proven once (§46 Phase 9), not repeatedly.
- **`engine-core/` mirror is unresolved** — it remains a manual copy-view of the parent repo (`D:\story-vault`), and standalone `tsc` there still needs the parent's import paths.
- **No CI, no published package** — everything runs from local checkouts; `rl-engine` is not installable yet.

---

## 3. How we get there — phases with exit criteria

Each phase lists **work** and **done when**. Work in any order that unblocks; phases are ordered by dependency, not urgency. Nothing here carries a date.

### Phase A — Kernel hardening  ✅ COMPLETE

**Objective:** the engine core is release-grade on its own terms.

Work:
- ✅ Unify the error taxonomy: every rejection path returns `{ valid:false, layer, reason }` with the §15 layer names; compiler errors share the same shape (`code, message, path`). Constraints got their own `constraint_validation` layer (forbidden/range enforced post-transition); `state_compatibility` now rejects immutable-field mutations and type-incompatible ops; runtime target-resolution failures report `transition_validation`.
- ✅ Spec versioning + migration: `environment.specVersion` checked against `SUPPORTED_SPEC_VERSION` — newer major is fatal, minor drift is a warning; unknown condition/effect ops, duplicate rule ids, out-of-bounds defaults are compile errors; a `warnings[]` channel carries advisory findings.
- ✅ Expand property tests (P1–P7): schema bounds never violated across seeded runs, terminal freeze (terminated *and* truncated), outcome frequencies converge to declared probabilities (4k samples, ±5%), immutable fields rejected, entity/rel effect targets resolve into sub-records, invalid actions never mutate.
- ✅ Determinism gate as a repeatable command: canonical-JSON key sorting + SHA-256 `trajectoryHash`, `npm run determinism` replays the reference pack across seeds 42/7/2024 twice each and compares hashes; also wired into `npm run smoke`.
- ✅ Remove the last rough edges: `entity:`/`rel:` effect targets now actually resolve (previously they silently wrote to the state root — real bug); relationships stored as first-class `rel:<id>` state; numeric ops no longer silently coerce non-numbers to 0 (rejected at `state_compatibility`); deep compares and hashing use canonical JSON; observation `filter` expressions implemented (sandboxed `<path> <op> <value>` parser, incl. `source: "entities"`); `contains` works on strings, arrays and object keys.

**Done-when status:** `tsc --strict` clean ✅ · smoke (26 checks incl. all suites) + property suites + determinism gate pass ✅ · grader still 100/100 on the golden run ✅. The "two engineers can add a rule" criterion lands with the domain-pack authoring contract in Phase D.

### Phase B — MCP / agent surface re-scope  ✅ COMPLETE

**Objective:** an external MCP client (Claude Desktop, Cursor, any agent) can run the full commissioning task through the generic API.

Work:
- ✅ New tool set, zero dependencies: `rl-engine/api/mcpServer.ts` speaks JSON-RPC 2.0 over stdio with MCP framing (initialize / tools/list / tools/call; LSP-style Content-Length framing also accepted). 12 `env_*` tools: `env_list_specs`, `env_get_specification`, `env_compile`, `env_save_spec`, `env_use_spec` (bind + reset; defective specs are refused with their compile errors), `env_step`, `env_reset`, `env_get_action_space`, `env_get_observation_space`, `env_get_state`, `env_trajectory`, `env_file_dossier`.
- ✅ Canon gate preserved: nothing mutates world state except `env_step` (and `env_reset`, which starts a new episode); invalid actions return the validation result with the failing §15 layer instead of mutating; `env_file_dossier` refuses premature filing.
- ✅ Runtime trace wired into the server: `api/trace.ts` records every `tools/call` (index, tool, args hash, step index) continuously to `trace.json` — run evidence, not harness fiction. Sandbox: `RL_ENGINE_DATA_DIR` isolates saved specs (`specs/<id>.json`) + dossier; ids sanitized.
- ✅ Story tools archived by isolation: the 78 legacy tools stay untouched in `engine-core/mcp.ts` (parent app still uses them); the new server is a separate process with no legacy imports.
- ✅ Done-when proven end-to-end: `testing/mcp-golden-loop.ts` spawns the server as a real child process and drives the golden loop purely through the protocol — initialize → 4 defects surfaced over MCP → repair + save → bind → 122 real `env_step` calls (episode A terminates, B truncates, invalid action rejected atomically) → dossier filed → grader 100/100 → trace shows 130 tool calls / 122 steps. `MCP GOLDEN LOOP PASSED`.

**Done-when status:** golden agent loop completes using only the new tools ✅ · `trace.json` shows ≥100 real calls (130/122) ✅ · `tsc --strict` clean ✅ · smoke (26 checks) + determinism gate still green ✅. HTTP transport deferred: the stdio path is the one Claude Desktop-class clients use; Streamable HTTP is additive and lands with Phase G hardening.

### Phase C — Benchmark buyer-readiness  ✅ COMPLETE

**Objective:** the benchmark is something a third party can download, run, and grade without us in the room.

Work:
- ✅ Grader depth: `benchmark/grader/grader.ts` rewritten as an evidence-based forensic grader. Causality is scored by walking the **recorded event graph** (121 events / 233 edges / depth 63 / 115 multi-parent convergences on the golden run) — chain depth, edge count, multi-parent convergence, claimed-chain verification — no more "components present" heuristics. The kernel records an EngineEvent per step with incremental causal linking (§24/§25); the MCP session exposes it via `env_get_events` and files it as `events.json`.
- ✅ All 7 named failure modes + bluff detection emit from real dossier forensics: `UNRESOLVED_TARGET` (dossier spec fails compile), `SKIPPED_COMPLIANCE` (reference constraints missing/weakened or trajectory states violating declared constraints), `STALE_RECORD` (**replay verification** — recorded spec+seed+actions must reproduce the recorded states), `KNOWLEDGE_VIOLATION` (observation sources absent from the state schema), `CAPABILITY_VIOLATION` (run ends in ≥3 identical rejected steps), `PREMATURE_FILING` (no terminal step), `BUDGET_STARVATION` (below checklist minimums), `BLUFF_CLAIM` (claimed causal chain absent edge-by-edge from the event graph).
- ✅ Anti-bluff hardening: SHA-256 echo detection against the defective starter (filing the corrected reference is a legitimate repair, not an echo); state-content novelty scoring at a threshold calibrated to catch fabricated repetition while passing honest no-op-heavy cycles; claim-vs-graph verification.
- ✅ Dossier v2: `manifest.json` (spec identity, episode segments with seeds, claimedChains) + `events.json` + trajectory + spec-snapshot + runtime trace — all filed atomically by `env_file_dossier` (which now grades the directory it actually wrote, fixing a Phase B bookkeeping bug where the session's cross-episode trajectory recorder was reset and the grader read a stale directory).
- ✅ Golden fixtures: `benchmark/fixtures/golden` produced by a **headless scripted reference agent** (non-LLM, speaks pure stdio JSON-RPC to a spawned MCP server, self-verifies its causal claims before filing) — scores exactly 100/100. Eight broken fixtures, each surgically corrupted to isolate exactly ONE code; `test-fixtures.ts` asserts exact classification: golden 100/no-failures, each broken fixture returns its expected code and only that code.
- ✅ Packaging & offline: `tsx` vendored in `vendor/node_modules/` (committed); single-command quickstart `run_benchmark.sh` / `run_benchmark.cmd` runs readiness → reference agent → grading → fixture classification with zero network; buyer-facing README with the must-have mapping table, failure-mode→evidence map, fixture table, and a DATA_LICENSE audit (engine/harness MIT; scenario/tasks/fixtures CC-BY-4.0; no third-party or human data anywhere).

**Done-when status:** grader passes all fixtures (golden = 100/100 exactly; each broken dossier = its exact expected code) ✅ · fresh machine: clone → `./run_benchmark.sh` → graded dossier with zero network (vendored loader, no post-clone downloads) ✅ · `tsc --strict` clean across engine+benchmark ✅ · smoke 26/26, determinism gate, and MCP golden loop (130 calls / 122 steps over the wire) all green ✅.

### Phase D — Domain-independence proof (more packs)  ✅ COMPLETE

**Objective:** O3 — the same core runs visibly different domains with zero engine edits.

Work:
- ✅ **Pack #2 — `domain-packs/warehouse-logistics/`** (Northgate Distribution Center): multiDiscrete actions (zone × destination × quantity dims), integer inventory counters with range constraints, temporal termination (maxSteps) + throughput termination, congestion rules targeting entity state, movement-effort reward shaping. Pipeline: compile → validate → smoke (68 committed steps, 3 illegal-action shapes rejected atomically) → determinism gate (seeds 42/7) → properties P1–P7 → forensic grade **100/100**.
- ✅ **Pack #3 — `domain-packs/trading-market/`** (Meridian Exchange): continuous action space (fractional order sizing, clamped and written to state before rule effects), float schema (cash/shares/price), `multiply` (fee drag, ±1% price moves) and `divide` (position halving) ops, declarative `$field`/`$mul` effect resolution (`cash -= shares × price`), stochastic-outcome price dynamics, multi-component reward shaping (PnL delta − quadratic inventory risk − activity cost). Pipeline: **100/100**, all engine paths the hospital pack never touches now exercised.
- ✅ **`domain-packs/README.md`** — the spec-authoring contract: pack layout, every spec section, all five action-space kinds with envelopes, rule/effect/outcome semantics, reward expression grammar, the pack-pipeline workflow, the rules of the contract (never edit core for a domain), and the engine gap ledger.
- ✅ **Core-independence enforcement**: `testing/core-integrity.ts` hashes every `core/` file against `domain-packs/core-manifest.json`; the manifest carries the rule-4B gap ledger with pre-fix hashes. Current state: **CORE INTEGRITY VERIFIED** — the only core changes vs the Pack #1 baseline are the two documented platform gaps below.
- ✅ **Gap ledger (rule 4B):** **GAP-1** (`types.ts`, `validation.ts`) — continuous/multiDiscrete action kinds had no type discriminator and no runtime validation; fixed as a generic five-kind `validateActionAgainstSpace` shared by runtime + compiler. **GAP-2** (`state.ts`) — effect values were literals; fixed with the sandboxed §31-subset declarative resolver (`$field/$mul/$add/$sub/$div`). Both are domain-agnostic abstractions any future pack reuses. Non-core adjustments: reward expressions may reference `action.value/type`; the §33 validator accepts outcome-only stochastic rules (spec §14 pattern); the Phase C grader scopes hospital-specific compliance/echo checks to same-domain dossiers.

**Done-when status:** three packs from three domains all pass compile → validate → smoke → grade ✅ (`pack-pipeline.ts`: ALL CHECKS PASSED; harmon-creek 100/100, warehouse 100/100, trading 100/100) · core diff between Pack #1 and Pack #3 = exactly the two documented platform gap fixes, hash-verified by the integrity manifest ✅ · full regression green (smoke, fixtures, determinism gate, MCP golden loop, quickstart cycle, `tsc --strict`) ✅.

### Phase E — Persistence & integration  ✅ COMPLETE

**Objective:** environments survive process boundaries and integrate with the parent system.

Work:
- ✅ **Persistence adapter interface (§29)** — `persistence/adapter.ts`: `saveSpec/loadSpec/saveTrajectory/loadTrajectory/saveSnapshot/loadSnapshot/listSnapshots`, synchronous, kernel never touches storage. Two implementations: `fileAdapter.ts` (directory tree of JSON documents, default) and `sqlCipherAdapter.ts` — the latter reuses the parent system's exact connection patterns (`better-sqlite3-multiple-ciphers`, `pragma key = "x'<hex>'"`, `journal_mode = WAL`, `busy_timeout = 5000`, scrypt key derivation from auth.json keySalt, N=4096), resolving the native driver from the parent checkout or an installed package via `RL_SQLCIPHER_DRIVER_BASE`.
- ✅ **Snapshot & restore (§29/§45)** — `environment/snapshot.ts` + `env.snapshot()/env.restore()`: captures `state + stateHash + stepCount + episodeIndex + terminated/truncated + lastFired + rngState + events` with spec identity + spec-hash guards (restore refuses a changed spec or corrupted state).
- ✅ **GAP-3 (Rule 4B, core)** — the PRNG internal state was closure-private, making exact mid-episode restore impossible; `mulberry32` now exposes `snapshotState()/restoreState()` (its entire state is one integer) behind the `RandomService` interface. Recorded in the core manifest with pre-fix hash; **CORE INTEGRITY VERIFIED** with GAP-1/2/3 on the ledger.
- ✅ **Cross-process replay verification (DoD #1)** — `testing/cross-process-replay.ts` spawns Process A (start episode, 30 steps, persist trajectory + snapshot via SQLCipher, exit), then Process B (fresh process: load spec + snapshot from the store, restore, continue to step 120), plus an uninterrupted in-process reference run. Result: **120/120 step hashes mathematically identical** through the SQLCipher adapter *and* the file adapter; restored state hash == A's final hash; B's continuation == reference exactly.
- ✅ **Integration (DoD #2, Path B)** — parent app integration was analyzed: `D:\story-vault` is present and its driver even loads from plain Node, but its runtime is Electron-ABI-coupled (electron-rebuild postinstall, tRPC routers, vault lifecycle); embedding there means an Electron main-process change, which the parent repo (single initial commit, app-side ownership) isn't set up to accept from this workspace. Executed Path B instead: `rl-engine` builds as a standalone package (`build-dist.mts` → `dist/` ESM+CJS+`.d.ts`, domain packs shipped as data, `exports` map for `.`, `./persistence`, `./packs/*`), packed with `npm pack` and **installed from the tarball into a scratch project** — the installed CJS engine runs all three domain packs, both adapters work (SQLCipher via the parent's driver), and snapshots roundtrip through the adapter. Path A remains a documented follow-up: `persistence/sqlCipherAdapter.ts` already speaks the parent's vault scheme, so embedding later reduces to a feature-flagged `require("rl-engine")` in the Electron main process.

**Done-when status:** an episode started in Process A continues in Process B with mathematically identical replay (120/120 hashes, both adapters) ✅ · the package builds (`esbuild` + `tsc` declarations) and installs cleanly from the local tarball with zero errors ✅ · full regression green (pack pipeline 3×100/100, smoke, fixtures 9/9, determinism gate, MCP golden loop, `tsc --strict`, core integrity) ✅.

### Phase F — RL training layer  ✅ COMPLETE

**Objective:** prove the §34–35 Policy/Trainer seams actually train an agent, without coupling the core engine to any algorithm.

Work:
- ✅ **Reference trainer: tabular Q-learning** (`rl/qlearning.ts`) — the single inspectable algorithm, sitting entirely behind the seams: the engine core never sees it. Components: generic `discreteActionCatalog` (spec → action envelopes), generic `makeDiscretizer` (numeric-observation bucketing → state key), `TabularQPolicy` (ε-greedy over a Q table, seeded RNG, deterministic argmax tie-break, checkpoint/restore), `QLearningTrainer` (online Q updates + gated prioritized replay). Stability engineering, verified empirically with the Q-table diagnostic (`testing/diagnose-q.ts`): **priority clipping** (|TD error| capped at 1.0 — without it, terminal transitions in a V≈1000 environment dominate sampling forever), **Robbins-Monro learning-rate decay** (α = α₀/√N per state-action — constant α oscillates ±300 per update on this value scale), and **replay gating** (every 4th episode — replaying single-sample transitions from a stochastic environment flattens unvisited Q rows into a degenerate fixed point).
- ✅ **ReplayBuffer upgrade** (`rl/replayBuffer.ts`): proportional priority sampling (prefix-sum + binary search, without replacement), FIFO ring-buffer capacity eviction, full serialization including the sampling RNG state — and the old `Math.random` sampling (a §28 determinism violation) removed.
- ✅ **Checkpoint round-trip (DoD #2)** — `testing/trainer-roundtrip.ts`: Trainer A trains 80 episodes → checkpoint through the Phase E adapters (new `saveArtifact/loadArtifact` on both File and SQLCipher adapters) → 60 more episodes; Trainer B loads the same artifact and runs the identical 60. Results: **Q tables, replay buffer (entries + sampling RNG), epsilon position, and episode counter byte-identical** after continuation; mid-training greedy returns reproduce exactly; artifacts are adapter-independent (file ↔ sqlite). Verified through both adapters.
- ✅ **Learning demo (DoD #1)** — `testing/learning-demo.ts`, Harmon Creek pack, Q-learning vs seeded `RandomPolicy` on the exact same held-out seeds: **trained 857.4 ± 9.3 vs baseline 225.2 ± 106.4 (+280.7%), 8/8 seeds won**, with a flat-stable greedy validation curve (856.0 from ep 24 onward). The curve is greedy validation on fixed seeds, not raw training returns — per-episode returns are confounded by ε-decay (greedy episodes terminate sooner, shrinking raw returns even as the policy improves), a measurement lesson now documented in the demo.
- ✅ **GAP-4 ledgered** (rl/ layer, outside the hash-checked core set — recorded in the same manifest process): the original `Trainer.train(policy, episodes)` seam gave a trainer no environment access (§34's orchestration diagram was unrealizable); fixed to `train(envFactory, policy, ctx)`. Pre-fix hashes recorded. **CORE INTEGRITY VERIFIED — GAP-1/2/3/4 on the ledger; `core/` untouched by Phase F.**

**Done-when status:** demo shows measurable improvement vs RandomPolicy on identical seeds (280.7%, 8/8 seeds, stable validation curve) ✅ · checkpoints survive save/load round-trip without errors or state mutation (byte-identical continuation, both adapters) ✅ · full regression green (packs 3×100/100, smoke, fixtures 9/9, determinism gate, MCP golden loop, cross-process replay 120/120, `tsc --strict`, core integrity) ✅.

### Phase G — Release & maintenance posture  ✅ COMPLETE

**Objective:** the work stays trustworthy as it grows — automated quality gates, a hardened sandbox, formal versioning, real docs, and a settled mirror end-state.

Work:
- ✅ **CI pipeline** (`.github/workflows/ci.yml`): 15 sequential gates on every push/PR — version report → `tsc --strict` (whole workspace via `tsconfig.check.json`) → core-integrity ledger → offline readiness → smoke (incl. properties) → determinism gate → golden-fixture classification → 3-domain pack pipeline → trainer checkpoint round-trip → cross-process replay → MCP golden loop → learning demo → sandbox security pass → tutorial example → dist build. Plus a separate **tamper-drill job**. Self-contained: the toolchain (tsx/esbuild/typescript/@types/node) lives in committed `node_modules/`, so CI needs no registry.
- ✅ **Proof of enforcement (DoD #1)** — `testing/negative-gate.ts`: every fault is *injected* and asserted *caught*. Verified live: 7 sandbox escape probes (eval/require/process/constructor-constructor) neutralized fail-closed; prototype-pollution registry probes rejected; spec bombs (1.5 MB spec, 600 rules, over-deep conditions, oversized expressions) rejected by the compiler; kernel I/O conformance scan (spec-evaluation chain contains no fs/net/http/child_process imports and no eval-class constructs); reward-tampered dossier → `STALE_RECORD`, terminal-stripped dossier → `PREMATURE_FILING`; and the **determinism drill** — a scratch copy of the engine with `Math.random` noise injected into the PRNG fails the Phase A determinism gate (exit 1). CI's `tamper-drill` job runs the drill on every push: a nondeterminism PR fails the build automatically.
- ✅ **Sandbox security pass (§40)**: reward expressions now compile through a **hand-written shunting-yard parser** (the old `new Function(...)` was an eval-class construct on the sandbox boundary — replaced, fail-closed, 7 escape probes neutralized); function-registry allowlist frozen + `isAllowedFunction` with prototype-pollution hardening (`constructor`/`__proto__` rejected), `random` deliberately excluded for determinism; **spec-size limits** in the compiler (`environment/limits.ts`: 1 MB spec, rule/field/entity caps, condition-depth guard, expression-length cap); kernel import-graph conformance test. No `core/` changes — Rule 4B ledger untouched (still GAP-1/2/3/4, integrity verified).
- ✅ **Versioning policy** (`VERSIONING.md` + `testing/version-report.ts`): semver for the engine API (bump table), separate spec-format version (`SUPPORTED_SPEC_VERSION`) and snapshot format (`SNAPSHOT_VERSION`), content hashes (SHA-256) for every frozen pack/scenario — printed at the top of every CI run for build provenance.
- ✅ **Docs (DoD #2)**: `docs/tutorial.md` — build a working thermostat environment in ~60 declarative lines; the companion `docs/examples/toy-thermostat.ts` is executed by CI so the tutorial can never silently rot. `docs/benchmark-guide.md` — golden-fixture authoring, the 8 corruption recipes, grader scoring and anti-bluff mechanics. `docs/migration-from-ccm.md` — full legacy→generic concept mapping table and 6-step world-migration procedure.
- ✅ **`engine-core/` end-state: FROZEN** — `engine-core/FROZEN.md` declares it an immutable historical reference (no edits, no build paths reference it — `tsconfig.check.json` and CI exclude it; `verify-offline.ts` checks existence only). The active engine is `rl-engine/`; the parent app keeps its own working copy until it adopts the `env_*` surface.

**Done-when status:** a PR breaking determinism, the sandbox, or a golden fixture fails CI automatically (negative gate + tamper-drill job, all faults verified caught) ✅ · a newcomer can read the tutorial and build a working toy environment — proven by CI executing the companion example end-to-end ✅ · all 15 CI gates green in a local dry run ✅ · full regression green (packs, smoke, fixtures, golden loop, cross-process, demo, `tsc --strict`, core integrity) ✅.

### Phase H — Audit remediation: procurement findings F1–F5  ✅ COMPLETE

**Objective:** close the conditions on the "FIT WITH CONDITIONS" verdict — make the benchmark tamper-evident against resourced agents, non-precomputable at deployment time, and cognitively harder, without regressing any Phase A–G gate.

Work (split by findings, no time estimates):

- ✅ **H1 — Signed trace provenance (F1 + F4).**
  - `api/provenance.ts`: harness mints a per-run token (`mintRunToken`); the MCP server derives an HMAC-SHA256 key (`deriveTraceKey`, domain-separated) and signs every trace entry chain-style — `digest_i = HMAC(key, entry_i ++ digest_{i-1})` — so deletion, reorder, replay, edit, or append of any entry breaks every subsequent digest and the recorded chainHead.
  - `TraceWriter` writes the `rl-trace-v2` signed envelope continuously; `env_file_dossier` files it plus a provenance summary in `manifest.json`.
  - Grader: new named failure code **`PROVENANCE_FAILURE`** — unsigned traces are rejected outright; signed traces must verify against the run token (ctx / `RL_RUN_TOKEN` / `run-token.json`, a trusted harness artifact) *and* pass the F4 cross-check: the grader recomputes each `env_step` args digest from the trajectory and requires a 1:1 match with the signed trace indices. Dossier rubric rebalanced (dossier phase now allocates 5 pts to provenance).
  - Token flow: harness mints → server env (`RL_RUN_TOKEN`) → grader — the agent never sees the token. Boundary: an agent with host-level code execution is host compromise, out of scope.
  - Verified: honest signed run → 100/100 clean; unsigned → rejected; wrong-key signature → rejected; action tamper → `PROVENANCE_FAILURE` (F4 cross-check) + `STALE_RECORD`; reward tamper → `STALE_RECORD` with the chain intact. One real bug found and fixed by the F4 cross-check: trace `stepIndex` reset per episode and no longer mapped 1:1 onto the accumulated trajectory.

- ✅ **H2 — Deployment-time randomization (F2).**
  - Hidden parameters: spec state fields may declare `visibility: "hidden"` — they participate in transitions, rewards, and replay but are stripped from `getState()` and every agent-facing `state` projection; snapshots retain the full state so restore stays exact. Verified end-to-end (hidden field drives dynamics/reward, invisible to the agent, survives snapshot/restore).
  - Deployment seed policy (docs + grader): dossiers declare their own seeds and the grader replays with whatever the run used — deployment must randomize seeds per session; pre-recorded trajectories fail replay verification.

- ✅ **H3 — Hardened scenario variant (F3).**
  - `domain-packs/harmon-creek-hard/spec.json`: same domain, same tools — but admits succeed 70%, supplies deplete continuously, incidents cost −2 each, and a **hidden budget cycle** (~67-step period) silently toggles an incident storm. The value of any visible-state policy is non-stationary by construction.
  - Defective starter (`benchmark/scenario/spec-hard-starter.json`) layers three defect classes: 3 compiler-level unknown targets, 3 runtime-only defects (string into an integer field, set above schema max, constraint-violating add), and a **decoy rule** whose naive fix (weakening `ward_capacity`) is flagged `SKIPPED_COMPLIANCE` — the correct fix is to disable the rule.
  - **Difficulty certificate (measured, not asserted):** `difficulty-certificate.json` — the Phase F validation curve on the hardened pack is non-stationary across the standard budget (swings ≈ −1330 to +86, never plateauing; the standard pack plateaus flat at 856.0 from ep 24). A visible-state agent cannot model the hidden regime — the declared spec is not the whole environment.
  - The hardened pack passes the full pack pipeline (compile → validate → smoke → determinism gate → properties → grade 100/100). No grader fork.

- ✅ **H4 — Cross-platform CI + enforcement guardrails (F5).**
  - CI matrix over `windows-latest` + `ubuntu-latest` (ubuntu restores the vendored toolchain via the vendor lockfile); all steps shell-agnostic. Pack pipeline gate now covers the hardened variant.
  - Negative gate extended with H1/H2 probes (all inject-and-assert): unsigned trace, wrong-key signature, action tamper (F4), reward tamper (replay), hidden-parameter stripping.
  - Rule 4B: **no `core/` changes required** — hidden-parameter stripping needed only the environment layer (`environment/environment.ts`); ledger unchanged (GAP-1/2/3/4), **CORE INTEGRITY VERIFIED**.

**Done when (phase exit):** every audit finding is dispositioned ✅ · the grader rejects unsigned/cross-modified dossiers with `PROVENANCE_FAILURE` (CI-proven via the negative gate + tamper-drill job) ✅ · deployment-seed policy documented and exercised end-to-end ✅ · hardened variant passes the full pipeline with a documented non-stationary learning curve ✅ · Phase A–G regression entirely green (smoke, determinism gate, fixtures 9/9, packs 4×100/100, roundtrip, cross-process 120/120, golden loop, demo, `tsc --strict`, core integrity, quickstart, dist) ✅. **The procurement verdict moves from "FIT WITH CONDITIONS" to FIT.**
---


---

## 3i. Phase I — Red-team remediation (post-audit engagement)

A caged STDIO-MCP red team engagement (`RedTeamTest/REDTEAM_REPORT.md`, 26 probes + weak-spec tamper across 4 compliance packs) produced one confirmed bypass, one engine defect, and grader blind spots. Remediation:

- ✅ **I1 — GAP-5 (core, Rule 4B): declarative effect values rejected by the set pre-flight (report R2).**
  - `core/transitions.ts`: the `state_compatibility` layer validated `effect.value` before resolving `{$field}/{$mul}/…` descriptors, so every `set` with a declarative reference failed ("set rejected: filing_day: expected integer") — `legal-filing`'s `file_motion` could never fire and the deadline was untestable.
  - Fix: resolve the descriptor and validate the RESOLVED value; when the descriptor references fields mutated earlier in the same transition batch (runtime value not yet predictable), type check defers to the post-apply constraint/result layers (still atomic). Unresolvable references remain no-ops.
  - Rule 4B followed: pre-fix hash recorded, **GAP-5** ledger entry added, manifest re-pinned. `CORE INTEGRITY VERIFIED` (GAP-1..5).

- ✅ **I2 — hospital-billing v1.1.0: HB-9 double-billing loop closed (report R1, the confirmed bypass).**
  - Root cause: `generate_invoice_rule` lacked `invoice_status=="none"`; one dispense re-armed invoice→collect indefinitely (3 payments, +3000, grader 100/100 blind).
  - Remediation: set-once semantics (`in ["none","paid"]` — a paid invoice may close, a generated one may not be re-armed), collect **consumes** the dispense (`med_status=consumed`; re-billing requires a fresh prescribe→dispense cycle), cooldowns, and a cross-field `payment_debt = payments − invoices` field clamped to 0 by the `payment_invoice_parity` constraint (double-billing attempts reject atomically at constraint_validation). Legal 3-cycle path verified to terminate at 3 payments; HB-9 replay is a dead no-op.

- ✅ **I3 — legal-filing v1.1.0: deadline made substantive + evidence farming closed (report R3).**
  - Evidence accrual (`audit_case`/`extend_deadline`) now requires `discovery_status=="open"` — pre-open farming adds 0 evidence.
  - Filing window 5–30 enforced three ways: rule conditions (day gte 5 / lte 30), plus a violation-flag pattern (`filing_violation` set by a priority-12 window rule, range-clamped to 0 by the `filing_window` constraint) so out-of-window filings are **visible rejections** at constraint_validation, not silent no-ops (report R4).

- ✅ **I4 — Grader: named-rule compliance integrity (report R5 / weak-spec tamper).**
  - Reference resolution is per-domain (scans `domain-packs/*` for the matching `environment.id` — pack dirs may differ from ids).
  - New rule-condition integrity: a dossier rule may not be deleted, disabled, or lose a compliance precondition relative to its domain reference; "in"-set coverage and stricter bounds count as compliance, narrower-only relaxations flag **`SKIPPED_COMPLIANCE` naming the rule** — the report's exact tamper (deleting `claim_status=="approved"` from `payout_rule`) now grades 68/partial with `rule "payout_rule" precondition(s) removed: claim_status eq "approved"` (was: 98/pass, undetected).
  - Condition matcher is narrowness-aware (min/max direction) so legit hardening variants still pass; frozen fixtures remain 9/9 exact.

**Done when (phase exit):** HB-9 replay dead on v1.1.0 ✅ · legal deadline hard-rejects at both bounds with farming closed ✅ · weak-tamper flagged by rule name ✅ · full regression green (packs 8×100/100, fixtures 9/9, smoke, negative gate, golden loop, core integrity incl. GAP-5, tsc strict) ✅.

---

---

## 3j. Phase J — Red-team run-02 verification & grader-noise elimination

Independent verification re-run (`RedTeamTest/REDTEAM_REPORT_RUN2.md`, seeds 77/111/303/313): **0/26 bypass probes succeeded** — every Phase I fix held (HB-9 dead, farming closed, weak-tamper flagged `SKIPPED_COMPLIANCE` naming `payout_rule`). Triage of the run's residual findings:

- ✅ **J0 — R2 "PERSISTS" verdict corrected: harness artifact, engine is fixed.** The runner's LF-5/LF-7 control sequences are copied from run-01 and execute `file_motion` at **day 4** (4 heartbeat ticks, no pad) — outside the [5,30] window, so the `filing_window` rejection is correct policy, not the old defect. With one padding step the control commits exactly per the report's own acceptance test: `filing_day=5, motions_filed=1`; LF-7 terminates at 3 motions. Future runs must enter the window (pad ≥1 step before filing).
- ✅ **J1 — server: abandoned segments are now recorded.** `env_reset` pushes every non-empty segment (not just terminal ones) into `manifest.episodes`. Previously an abandoned mid-run reset left its steps in the trajectory but out of the manifest → every replay slice misaligned → false `STALE_RECORD` (run-04/06 noise).
- ✅ **J2 — grader: capability scan is segment-aware.** `CAPABILITY_VIOLATION` now requires ≥3 identical rejected steps inside a LIVE episode segment (manifest-tiled; scan bounded by the segment's first terminal step). Post-terminal padding (frozen state, reward 0) is expected harness behavior and no longer flags clean sessions. The `broken-capability-violation` fixture was rebuilt to encode the genuine pattern: 3 stuck illegal steps mid-episode-B, before its truncation, replay-consistent (frozen observation/state byte-matched).
- ✅ **J3 — grader: F4 argsHash cross-check is epoch-scoped.** Only trace entries after the LAST `env_use_spec` are cross-checked against the trajectory — re-binding discards the recorder, so earlier-epoch entries have no trajectory counterpart (run-06's false `PROVENANCE_FAILURE` 2/141 on HR seed-scans). Single-binding runs (golden, packs) are unaffected.
- ✅ **J4 — server (R6): bind-time compliance notice.** `env_use_spec` reports `complianceNotice` listing rule-integrity divergences vs the domain reference (deleted/disabled rules, removed preconditions) at BIND time — informational, never blocking (repairing the defective starter requires binding modified specs). The grader stays authoritative; tampered binds are now visible in the trace itself.

**Done when (phase exit):** run-02 verification dispositioned (0/26; R2 corrected as harness artifact) ✅ · tampered bind returns a named compliance notice at bind time ✅ · abandoned-reset session replays clean (segments tile the trajectory) ✅ · argsCrossCheck 0 mismatches after rebinds ✅ · fixtures 9/9 exact with the rebuilt capability pattern ✅ · full regression green (packs 8×100/100, smoke, golden loop, negative gate, core integrity, tsc strict) ✅.

---
## 4. Dependencies between phases

```
A (kernel hardening) ──► B (MCP surface) ──► C (buyer-ready benchmark)
        │                                             ▲
        └──────────► D (more domain packs) ───────────┘
        │
        └──────────► E (persistence) ──► F (training layer)
                          │
                          └──────────► G (release posture, continuous)
```

- **A unblocks everything** — the error taxonomy and determinism gate are prerequisites for B, D, and F.
- **B unblocks C** — the grader needs a real runtime trace to score honestly.
- **D can run in parallel** after A; it feeds C (more golden scenarios) and stress-tests A.
- **E before F** — training wants checkpointing and persisted trajectories.
- **G is continuous** — adopt pieces as phases land rather than treating it as a final gate.

---

## 5. Risks & standing mitigations

- **Scope creep in the kernel** — every feature request first answers: "can this be a spec field or a plugin?" If yes, it never touches `core/`.
- **Reward-design blindness** — Phase F's learning demo doubles as a reward sanity check; if a policy can't learn a pack, the pack's rewards are suspect.
- **Legacy entanglement** — the story engine stays frozen in `engine-core/` as reference; no new work targets `ccm/`.
- **Benchmark gaming** — anti-bluff checks evolve with the trace format; golden broken-fixtures (Phase C) keep the grader honest against shortcut strategies.
- **Windows path/import quirks** — the mirror lesson: `rl-engine/` is the single source; parents mirror *from* it, never the reverse.
- **Resourced-agent gaming (audit F1)** — replay verification proves world-consistency, not protocol adherence; H1's signed trace chain makes provenance tamper-evident.
- **Precomputable optimum (audit F2)** — deterministic + visible specs allow offline planning; H2's deployment seeds and optional hidden parameters keep evaluation honest.
- **Procedural difficulty ceiling (audit F3)** — difficulty must be demonstrated, not assumed; H3 requires a measured non-saturating learning curve as the certificate.

---

## 6. Non-goals (what we will not claim)

- No full PPO/DQN/SAC implementations — Phase F delivers one inspectable reference trainer behind interfaces.
- No per-simulation world branching beyond snapshot/replay (E) — true forking stays out of scope.
- No embedding-based pressure or NLI gating in the kernel — the LLM stays optional and never bypasses validation (§39).
- No real-world data in any pack — everything synthetic, pseudonymised, and licensed (MIT engine, CC-BY-4.0 scenario data).
