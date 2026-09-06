# CCM/CCE Implementation Report — Story Vault

## 1. Executive Summary

Story Vault was refactored from a "manuscript manager with an AI assistant" into a **CCE-driven story-generation workspace**. The old data model (flat `characters` and `world_building_notes` tables) was replaced with the project-scoped CCM world model: actors with attributes/state/goals/drives/beliefs, environments, systems, rules, relationships, and narrative constraints. A deterministic symbolic engine (CCE) runs the simulation loop — pressure → candidate events → validation → selection → mutation → persistence — and a story extractor turns events into episodes and scene skeletons. The LLM was integrated in two modes: **observer** (read-only + prose rendering, default) and **baked-in** (engine-validated structured proposals), with a CPU-only advisory semantic layer (NLI contradiction flag) that never gates the symbolic verdict. The entire refactor spans 3 phases + stabilization passes (0007 migration, byte-accurate storage quota, dead-code + local-first polish, minor fixes), and is verified with `tsc --noEmit` (0 errors), migration + quota smoke suites, and a determinism smoke test.

Territory note (done vs deferred): the engine is **project-scoped world, simulation-scoped events** (§7.1), the MCP + agent now cover the full world model plus simulations + tiered CCM guidance, and the Simulation + agent workflows are end-to-end. **Now also done:** a staged narrative-constraint planner (destination steering + auto-satisfaction + deadlines), relationship rule scope, micro/macro event-budget split, rejection surfacing (L1–L7 audit closure), **and CCE v1.1 multi-agent causal interaction** (observation → knowledge transfer, DecisionOpportunity, transitionOnly repeat control, interaction boost, plan/belief pressure, requiresPressure enforcement, Actor→Actor causal edges). **Not yet**: per-simulation world snapshots/branching, a standalone admin service, and a production hardening pass.

---

## 2. What CCM and CCE Are

The user's document `CCM.md` defines two distinct concepts:

- **CCM (Causal Continuity Model)** — The theoretical framework (v1.0). A set of principles and entity definitions: the symbolic engine owns all canon (state, rules, events, causality, chronology, constraints), the LLM only reads or proposes through validation. Key separations: attributes vs state, causal load vs narrative weight, possibility vs desirability, world truth vs character knowledge. 61 sections, ending in the Master Law (§59): *Every meaningful event must emerge from existing state and governing Systems … causal scrutiny proportional to Causal Load.*
- **CCE (Causal Continuity Engine)** — The implementation of CCM. The actual executable engine that runs the pressure → generation → validation → mutation → extraction pipeline. The engine is pure (no DB access in the step loop), deterministic (seeded mulberry32 PRNG), and produces events, episodes, and scene skeletons that the LLM later renders into prose. Its directory is `server/ccm/`; the LLM sits on top of it (Mode 2) or inside the loop via validated proposals (Mode 1).

The two LLM modes (per-project `project_settings.agent_mode`, default `observer`):
- **Mode 2 (observer, default)**: The LLM is layered **on top of** the engine. It reads everything but cannot write canon. Prose is staged (`propose_draft`/`render_skeleton`) — user accepts before anything is saved. Semantic tools are advisory-only.
- **Mode 1 (baked-in)**: The LLM is **inside the loop**. It gains direct management tools + `propose_*` tools whose structured state changes pass through the engine's 6-layer validation engine before being applied; advisory NLI flags ride alongside the verdict but never flip it. The symbolic firewall still holds.

---

## 3. Architecture Overview

```
                    ┌──────────────────────┐
                    │   PROJECT (Story Spec)│
                    │ premise / themes /    │
                    │ targets / forbidden   │
                    └──────────┬───────────┘
                               │
                    ┌──────────▼───────────┐
                    │   WORLD MODEL        │  ← project-scoped tables
                    │ Actors / Environments│
                    │ Systems / Rules      │
                    │ Relationships /      │
                    │ Narrative Constraints│
                    └──────────┬───────────┘
                               │
                    ┌──────────▼───────────┐
                    │   SIMULATION (run)   │  ← simulation-scoped tables
                    │ seeds / settings /   │
                    │ clock / status       │
                    └──────────┬───────────┘
                               │
              ┌────────────────▼────────────────┐
              │         CCE ENGINE (pure)        │
              │  loadWorld → step(tick) → events │
              │  → causality (deferred load) →   │
              │  extractStory → persistRun       │
              │  (CPU-only advisory NLI sits     │
              │   OUTSIDE the step loop)         │
              └────────────────┬────────────────┘
                               │
                    ┌──────────▼───────────┐
                    │   EVENT HISTORY      │
                    │ events / causal graph│
                    │ event queue          │
                    └──────────┬───────────┘
                               │
                    ┌──────────▼───────────┐
                    │   STORY EXTRACTOR    │
                    │ episodes / skeletons │
                    └──────────┬───────────┘
                               │
                    ┌──────────▼───────────┐
                    │   LLM RENDERER       │  ← Mode 2 (observer)
                    │ skeleton → prose     │
                    │ → staged proposal    │
                    └──────────┬───────────┘
                               │
                    ┌──────────▼───────────┐
                    │   MANUSCRIPT         │  ← prose spine (unchanged)
                    │ scenes / versions /  │
                    │ main story           │
                    └──────────────────────┘
                              ↕
              ┌────────────────────────────┐
              │   LLM (two modes)          │
              │ observer = read+render     │
              │ baked_in = read+propose_*  │
              │ (+ advisory semantics:      │
              │  check_contradiction /      │
              │  suggest_tags — both modes) │
              └────────────────────────────┘
```

