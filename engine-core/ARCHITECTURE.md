# Engine Architecture — CCM / CCE + MCP

Self-contained architecture note for `engine-core/`. No writing-workspace concerns: no editor, no manuscripts, no Idea Vault, no scene routers. Only the framework (CCM), the simulator (CCE), persistence, and the MCP surface.

For the full application architecture (including client, admin, editors, exports), see `../ARCHITECTURE.md`.

---

## 1. Directory and build

```
engine-core/
├── ccm/            # The engine — 22 files, ~4.3K lines
├── db/             # Drizzle schema + migrations 0000→0007
├── docs/           # Framework docs (CCM.md, CCM_CCE_IMPLEMENTATION.md)
├── mcp.ts          # MCP server entry (78 tools) — identical to server/mcp.ts
├── mcpCli.ts       # CLI shim for dist/*
├── db-connection.ts# SQLCipher connection + migration runner (mirrors server/db.ts)
├── mcp-npm/        # Publishable npm package (story-vault-mcp 2.2.0)
├── mcp-python/     # Publishable PyPI package (uvx → npx)
├── README.md       # Orientation
└── ARCHITECTURE.md # This file
```

- Engine imports: only `drizzle/schema.ts` (table types) and Node/transformers stdlib.
- No dependency on `server/routers/`, `client/`, `admin/`, or any writing-domain code.
- The engine (`ccm/types.ts`) defines the in-memory model it operates on; `loader.ts` and `persister.ts` are the only files that know about `ccm_*` table names.

---

## 2. CCM (the framework) — § references

`docs/CCM.md` (v1.0, §1–§61, Master Law at §59) defines the conceptual separation:

- The **symbolic engine owns canon** (state, rules, events, causality, chronology, constraints). The **LLM only reads or proposes** through validation.
- **Attributes vs state** (§7): durable traits vs mutable per-simulation fields.
- **Causal load vs narrative weight** (§31): causality debt and the `CcmCausalLoad` spectrum.
- **Possibility vs desirability** (§33): the engine answers "could this happen", prose answers "is it worth telling".
- **World truth vs character knowledge** (§34): knowledge is the engine-level concern, not FactTruth.

Read `docs/CCM.md` before any engine change — the engine is a transcription of it, not the inverse.

`docs/CCM_CCE_IMPLEMENTATION.md` tracks the transcription: Phases A–C, current reality, limitations, and what remains.

---

## 3. Engine pipeline

### Data model (`ccm/types.ts`)

```ts
World {
  id, name, description, premise, themes, targets, forbidden,
  actors: Actor[], environments: Environment[], systems: SystemDef[],
  rules: RuleDef[], relationships: Relationship[],
  constraints: NarrativeConstraint[],
  clock: CcmClock, settings: CcmSimulationSettings,
  events: EngineEvent[],        // ordered, persisted
  causes: EngineEventCause[]    // (child → parent) edges
}

Actor { id, name, type, attributes, state, goals, drives, habits,
        constraints, knowledge, beliefs, plans, ... }
RuleDef { name, when: Condition[], then: StateChange[],
          requiresPressure?: PressureKey, ... }
StateChange { target: "self" | "environment:Name" | "actor:Name" | "relationship:A:B",
              field: "attributes.foo" | "state.bar" | "goals" | ... , op, value? }
```

The engine is **pure**: `simulator.ts` never imports the DB. The only I/O happens at the boundaries:

```
loader.ts   :  DB rows (ccm_* tables)  →  World
simulator.ts:  World × seeds × pressure  →  events + causes + world delta
persister.ts:  delta  →  DB rows (events, causes, queue, state)
```

### Seeded determinism

- Seeded PRNG: `ccm/rng.ts` (`mulberry32` + `hashSeed` + `roll`). The same `World` + seed produces a **byte-identical event stream** irrespective of wall-clock or host.
- Every run is `seed = string|number` (e.g. `"kaden-v1"` or `42`), hashed into a 32-bit seed, used deterministically throughout selection, ordering, and tie-breaking.
- No `Math.random`, no `Date.now`, no async jitter in the step loop.

Verification: `ccm/__smoke__.ts` runs the Kaden world twice from the same seed, restores the world in between, and asserts byte-identity of the two event streams.

### Per-tick sequence (`ccm/simulator.ts`)

