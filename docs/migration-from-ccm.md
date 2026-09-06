# Migration Notes — from the legacy CCM engine to rl-engine

The legacy CCM/CCE story engine is no longer bundled; the architecture spec it was frozen against lives at [`docs/engine-architecture-specification.md`](engine-architecture-specification.md). This document maps every legacy concept to its successor in `rl-engine/` so migration is a table-lookup, not an archaeology dig.

## 1. The one-line summary

The CCM engine was a *story simulator with domain concepts baked in* (actors, narrative weight, scene skeletons). `rl-engine` is the same deterministic kernel with the domain extracted into declarative specs — the architecture spec ([`docs/engine-architecture-specification.md`](engine-architecture-specification.md)) executed: §1–47, with the old story domain now just one pack among three.

## 2. Concept mapping

| Legacy CCM concept | rl-engine successor | Notes |
|---|---|---|
| `Actor {attributes, state, goals, drives, habits, plans, beliefs, knowledge}` | `Entity {id, type, attributes, state}` + spec-defined fields | The typed personality fields were domain concepts; they become ordinary spec-declared state. See the hospital pack's `entities`. |
| `Environment` / `SystemDef` (world model) | `Entity` (type `"location"` etc.) | No special-cased scopes — rules target whatever the spec declares. |
| `Relationship {trust, affection, …8 bond scalars}` | `Relationship {id, source, target, type, state}` (§8) | Bond scalars become `state` fields; stored at `rel:<id>`, addressable by effects. |
| `RuleDef.when.conditions` | `Rule.conditions` (`ConditionNode`, + `all/any/not` groups, `contains`) | Ops extended to 10 + aliases; evaluation unchanged (dotted paths). |
| `candidateEvents` (possibilities) | `Rule.effects` + optional `outcomes[]` (probabilities sum to 1) | Story "possibilities" become generic stochastic outcomes. |
| `requiresPressure` gate (drives/goals/habits) | Retired in the kernel; express as a condition on a spec field (e.g. `action eq …`) | Pressure was narrative machinery. |
| `narrativeWeight` / `causalLoad` | Retired from the kernel; domain packs encode importance via rewards/constraints | Causality survives generically in `events/causalGraph.ts` (§24–25). |
| `NarrativeConstraint {hard/soft/forbidden/range/temporal, deadline}` | `Constraint {range, forbidden}` enforced atomically + `termination` conditions | Destination steering via deadlines is domain-plugin territory (not reimplemented). |
| `runSimulation(world, ticks)` batch loop | `env.reset(seed)` / `env.step(action)` → `StepResult` (§21–23) | Single-step, atomic (§16), validated in 6 layers (§15). |
| `mulberry32` + `hashSeed` | Same code, promoted to a platform guarantee (§28, §44) + state capture for checkpoints | `core/randomness.ts`. |
| `loader.ts` / `persister.ts` (SQLCipher) | `persistence/` adapters: `FilePersistenceAdapter`, `SqlCipherPersistenceAdapter` (same WAL/busy_timeout/scrypt patterns) | Engine still never touches storage (§29). |
| `ccm_events` / `ccm_event_causes` tables | `events.json` in the dossier + `events/causalGraph.ts` | Causal graph is runtime-linked per step. |
| `extractStory` → Episodes / SceneSkeletons | `episode/trajectory.ts` + dossier (`benchmark/`) | Story clustering retired; trajectory + forensic grading replaced it. |
| MCP: 78 story tools | MCP: 13 `env_*` tools (`api/mcpServer.ts`) | Same transport hardening (stdio/JSON-RPC, sandboxed spec store). |
| `guidance.ts` / `semantics.ts` (MiniLM, NLI) | Retired from the engine; LLM integration is optional at the API layer (§39) | No embedding models in the kernel. |

## 3. Migration steps for an existing world

1. **Export the world model** from the parent app (actors → entities, environments → entities, relationships → relationships).
2. **Translate rules**: `when` conditions map 1:1 (rename `op` aliases if needed); `candidateEvents` become `effects` (deterministic) or `outcomes` (stochastic). Drop `requiresPressure`.
3. **Model importance as rewards**: narrativeWeight-driven selection becomes reward components (`R = Σ weight × expression`).
4. **Pick terminations**: story deadlines become `termination` conditions; hard constraints become `range`/`forbidden` constraints.
5. **Compile**: `compileEnvironment` surfaces every unresolved reference before runtime — the compiler is your migration checker.
6. **Prove parity**: run the pack through `testing/pack-pipeline.ts` (compile → validate → smoke → determinism gate → properties → grade). The determinism gate gives you the same byte-identical replay guarantee the CCM smokes provided.

## 4. What is intentionally NOT migrated

- Per-simulation world branching (was already deferred in CCM) — snapshot/restore (Phase E) covers long-horizon tasks instead.
- Scene-skeleton prose rendering — the LLM renderer operates on dossiers now, outside the engine.
- The 78-tool story MCP surface — still served by the frozen engine for the parent app until the parent adopts the 13-tool `env_*` surface.

## 5. Where things live now

| Concern | Path |
|---|---|
| Active engine | `rl-engine/` (see `rl-engine/README.md`) |
| Domain packs (incl. the hospital world) | `rl-engine/domain-packs/` |
| Benchmark + grader | `benchmark/` (see `docs/benchmark-guide.md`) |
| Frozen legacy engine | removed from the tree (git history / prior release keeps it) |
| Parent app | `D:\story-vault` — still runs its own `server/ccm` copy until integration |