Tiered CCM retrieval and the advisory semantic layer are out-of-band reads that never gate, block, or alter any engine decision (see §7.7–7.8).

---

## 4. Phase A — Data Model & Modularization

### 4.1 Schema Changes

The old `characters` table was REMOVED. Its data now lives in `ccm_actors`:

| Old `characters` | New `ccm_actors` |
|---|---|
| `name` | `name` |
| `description` | `description` (column) |
| `notes` | `notes` (column) |
| `age` | `attributes.age` (JSON) |
| `abilities` | `attributes.abilities` (JSON) |
| `customAttributes` | `attributes.custom` (JSON) |
| `relationships` | (now a separate `ccm_relationships` table) |
| `sizeBytes` | (computed from JSON sizes; `recomputeUsage` sums `LENGTH(CAST(… AS BLOB))`) |

The old `world_building_notes` table was REMOVED. Its data mapped:
- `location` → `ccm_environments`
- `magic_system` / `faction` → `ccm_systems`
- `lore` / `other` → `project_memory` (as `fact` / `hypothesis`)

All world-model tables are **project-scoped** (have `projectId` FK). Simulation-scoped tables (events, episodes, skeletons, snapshots) have `simulationId` FK. Secondary indexes live inside the `sqliteTable(…, (table) => ({ … }))` callbacks (e.g. `projects_title_idx`, `scenes_projectId_idx`, `scene_versions_sceneId_idx`, `project_settings_projectId_idx`, etc.); the `_journal.json` entry for `0007_missing_indexes` is the catch-up for the ten indexes that were declared in those callbacks but never generated (`ccm_rules.scope` was already plain `text("scope")`, not `mode:"json"`, since 0006).

### 4.2 Migration Strategy

**Two-part migration:**
- **SQL migrations `0006` + `0007`** (hand-written, `drizzle/0006_ccm_core_refactor.sql` + `drizzle/0007_missing_indexes.sql`): `0006` is `ALTER TABLE projects ADD COLUMN spec`, `CREATE TABLE` all 13 ccm_* tables (does NOT drop `characters`/`world_building_notes` — data must be copied first). `0007` is 10 `CREATE INDEX` statements. `0006_snapshot.json` is pruned when the diff is intentionally from scratch. The journal entries were added manually.
- **Runtime migration** (`server/modules/migration/legacy.ts`): Called at vault unlock (both `setupVault` and `unlockVault`). Checks if legacy tables exist, copies data with field folding, rewrites entity-reference HTML spans (`data-entity-type="character"` → `"actor"`, `"lore"` → `"environment"`/`"system"` by category), then `DROP TABLE` the legacy tables. Idempotent — second run is a no-op. After 0007 it also ensures the per-table-callback indexes exist (the migration itself is `CREATE INDEX IF NOT EXISTS`-safe).

**Why hand-written SQL?** Drizzle-kit's interactive rename-detection prompts can't be answered non-interactively (no `--yes` flag), and `printf '\n' | drizzle-kit generate` doesn't reach the raw-tty prompt. The migration was written by hand following the existing format (`--> statement-breakpoint` separators). The journal entry was added manually.

### 4.3 Modular Architecture

```
server/
  _core/              infra (bootstrap, trpc, context, localAuth incl. atomic PIN change, mcpServer incl. per-session fresh Server, agentSse, env incl. packaged-safe paths, monitoring, systemRouter)
  db.ts               slimmed to: SQLCipher connection (WAL + busy_timeout), migrate(), facade re-exports (projects/scenes/actors/world/simulation)
  entities.ts         EntityReference serialization (serializeEntitiesForAgent, entitySpansToMarkdown, cleanupDanglingSpans)
  modules/
    projects/         project.router.ts + project.data.ts (project CRUD, settings, stats, spec)
    scenes/           scene/version/mainStory routers + scenes.data.ts (prose spine, sizeBytes, delta quota on update, recompute on delete)
    actors/           actor.router.ts + actor.data.ts (actor CRUD with actorSizeBytes + delta on update, cleanupDanglingSpans on delete)
    world/            world.router.ts + world.data.ts (environments/systems/rules/relationships/constraints; all deletes recalibrate)
    ideas/            ideas router — idea size tracked (title+content), delta on update, idea.delete recalibrates
    simulation/       simulation.router.ts + simulation.data.ts + run.service.ts + skeletonRenderer.ts
    migration/        legacy.ts (runtime legacy migration) + __smoke__.ts (21/21 migration checks)
  ccm/                THE ENGINE (pure, deterministic; semantics & guidance are read-only satellites)
  agent/              loop, tools (two-mode), settings, provider, compression (compressedContext inheritance), sessions, ideation (pins→brief), systemPrompt (title-escaped, sandboxed memory)
  mcp/                mcp.ts (78 tools incl. CRUD + propose_* + engine/sim + validate_rule_target, re-pointed to world model + mode-aware + storage recalibration)
  routers.ts          composition root only (auth, system, userSettings, beta, feedback, communication, email, adminUser, storage, project(s), scene/version/mainStory, actor, environment, worldSystem, rule, relationship, constraint, simulation, search, versionComparison, export, admin, writing, agent, ideas)
  api.ts              REST router under /api/rest (incl. SVP import/export + search mirror)
  svp.ts              SVP v2 (encrypted, compressed; v1 import path preserved)
  services/           storageService (byte-accurate recomputeUsage, enforceQuota, LIFO-style), activityTracker, auditService, betaService, emailService, monitoringLogger (packaged-safe logDir), staticServer (packaged-safe)
```

Every domain module = router + data + DTOs in one folder; `server/db.ts` is infrastructure + facade; `server/routers.ts` merges them.