```
1. computePressure(World)               → scalar per candidate (drives/goals/habits/plans/beliefs/constraints)
2. ruleMatches(World → candidates)      → CandidateDef + DecisionOpportunity per actor
3. validateCandidate(CandidateDef)      → 6 layers (constraint → existence → knowledge → budget → relationship → attributes)
4. select(successfulCandidates)         → pressure-weighted, seeded; interaction candidates ×1.15 boost
5. applyStateChange(World, selected)   → set / increment / append / remove (skips transitionOnly no-ops)
6. linkCausalParents(newEvent, parents, weight)
   applyDeferredLoad(newEvent)         → causal graph (ccm_event_causes)
7. applyObservation(World, newEvents)  → observed/public visibility → actor knowledge/beliefs
8. check constraint satisfaction + budget exhaustion
```

- `types.ts:DecisionOpportunity` is the Actor-scoped candidate container.
- `candidate.transitionOnly` rules never re-emit an identical event — `compare current→proposed, skip if ===`; `increment 0` and `append existing` are also skipped (§23). Kills `ward_crowded × N` churn.
- `candidate.category` is derived at emit — `environment` / `system` / `relationship` / `interaction` / `decision` / `background` / `critical` — and stored inside the existing `trigger` JSON (no schema migration).
- `RuleWhen.requiresPressure` is enforced in `ruleMatches` (`ccm/rules.ts`): the keyword must appear in drives/goals/habits/plans; existing worlds satisfy it.
- Interaction candidates (those targeting `actor:`/`relationship:`) receive the deterministic ×1.15 probability boost (§24) so social interactions compete with churn, never forced.
- `ccm/observation.ts` is called **at the end of each tick** (after the candidate loop, before the constraint check), preserving the same-tick no-interleaving guarantee. Each `visibility: "observed"` event informs actors at that `location` who are not participants; `visibility: "public"` events inform all actors.

---

## 4. The 6 validation layers (§23–§30, CCM.md)

| Layer | Purpose | File |
|-------|---------|------|
| **L1 — Constraint planner** | Destination steering + auto-satisfaction + deadlines. Rejects candidates that would violate a live constraint plan. | `ccm/constraints.ts` |
| **L2 — Existence** | Target path exists in the world? (checked against `habits`, `attributes.*`, `state.*`, `knowledge`, etc.) | `ccm/validation.ts` |
| **L3 — Knowledge gate** | Does the actor **know** the acted-upon information? Gated on `knowledge` + `beliefs.known`, fed by `ccm/observation.ts`. | `ccm/validation.ts` + `ccm/observation.ts` |
| **L4 — Event budget** | `transitionOnly` de-dup + micro/macro budget split; interaction boost; budget exhaustion check. | `ccm/simulator.ts` |
| **L5 — Relationship scope** | `relationship:A:B` targets are validated against the `ccm_relationships` table; relationship-scoped rules must name a valid relation. | `ccm/rules.ts` + `ccm/validation.ts` |
| **L6 — Attributes persistence** | `attributes.*` changes persist per-actor; validated as owning-actor responsibility. | `ccm/validation.ts` + `ccm/persister.ts` |