### 4.4 Router Naming

World-model routers are mounted at:
- `actor` — actor CRUD (`list/get/create/update/delete`; create + update compute `actorSizeBytes` and delta-check)
- `environment` — environment CRUD
- `worldSystem` — system CRUD (NOT `system` — collides with the health `systemRouter`)
- `rule` — rule CRUD (DSL: `when`/`candidateEvents`/`effects`/`priority`/`probability`/`cooldown`/`scope`/`enabled`)
- `relationship` — relationship CRUD (qualitative: trust/familiarity/affection/…)
- `constraint` — narrative constraint CRUD (hard/soft/forbidden/range/temporal; `update` exposes `satisfied`/`satisfiedAt`, which the engine planner sets automatically)
- `simulation` — simulation runs, events, episodes, skeletons, snapshots, `renderSkeleton`

### 4.5 SVP v2

The `.svp` export format was bumped to version 2. The `SvpSnapshot` now carries `actors`, `environments`, `systems`, `rules`, `relationships`, `narrativeConstraints`, `projectMemory`, `episodes`, `sceneSkeletons` (plus scenes/versions/mainStory/project spec) instead of `characters`/`worldNotes`. Old v1 `.svp` files remain importable — `decryptSvp` detects version 1 and normalizes it via `normalizeV1()` (maps characters → actors, world notes → environments/systems/memory best-effort, with a `world_building_notes.category` → CCM mapping). Encryption is still AES-256-GCM (`SVP\x01` header, 16-byte IV, SHA-256-derived key from `SVP_SECRET`, `fflate` deflate of the JSON).

---

## 5. Phase B — Engine Integration

### 5.1 Engine Core (`server/ccm/`)

The engine is a pure TypeScript module with no DB access in the step loop (and the NLI model is never imported by the simulator):

| File | Purpose |
|---|---|
| `types.ts` | Domain types: Actor, Environment, SystemDef, RuleDef, Relationship, NarrativeConstraint, EngineEvent, World, RunResult, Episode, SceneSkeleton, plus the Rule DSL (Condition, StateChange, CandidateEventDef). `CcmSimulationSettings` = `{ tickMinutes, maxEventsPerRun, granularity }`. |
| `rng.ts` | Seeded PRNG (mulberry32) + hashSeed + roll + pick. ALL randomness flows through this |
| `time.ts` | World clock {day, minute}, clockToMinutes, addMinutes, formatClock |
| `state.ts` | Dotted-path get/set, evaluateCondition (with array-in-array `in` semantics), applyStateChange, buildActorRecord |
| `rules.ts` | Rule matching, candidate generation, entity record building, stateChange resolution (`resolveStateChangeTarget`). Relationship record + scope (L6). `actorRecord` exposes plans/beliefs; `ruleMatches` enforces `requiresPressure` (v1.1). |
| `pressure.ts` | Keyword-based pressure multiplier: goals/drives/habits/plans positive, constraints negative. **Constraint-pressure bias** (L1), **relationship pressure** (L6), and **interaction boost** (v1.1 §24) factored in. |
| `constraints.ts` | **Staged narrative-constraint planner (L1):** `isConstraintSatisfied` (evaluates target conditions against live world state), `checkConstraintSatisfaction` (per-tick, marks `satisfied` + `satisfiedAt`), `constraintPressure` (deadline-aware bias multiplier). |
| `observation.ts` | **Observation & information transfer (v1.1 §13):** `applyObservation` writes observed/public event knowledge into observers' `knowledge` + `beliefs.known` — the social-causality link that turns `visibility` into actor knowledge. |
| `causality.ts` | Causal parent linking (overlapping participants/location/fields + **observed-event knowledge keys**, v1.1), **deferred causal load** (later events escalate parents' load) |
| `validation.ts` | **6-layer** validation: non-contradiction → system legality → actor legality → knowledge legality → state compatibility → consequence validity; `ValidationResult` carries `ok`/`layer`/`reason` + advisory `advisoryFlags` (async, never gating) + `guidance` (hand-mapped Tier-3 section per layer) |
| `causality.ts` | Causal parent linking (overlapping participants/location/fields), **deferred causal load** (later events escalate parents' load) |
| `semantics.ts` | CPU-only NLI/zero-shot helper: lazy singleton ONNX pipelines (`Xenova/nli-deberta-v3-small` q8), `suggestTags(text, vocabulary)` + `checkContradiction(textA, textB)`. PURE/READ-ONLY — no DB, no RNG. Must never be imported by `simulator.ts`. |
| `guidance.ts` | Token-budgeted retrieval over the static `ccm-index.json`: `getSectionById` (Tier 1, O(1)) + `searchSections({ query topK tokenBudget })` (cosine on the MiniLM bi-encoder). Runtime probes `process.resourcesPath/server/ccm/ccm-index.json` first (packaged), then `import.meta.url` (dev). |
| `embeddings.ts` | Bi-encoder for the `build:ccm-index` script only (`Xenova/all-MiniLM-L6-v2`, mean-pooled, normalized) — separate from `semantics.ts`'s cross-encoder. |
| `simulator.ts` | `runSimulation(world, ticks)`: advance clock → drain queue → evaluate rules → apply pressure → roll candidates → **validate** → mutate → record → repeat. Generates events with temp negative ids, tracks field changes for causality |
| `extractor.ts` | `extractStory(world, newEvents, startActorStates)`: cluster events into episodes (gap > 6h or disjoint participants + location), build scene skeletons (entry/exit state, beats, turning point, unresolved threads, continuity notes) |
| `loader.ts` | `loadWorld(projectId, simulationId)`: hydrate World from project-scoped tables + simulation config |
| `persister.ts` | `persistRun(world, run, extraction)`: ONE transaction — new events (remap temp → real ids), causal edges, actor/environment/relationship state updates, queue status, episodes, skeletons, clock, constraint satisfaction |
| `cta` | `server/ccm/ccm-index.json` — committed build artifact, NOT regenerated at boot (only via `pnpm build:ccm-index`) |

### 5.2 The Step Loop (deterministic)

```
For each tick:
  1. Advance clock by tickMinutes (CcmClock)
  2. Drain event queue (scheduled items → events)
  3. For each enabled rule:
     For each entity in scope (actor/environment/system/relationship):
       Check rule.when.conditions (evaluateCondition — dotted paths into attributes/state/drives/habits/plans/…)
       Check rule.when.requiresPressure (v1.1: enforced — keyword must appear in drives/goals/habits/plans)
       Compute pressure multiplier (goals/drives/habits/plans boost, constraints reduce)
       Multiply by constraint-pressure bias for unsatisfied destinations (+0.25 each, +0.5 if deadline past)
       Multiply by interaction boost (×1.15 for cross-actor candidates, v1.1 §24)
       Generate candidate events with probability = candidate.prob * rule.probability * pressure
     Build per-actor DecisionOpportunity with available actions, pressures, constraints, relationships (v1.1 §6)
  4. Sort candidates by priority desc, probability desc, id asc
  5. For each candidate:
     Roll RNG (mulberry32, seeded from worldSeed + simulationSeed + clock)
     If selected: skip transitionOnly candidates whose all state changes would be no-ops (v1.1 §23)
     If selected: validate (6 layers: non-contradiction … consequence validity)
     If valid: apply state changes, create event (temp negative id; category derived from entityKind/targets, stored in trigger JSON), link causal parents (incl. knowledge-key observed events, v1.1), emit
     If invalid: reject++ (with layer+reason+rule+entity, last 20 kept in summary)
  6. Apply observation → knowledge transfer (v1.1 §13): actors at the event's location
     (or all actors for public events) gain the event type + summary into knowledge + beliefs.known
  7. Check narrative-constraint satisfaction (mark satisfied constraints + satisfiedAt)
  8. Cap: max 4 significant events per tick; micro-events (narrativeWeight "low") don't
     consume maxEventsPerRun; hard cap = maxEventsPerRun × 5 (runaway guard)
```

The simulator never imports `semantics.ts` — advisory contradiction detection happens only in `engineProposals` / `ValidationResult.advisoryFlags`, one `await` after the symbolic verdict. Determinism is therefore provable: same `worldSeed` + `simulationSeed` + world tables → bit-identical event stream.

### 5.3 The Kaden Scenario (smoke test)

The smoke test (`server/ccm/__smoke__.ts`) builds the world from CCM.md:

- **Kaden**: actor with `cardiac_disease`, habit `morning running`, constraint `doctor prohibits hill`, drive `autonomy`
- **Girl**: second actor with `cardiac_disease`, drive `curiosity`
- **Environments**: Home, Hill, Hospital
- **Rules**: `MorningRun` (habit + autonomy pressure → location Hill, exertion 5), `CardiacExertion` (cardiac_disease + exertion ≥ 3 → chest discomfort or collapse), `HospitalVisit` (physical_condition critical → hospital)

Result: 15 events generated on first run (chest discomfort → collapse → hospital), 1 episode + 1 skeleton extracted. **Determinism**: same seed + same world (actor state restored between runs via `UPDATE ccm_actors SET state = ?`) → **identical event sequences** (21/21 events match). Different seed → different valid run.

### 5.4 Simulation Router & Client

The simulation router exposes:
- `simulation.list/get/create/update/delete` — simulation CRUD (each creates `ccm_simulations` rows project-scoped)
- `simulation.advance` — run N ticks (returns event count, episode/skeleton count, final clock)
- `simulation.reset` — clear generated history (events, queue, episodes, skeletons, snapshots)
- `simulation.snapshot / snapshots / restoreSnapshot` — checkpoint/restore
- `simulation.events / event / ancestry` — event timeline + causal why-did-this-happen (`ccm_event_causes` walk)
- `simulation.episodes / skeletons / skeleton / deleteSkeleton` — narrative output
- `simulation.renderSkeleton` — skeleton → LLM prose → staged `agent_proposals` row (Mode-2: prose is always staged; nothing writes canon directly)

The client Simulation tab (`SimulationWorkspace.tsx`) is a full-width tab with three panels: event timeline (grouped by episodes, with causal ancestry drawer), world state (actor attributes/state/drives), and scene skeletons (with "Render with AI" button → the skeleton is rendered by `skeletonRenderer.ts` into a proposal the Agent tab can accept).

---

## 6. Phase C — Two LLM Modes (+ Advisory Semantics)

### 6.1 Agent Mode Setting

Per-project setting stored in `project_settings` under key `agent_mode`, default `observer`. Accessed via:
- `agent.mode.get({ projectId }) → { mode: "observer" | "baked_in" }`
- `agent.mode.set({ projectId, mode }) → { mode }`

Client shows `AgentModeBadge` (observer 🔒 vs baked-in ⚙️) with a toggle.

### 6.2 Observer Mode (default)

The LLM is **layered on top of the engine**. Tools available:

- **Read tools** (14): `list_scenes`, `read_scene`, `get_actor_info`, `list_actors`, `list_environments`, `read_environment`, `list_systems`, `read_system`, `list_ideas`, `get_main_story`, `list_scene_versions`, `read_scene_version`, `search_memory`, `get_ccm_guidance` (read-only CCM retrieval, Tier 1/2).
- **Staged prose** (user-approved): `propose_draft`, `propose_precise_edit`, `render_skeleton` (all create `agent_proposals` that the user accepts/rejects — nothing touches canon).
- **Collaboration**: `delegate_task` (fresh-context sub-agent → compressed summary), `suggest_research_thread`.
- **Advisory semantics** (read-only, never gating): `check_semantic_consistency({ textA, textB })` (NLI contradiction/entailment/neutral) + `suggest_tags({ text, vocabulary })` (zero-shot) — both CPU-only, both available in observer.

**NO write tools** — no `create_actor`, no `add_to_memory`, no `create_scene`, no `update_project`. The engine canon is untouchable. Research mode is even narrower (read-only subset); ideation mode has **no tools at all**.

### 6.3 Baked-in Mode

Observer mode tools + **direct management tools** + **propose_* tools** + MCP write parity:

| Tool | Description | Validation |
|---|---|---|
| `list_actors` / `create_actor` / `update_actor` / `delete_actor` | Direct actor CRUD (data layer is `actor.data.ts`; create uses `actorSizeBytes` + `enforceQuota`, update deltas, delete recalibrates). | none (structural) |
| `list_environments` / `read_environment` / `create_environment` / `update_environment` / `delete_environment` (+ same for `list_systems` …) | Direct world-model management (`world.data.ts`). | none |
| `list_ideas` / `create_idea` / `update_idea` / `delete_idea`, `create_scene`/`update_scene`/`delete_scene`, `get_main_story`/`add_scene_to_main_story`/…/`update_project`, `add_to_memory`/`search_memory`/… | Direct structural writes (idea size tracked, etc.). | none (structural) |
| `propose_actor_change` | Structured state changes to actor (dotted paths into `attributes.*`, `state.*`, `goals.*`, `drives`, `beliefs`, `knowledge`, `capabilities`, `constraints`, `resources`, `habits`, `plans`; optional `requiresKnowledge`/`requiresCapability`). | **6-layer** engine validation + advisory NLI |
| `propose_environment_change` | State changes to environment (state, resources, activeProcesses, inhabitants, constraints, accessibility). | **6-layer** |
| `propose_system_change` | State changes to system (rules, constraints, activeConditions, effects, exceptions). | **6-layer** |
| `propose_relationship_change` | Create or update a qualitative relationship between two actors (trust/familiarity/affection/resentment/dependence/…; `expectations`/`history`). Qualitative vocabulary is validated. | **6-layer** (text-only fields skip `in` coercion) |

All `propose_*` handlers live in `server/agent/engineProposals.ts`; the MCP server exposes the same tools, and both call the same `enforceQuota`/`recomputeUsage` and `cleanupDanglingSpans` paths.

### 6.4 Validation Flow (+ Advisory)

```
LLM proposes → engineProposals.proposeActorChange(projectId, simId, actorId, summary, stateChanges, {requiresKnowledge,…})
  → loadWorld(projectId, simulationId)            // hydrate World from DB (project-scoped world + sim config)
  → candidateFromChanges(entityKind, name, …)      // synthetic EvaluatedCandidate shaped for validateCandidate
  → validateCandidate(world, candidate)            // 6 layers; returns { ok, layer?, reason?, advisoryFlags?, guidance? }
  → attachSemanticAdvisory(result)                 // async, lazy-imports semantics.ts — advisory only, never called by simulator.ts
  → [if !ok] return { accepted:false, rejectedLayer, reason, guidance (Tier-3 slice), advisoryFlags }
  → [if ok]  for each StateChange: resolveStateChangeTarget(world, target, entityName); applyStateChange(resolved.obj, field, value)
  → persist via updateActor/updateEnvironment/updateSystem/createOrUpdateRelationship
  → return { accepted:true, applied, advisoryFlags?, guidance? }
```

The synthetic `EvaluatedCandidate` carries `{ rule:{id:0,name:"llm_proposal",family:"actor",…}, candidate:{level:"event",narrativeWeight:"medium",…}, entityKind, entityName, pressure:1, probability:1, parents:[] }` so the existing `validateCandidate` doesn't need a fork. `attachSemanticAdvisory` is called **after** the symbolic verdict and only adds `advisoryFlags: { type:"semantic_contradiction", score, textA, textB }[]`.

### 6.5 Client Mode Indicator

`AgentModeBadge` component in `AgentWorkspace.tsx` shows a toggle button: "Observer" (read-only badge, 🔒) or "Baked-in" (engine badge, ⚙️). Clicking toggles the per-project `agent.mode.set` with a toast. The agent's `runAgent.ts` reads `agent_mode` at the start of each run and passes `agentMode` into `buildAgentTools`.

---

## 7. Key Design Decisions

### 7.1 Project-scoped World vs Simulation-scoped Events

The world model (actors, environments, systems, rules, relationships, constraints) is **project-scoped** — one canonical world per project. Simulations (engine runs) are **simulation-scoped** — events, episodes, skeletons, snapshots belong to a simulation. This means multiple simulations on the same project share the world state. The consequence: determinism testing requires restoring actor state between runs (the smoke test does this via `UPDATE ccm_actors SET state = ?`). For proper branching (Level 4), each simulation would need its own world-state copy — this is deferred.

### 7.2 Engine is Pure, Persistence is Separate

The `runSimulation()` function takes a `World` + ticks and returns a `RunResult`. It never touches the DB. The `persister.ts` writes the delta in one transaction. The `run.service.ts` orchestrates load → simulate → extract → persist. This keeps the engine testable and deterministic, and keeps `semantics.ts` provably out of the RNG path.

### 7.3 Temp Negative Event IDs

Events generated in-memory get negative IDs (-1, -2, ...). The persister writes them to the DB (getting real positive IDs) and remaps causal edge references. This avoids collisions with persisted events. `persister.ts` also remaps `causalLoad`-deferred edges.

### 7.4 Rule DSL

Rules use a JSON-based DSL:
- `when.conditions`: array of `{ field, op, value }` — dotted paths into the entity's merged record (`attributes.*`, `state.*`, `drives`, `habits`, `goals`, etc.)
- `candidateEvents`: array of `{ id, summary, level, narrativeWeight, probability, stateChanges[] }` — possibilities, not inevitabilities
- `effects`: rule-level state changes applied when any candidate fires (e.g. `cooldown` bookkeeping)
- `requiresPressure`: keyword matched against entity's drives/goals/habits (positive) and constraints (negative); `pressure.ts` clamps the multiplier to [0.1, 2.5]
- `scope`: entity kind the rule ranges over — `actor`, `environment`, `system`, `relationship` (bond states drive cross-actor events; L6), or `narrative` (handled separately)

The `in` operator handles both scalar-in-array and array-overlap (e.g., `habits in ["morning running"]` matches when the actor's habits array contains "morning running"); `evaluateCondition` branches on `Array.isArray(actual)` for that. Non-string free-text pairs are skipped for the advisory NLI step.

### 7.5 Pressure Engine

Keyword-based: pressure keywords from actor drives/goals/habits/**plans (v1.1)**/environment activeProcesses; restraint keywords from actor constraints. Each keyword matched against candidate id + summary. `pressure = 1.0 + 0.22*positives - 0.35*negatives`, clamped to [0.1, 2.5]. The Kaden scenario produces high pressure for running (drive "autonomy" + habit "morning running" match candidate "run.start goes for the morning run").

**Constraint-pressure bias (L1):** on top of the keyword multiplier, each unsatisfied hard/soft/temporal constraint aimed at the entity adds `+0.25` to a `constraintPressure` factor (×1.0 when no constraint targets the entity); a past deadline escalates to `+0.75` total. The final candidate probability is `candidate.prob * rule.probability * keywordPressure * constraintPressure`. This makes the engine drift toward destinations probabilistically — it never obeys an instruction to reach them.

**Relationship pressure (L6):** relationship-scoped candidates also gather pressure from the bond's own fields (familiarity/trust/affection/… are positive keywords; resentment/fear are restraints).

**Interaction boost (v1.1 §24):** candidates whose state changes target other actors or relationships (cross-actor interaction) get a deterministic ×1.15 probability multiplier (clamped ≤1.0). This makes shared situations slightly more likely without forcing them.

### 7.6 Deferred Causal Load

Events initially have `causalLoad: { class: "connective", magnitude: "none" }`. When a later event (narrativeWeight ≥ medium or `load_bearing`) references a parent event, the parent's load is escalated: `connective` → `load_bearing` and magnitude bumps one step (none→low→moderate→high→critical) in `causality.ts`. This is CCM spec §16/§21 — importance can emerge instead of being known at creation. The flag is stored as `causalLoad` JSON on `ccm_events`.

### 7.7 Tiered CCM Retrieval (no full-document loading)

The full **CCM.md** document is **never loaded into any single context window**. Every LLM call receives only a token-budgeted slice. The retrieval index is built once via `pnpm build:ccm-index` (`scripts/build-ccm-index.ts` embeds each section with `Xenova/all-MiniLM-L6-v2` mean-pooled, normalized into `server/ccm/ccm-index.json`) and committed. Runtime only reads that JSON; the query is embedded lazily with the same MiniLM model so vectors match.

| Tier | Delivery point | Content | Token cost | When |
|------|---------------|---------|------------|------|
| 0 | MCP `initialize` `instructions` (`CCM_CORE_LAW` verbatim, Master Law §59) + every `propose_*` description prefix (2-sentence reminder) | The Master Law | ~80–90 | Always, for free |
| 1 | `get_ccm_guidance { topic }` → `getSectionById` | 1 section by exact id (e.g. `no-retroactive-motivation`, `world-state`, `actor-agency`) — O(1) | section size (~200–700) | Caller knows what they need |
| 2 | `get_ccm_guidance { query }` → `searchSections` | Top-k sections via bi-encoder cosine similarity, greedily packed under `tokenBudget` (default 1200, `topK` 2), sliced to `remainingCharacters = tokenBudget*4` | ≤ budget | Vague/exploratory question |
| 3 | `ValidationResult.guidance` on `propose_*` rejection | 1 pre-mapped section per validation layer (`VALIDATION_GUIDANCE_SECTION_IDS`: non_contradiction→`non-contradiction-check`, system_legality→`system-rules`, actor_legality→`actor-agency`, knowledge_legality→`actor-knowledge`, state_compatibility→`world-state`, consequence_validity→`event-structure`, causal_independence→`causal-independence`) sliced to `REJECTION_GUIDANCE_MAX_CHARACTERS=1600` (~400 tokens) | ≤ 400 | Proposal rejected |

The two embedding models are deliberately separate: `all-MiniLM-L6-v2` (bi-encoder, for search — 384-d, mean-pooled) vs `nli-deberta-v3-small` (cross-encoder NLI on `{text, text_pair}` — 3-way contradiction/entailment/neutral, for `attachSemanticAdvisory`). See `server/ccm/{embeddings,semantics,guidance}.ts`. Runtime path for the index probes `process.resourcesPath` first (packaged), then `import.meta.url` (dev), so mismatched `import.meta.dirname` bundling doesn't break it.

### 7.8 Semantic Advisory Layer (CPU-only, advisory-only)

`server/ccm/semantics.ts` is a lazy singleton over `Xenova/nli-deberta-v3-small` (dtype `q8`). Two helpers, both PURE/READ-ONLY, no DB, no RNG, never imported by `simulator.ts`:
- `checkContradiction(textA, textB)` — cross-encoder NLI `{text, text_pair}` → `{ label: contradiction|entailment|neutral, score }`. The TS typedef for the text-classification pipeline only declares `string | string[]`; the call is cast to the runtime shape.
- `suggestTags(text, vocabulary)` — zero-shot classification against a vocabulary.

Exposed as **advisory-only** tools in both agent modes and MCP: `check_semantic_consistency` + `suggest_tags` (in `buildSemanticTools()`). Also injected as `ValidationResult.advisoryFlags` via `collectTextPairs` (pure) + `attachSemanticAdvisory` (async, dynamic `import("./semantics")` so the simulator stays clean) — a free-text old-vs-new contradiction hint on validated candidates, **never gating**, surfaced for UI/LLM display. The MCP `mcp/npm` bundle externalizes `@huggingface/transformers` (`--external:`) and ships it as a `dependencies` so `onnxruntime-node`'s `.node` files are available at install time.

### 7.9 Migration Caveats

- **Drizzle-kit interactive prompts**: On Windows, `drizzle-kit generate` enters interactive rename-detection mode when tables are removed and new ones added. Piping `\n` doesn't work (raw terminal input). Workaround: write the SQL migration by hand, or delete the last snapshot from `drizzle/meta/` before regenerating.
- **Raw better-sqlite3 vs Date**: Raw `Database.prepare().run()` cannot bind `Date` objects. Use `Math.floor(Date.now() / 1000)` for `mode: "timestamp"` columns.
- **JSON columns**: `getRawDb()` returns JSON text columns as raw strings. `JSON.parse()` is needed. Drizzle's `getDb()` parses them automatically via `mode: "json"`.
- **Import.meta in production**: `import.meta.dirname` resolves to `out/main/chunks/` in the `esbuild` bundle. `server/_core/env.ts:resolveMigrationsDir()` and `server/ccm/guidance.ts:loadIndex()` instead probe `process.resourcesPath` when `app.isPackaged`.
- **ccm-index not in out/**: `guidance.ts` must probe `process.resourcesPath/server/ccm/ccm-index.json` first; the old `fileURLToPath(new URL("./ccm-index.json", import.meta.url))` fails in the packaged build.
- **`@huggingface/transformers` NLI TS types**: The v4 text-classification pipeline's TS typedef doesn't declare `{text, text_pair}` — cast the callable to the runtime shape.

---

## 8. File Map

### Engine (pure)
```
server/ccm/
  types.ts, rng.ts, time.ts, state.ts
  rules.ts, pressure.ts, validation.ts, causality.ts
  constraints.ts                        (L1 staged narrative-constraint planner)
  observation.ts                        (v1.1 social-causality: observation → knowledge)
  semantics.ts, embeddings.ts, guidance.ts
  simulator.ts, extractor.ts
  loader.ts, persister.ts
  ccm-index.json, __smoke__.ts, __emergent__.ts, __multiactor__.ts, guidance.test.ts
```

### Modules
```
server/modules/
  projects/    project.data.ts
  scenes/      scenes.data.ts
  actors/      actor.data.ts (actorSizeBytes; update deltas; delete→recomputeUsage + cleanupDanglingSpans)
  world/       world.data.ts (environmentSizeBytes/systemSizeBytes; same quota + cleanup contract)
  simulation/  simulation.data.ts, run.service.ts, skeletonRenderer.ts
  migration/   legacy.ts, __smoke__.ts
```
(ideas lives in `server/routers/ideas.ts`; memory lives in `server/agent/projectMemory.ts`; narrative is folded into simulation.)

### Agent + MCP
```
server/agent/
  tools.ts         (buildBaseTools + buildManagementTools + buildEngineTools + buildSemanticTools → buildAgentTools)
  engineProposals.ts (proposeActor/Environment/System/RelationshipChange; EngineProposalResult with advisoryFlags+guidance)
  runAgent.ts      (reads agent_mode, passes to buildAgentTools; handles thinking via reasoning_content)
  settings.ts, provider.ts, systemPrompt.ts, compression.ts
  contextBudget.ts, projectMemory.ts (sandboxed), chatSessions.ts (compressedContext inheritance)
  ideation.ts, synthesize.ts
server/mcp.ts      (78 tools incl. semantic advisory + get_ccm_guidance + validate_rule_target;  instructions: CCM_CORE_LAW; all mutating tools recalibrate storage)
```

### Client
```
client/src/components/
  ActorManager.tsx          (was CharacterManager; tabs for attributes/state/goals/drives/beliefs/…)
  WorldModelManager.tsx     (was WorldBuildingManager; Environments / Systems / Rules / Relationships / Constraints)
  simulation/SimulationWorkspace.tsx (full-width: timeline+ancestry+world-state+skeletons, Render with AI)
  editor/EntityReference.ts, EntityReferenceView.tsx (hover card fixed for environment/system + dangling spans)
  agent/AgentWorkspace.tsx  (+ AgentModeBadge, thinking viewer, research split)
  ideation/IdeationChat.tsx
pages/ProjectWorkspace.tsx  (ideation/scenes/main-story/actors/world/simulation/agent/ideas + local-vault copy)
```

### Migrations
```
drizzle/0006_ccm_core_refactor.sql  (hand-written: spec + 13 ccm_* tables)
drizzle/0007_missing_indexes.sql    (hand-written: 10 in-callback indexes never generated)
drizzle/meta/_journal.json          (0000→0007; 0005_snapshot.json pruned when diff was from scratch)
```

### Packaging / MCP distribution
```
electron.vite.config.ts   (SOLE renderer build → dist/client; vite.config.ts has been REMOVED)
package.json              (build = build:server && build:electron && build:mcp; no build:client)
mcp/npm/package.json      (2.2.0; @huggingface/transformers + better-sqlite3-multiple-ciphers external)
mcp/python/pyproject.toml (2.0.3)
```

---

## 9. Verification

### Tiered CCM Guidance Retrieval

External and in-app LLMs never receive the full CCM framework document in one
context window. `pnpm build:ccm-index` embeds the numbered, operational
sections of `CCM.md` once with `Xenova/all-MiniLM-L6-v2` and commits the
resulting static index; runtime retrieval only reads that JSON and embeds a
free-text query when semantic search is requested. Advisory semantics use a
separate cross-encoder and never gate the symbolic engine.

| Tier | Delivery point | Content and cost |
|---|---|---|
| 0 | MCP initialize instructions; shared `propose_*` descriptions | Master Law (~110 tokens) at initialization; a 2-sentence reminder in proposal descriptions |
| 1 | `get_ccm_guidance({ topic })` | Direct, exact one-section lookup; no embedding inference |
| 2 | `get_ccm_guidance({ query })` | Top semantic matches, default maximum two sections and a hard 1,200-token content budget |
| 3 | Rejected engine proposals (`ValidationResult.guidance`) | Hand-mapped CCM section excerpt alongside `rejectedLayer`, `reason`, and `advisoryFlags`; capped at REJECTION_GUIDANCE_MAX_CHARACTERS (~400 tokens) |

Tier 0 and Tier 3 are explanatory only. The index, embeddings, and rejection
guidance never write canon and never change `validation.ts` pass/fail logic. The
advisory NLI flags (Tier-agnostic, from `semantics.ts`) are likewise read-only.

| Check | Command | Status |
|---|---|---|
| TypeScript | `pnpm check` (`tsc --noEmit`) | 0 errors |
| Migration smoke | `LOCAL_DATA_DIR=<scratch> node --import tsx server/modules/migration/__smoke__.ts` | 21/21 checks pass |
| Engine smoke | `LOCAL_DATA_DIR=<scratch> node --import tsx server/ccm/__smoke__.ts` | 15 events / 1 episode + 1 skeleton; determinism 21/21 identical on same seeds, diverges on different seeds; L5 attributes regression; L7 adversarial escape; L1 planner (destination flips satisfied + satisfiedAt, forbidden rejects, deadline escalation 1.75) |
| Emergence smoke | `LOCAL_DATA_DIR=<scratch> node --import tsx server/ccm/__emergent__.ts` | world-before-plot: 40 events, non-micro cross-actor events (Mara+Finn), relationship-scoped rule fired, weather chain fired, determinism identical |
| v1.1 multi-actor smoke | `LOCAL_DATA_DIR=<scratch> node --import tsx server/ccm/__multiactor__.ts` | Harmon Creek (8 actors/5 envs/5 systems/6 rels/14 rules): autonomy chain with ancestry (ferry.departs → finn.walks_to_market → kael.greets_finn → finn.sells_to_kael), counterfactuals A–D, multi-seed variation, budget (churn 10 vs interactions 21), determinism identical, extraction OK — 9 experiments all pass |
| Quota smoke | SQLCipher scratch DB → 72 indexes + `LENGTH(CAST(… AS BLOB))` byte math (COALESCE-wrapped nullable columns) | All 19 content tables sum >0; nullable-column null-propagation caught & fixed |
| Client bundle | `pnpm build:server && pnpm build:electron` | ✓ built (renderer 174 kB CSS, ~3.7 MB JS) |
| MCP bundles | `pnpm build:mcp && pnpm build:mcp:npm` | ✓ (mcp/npm 2.1 MB CJS; @huggingface/transformers external) |
| Dev server | `node --watch --import tsx server/_core/index.ts` (not `tsx watch` — that hangs under concurrently on Windows) | Binds port 3000, `/api/rest/health` → "Vault is locked"; `/api/mcp` per-session fresh Server |
| Beta / vault-locked guard | `client/src/pages/BetaApply.tsx` checks `vaultUnlocked` (from `useAuth`) and disables the form | Submit button + banner when locked |

---

## 10. Current Reality & Acknowledged Caveats

- **Not yet**: per-simulation world snapshots/branching, a standalone admin service, distorted-information transfer (v1.1 §M1), long-horizon planning, and a production hardening pass beyond the 0007/storage/export fixes. The `electron-builder` `asarUnpack: ["**/*.node"]` + `extraResources: ["drizzle", "server/ccm/ccm-index.json"]` + `files: ["out/**/*","dist/client/**/*"]` wiring is shipped and verified.
- **Stale `mcp/npm/dist/server.cjs`** after any `server/mcp.ts` change — you must `pnpm build:mcp:npm` + bump `mcp/npm` `version` before publishing (the stale-bundle gotcha that hit 2.1.0 → 2.2.0).
- **Qwen Studio Windows STDIO** is broken for every MCP server (`-32000` at `mcpClientToolList`); the HTTP hosts-file route (`storyvault.local:3100`) is the supported path there.
- **`tsx watch` under `concurrently` on Windows hangs** — dev server is `node --watch --import tsx …`, never `tsx watch`.