Rejections surface as `layer + reason + guidance` (L1–L7 closed per the CCE audit, see `CCE_V1_1_REPORT.md` in the old `docs/reports/` — now under the parent's `CCM_CCE_IMPLEMENTATION.md`).

---

## 5. Observation → knowledge transfer (v1.1)

`ccm/observation.ts` closes the original "nothing reads visibility" gap:

```ts
applyObservation(world, newEvents) {
  // for each event where visibility === "observed":
  //   every actor at event.location who is not a participant
  //   gains a knowledge entry: `knowledge` + `beliefs.known`, deduped
  // for visibility === "public":
  //   every actor gains the knowledge entry (town-crier semantics)
}
```

- Deterministic: fixed actor iteration order, dedup key.
- Knowledge persists via `persister.ts` actor-state write; the L4 knowledge gate already reads `beliefs.known` (present since the CCM refactor), so `observation.ts` feeds it without changing the API.
- Part of the required 5+ causal chains (≥2 multi-actor, ≥1 environment-mediated) verified in `ccm/__multiactor__.ts` against Harmon Creek — see item 6 below.

---

## 6. Emergence test world

`ccm/__multiactor__.ts` follows the `ccm/__emergent__.ts` pattern: scratch `LOCAL_DATA_DIR`, assert helper, snapshot/restore for determinism. Harmon Creek fixture — **8 actors** (differing goals/drives/constraints/knowledge/beliefs/plans; conflicting goals for at least one), **4 environments**, **5 systems**, **6 relationships**, ~12 rules. No single rule encodes the full chain.

Required experiments (§33–§35 on `docs/CCM.md`):

- **Autonomy chain**: Mara's ferry departs → Finn (at Harbor) observes → Finn gains knowledge → Finn's plan step fails → Finn walks to TownSquare → Kael observes Finn → relationship change.
- **Counterfactuals A–D**: remove a key goal → trajectory changes; change a relationship (trust high→low) → different decision; remove/alter a resource → downstream changes; remove protagonist → world still produces meaningful activity.
- **Multi-seed**: same seed → identical histories; 3–5 different seeds → meaningful variation on decisions/relationships (not just ordering).
- **Event budget**: `transitionOnly` environment rules no longer starve actor interactions.
- **Determinism**: same seed twice, full world restore.

---

## 7. MCP — the agent access surface

`mcp.ts` exposes **78 tools** over STDIO and Streamable HTTP (both with `hostHeaderValidation` + `localhostHostValidation` against DNS rebinding). On every `initialize` the server builds a fresh `Server`+transport pair (fix for the old "Server already initialized" hang). It can also run **embedded inside the app** via `server/_core/mcpServer.ts` at `http://127.0.0.1:3100/mcp` — that file is not mirrored here, but `mcp.ts` documents the embedded contract.

All mutating tools call `storageService.recomputeUsage` and all quota accounting is byte-accurate. Text interpolated into prose/export headers is sanitized. Every tool enforces project ownership against `openId = "local:primary"`. The DB opens in WAL mode with `busy_timeout=5000` so the MCP server and the running app can share the encrypted database.

Full tool list and transport details: see `../ARCHITECTURE.md` §MCP (the engine-core list here is identical).

Distributable packages live in `mcp-npm/` and `mcp-python/` (identical READMEs, different launchers — npm uses `npx story-vault-mcp`, Python uses `uvx story-vault-mcp`).

---

## 8. Verification

```bash
pnpm check                                  # tsc --noEmit (entire repo)

# from the parent repo; or cd into engine-core and adjust import path:
node --import tsx server/ccm/__smoke__.ts
node --import tsx server/ccm/__emergent__.ts
node --import tsx server/ccm/__multiactor__.ts   # v1.1: multi-actor chains + counterfactual budget

# Tiered retrieval (CCM guidance tiers)
node --import tsx server/ccm/guidance.test.ts

# Build the prebuilt index for any new CCM section edits:
pnpm build:ccm-index  # → server/ccm/ccm-index.json
```

All smokes exit non-zero on failure. The parent repo's `pnpm check` covers `engine-core/` when run from root (paths resolve through the root `tsconfig.json` — `engine-core/` shares the parent's `client/src/**/*, shared/**/*, server/**/*` include; a dedicated `tsconfig` inside `engine-core/` is the roadmap for standalone `tsc`).

---

## 9. Relationship to the parent

| File in `engine-core/` | Canonical file at root |
|------------------------|------------------------|
| `ccm/*` | `server/ccm/*` |
| `docs/CCM.md` | `CCM.md` |
| `docs/CCM_CCE_IMPLEMENTATION.md` | `CCM_CCE_IMPLEMENTATION.md` |
| `db/schema.ts` + `db/0000..0007.sql` | `drizzle/schema.ts` + `drizzle/0000..0007.sql` |
| `mcp.ts` | `server/mcp.ts` |
| `mcp-npm/` | `mcp/npm/` |
| `mcp-python/` | `mcp/python/` |

`engine-core/` is currently a **view** — identical content to the canonical files. When engine files are modified, update the parent copies via:

```bash
cp -R engine-core/ccm/* server/ccm/
cp engine-core/mcp.ts server/mcp.ts
cp engine-core/docs/* ./         # into CCM.md + CCM_CCE_IMPLEMENTATION.md
cp engine-core/db/* drizzle/     # if schema/migrations changed
cp -R engine-core/mcp-npm mcp/npm  # likewise for package READMEs
```

Long-term roadmap: make `engine-core/` the single source and have the parent mirror it (symlinks require Developer Mode on Windows, so a copy task is the portable choice).

---

## 10. Known boundaries

- **Advisory semantics**: `ccm/semantics.ts` and the ONNX NLI / zero-shot models are advisory only — contradiction flags travel alongside the symbolic verdict but never flip a rejection. Quota is enforced independently.
- **No writing workspace here**: editor (TipTap), idea vault, manuscript export, scene versioning, the `ideas/`/`scenes/` routers, and the research-thread/ideation agent tools are intentionally excluded.
- **Admin is separate** (`../admin/` — 18 React pages) — not included here.
- **Electron / renderer** (`../client/`, `../electron/`) — not included here.
- **Production hardening** (per `CCM_CCE_IMPLEMENTATION.md` §deferred): per-simulation world snapshots/branching, a standalone admin service, and a production hardening pass remain out of scope.
