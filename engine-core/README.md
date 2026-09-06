# CCM / CCE — Causal Continuity Engine

A deterministic, seeded causal simulation runtime with a 6-layer validation pipeline, a 78-tool MCP surface, and an encrypted project-scoped world model. Owns all canon independently of any LLM.

This directory is **self-contained**: the framework, the engine, the persistence layer, and the agent access surface. No editor, no manuscripts, no Idea Vault — just CCM (theory), CCE (implementation), and MCP.

---

## 1. What's inside

```
engine-core/
├── README.md                 # This file — orientation for the engine
├── ARCHITECTURE.md           # Engine-only architecture (no writing-workspace concerns)
├── ccm/
│   ├── types.ts              # CCM domain types (World, Actor, Environment, System, Rule, Constraint, Event, …)
│   ├── rng.ts                # Seeded mulberry32 PRNG — byte-identical replay
│   ├── time.ts               # CcmClock helpers
│   ├── state.ts              # Structured state transitions (set / increment / append / remove)
│   ├── rules.ts              # Rule DSL (conditions, candidates, actorRecord, requiresPressure)
│   ├── pressure.ts           # Per-candidate pressure accumulator
│   ├── constraints.ts        # Narrative constraint registry + satisfaction check
│   ├── validation.ts         # 6-layer validation pipeline (existence → legal → narrative → knowledge → relationship → budget)
│   ├── causality.ts          # Causal graph (linkCausalParents, applyDeferredLoad)
│   ├── observation.ts        # Observation → knowledge transfer (observed/public visibility → actor knowledge/beliefs)
│   ├── simulator.ts          # Step loop (pressure → candidates → validation → selection → mutation)
│   ├── extractor.ts          # Episodes + scene skeletons from events
│   ├── loader.ts             # World hydration from the ccm_* tables
│   ├── persister.ts          # Delta writeback (events, causes, queue, world state)
│   ├── semantics.ts          # Advisory NLI + zero-shot classification (CPU-only, non-gating)
│   ├── embeddings.ts         # Tiered CCM guidance retrieval (all-MiniLM-L6-v2)
│   ├── ccm-index.json        # Prebuilt CCM section embeddings
│   ├── guidance.test.ts      # Tiered retrieval smoke test
│   ├── __smoke__.ts          # Determinism smoke (Kaden world, same seed → identical histories)
│   ├── __emergent__.ts       # Emergence smoke (Harmon Creek, multi-actor interaction)
│   └── __multiactor__.ts    # v1.1 smoke (observation-driven chains, counterfactual divergence, budget)
│   ├── docs/
│   │   ├── CCM.md                 # Causal Continuity Model — the framework (v1.0)
│   │   └── CCM_CCE_IMPLEMENTATION.md # How the framework became code (Phases A–C + v1.1)
│   ├── db/
│   │   ├── schema.ts               # Full Drizzle schema (projects, ccm_* tables, scenes, ideas, simulations, …)
│   │   └── 0000_*.sql .. 0007_*.sql # SQLite migrations (0006 = CCM core refactor, 0007 = missing indexes)
│   ├── mcp.ts                      # MCP server entry (78 tools — see ARCHITECTURE.md)
│   ├── mcpCli.ts                   # CLI shim for `dist/mcp.js` / `mcp/npm/dist/server.cjs`
│   ├── db-connection.ts            # SQLCipher connection manager + migration runner
│   ├── mcp-npm/                    # Publishable npm package (`story-vault-mcp` 2.2.0)
│   └── mcp-python/                 # Publishable PyPI package (uvx launcher → npx)
```

---

## 2. CCM (the framework) vs CCE (the implementation)

| Layer | Source | What it is |
|-------|--------|------------|
| **CCM** | `docs/CCM.md` | The theory (§1–§61, Master Law at §59). Defines the symbolic engine as the sole owner of canon, the LLM as a reader/proposer, attributes vs state, causal load vs narrative weight, possibility vs desirability, world truth vs character knowledge. |
| **CCE** | `ccm/` | The executable engine. A deterministic, pure, seeded simulator that implements CCM as a pressure → candidate → validation → selection → mutation → persistence → extraction pipeline. Directory `ccm/`, seeded with mulberry32, lazy ONNX advisory semantics, tiered CCM guidance retrieval. |

### The two LLM modes (per-project `project_settings.agent_mode`)

| Mode | Value | LLM position | What it can do |
|------|-------|--------------|----------------|
| **Observer** (default) | `observer` | Layered **on top** of the engine | Read everything; stage prose (`render_skeleton`), advisory semantics. Cannot write canon. |
| **Baked-in** | `baked_in` | **Inside the loop** | All of Observer + `propose_*` tools whose state changes pass through the 6-layer validation pipeline before writeback. Advisory NLI flags ride alongside but never flip the verdict. |

The symbolic firewall holds in both modes: the engine gates canon, the LLM renders or proposes, the user accepts.

---

## 3. Determinism and the step loop

Every simulation run takes:

- a `World` (actors, environments, systems, rules, relationships, narrative constraints),
- a `CcmSimulationSettings` + seeded `CcmClock`,
- a `seed` (string or number — hashed via `hashSeed` into a mulberry32 seed).

The same `World` + seed → **byte-identical event stream**, regardless of when or where it's replayed.

### Per-tick sequence

```
pressure(actors)              # per-candidate pressure scalar (drives, goals, habits, plans, beliefs, constraints)
→ ruleMatches(World → candidates)
→ validateCandidate(...)       # 6 layers; knowledge gate uses actor knowledge/beliefs
→ select(...)                  # pressure-weighted, seeded; interaction candidates get ×1.15 boost
→ applyStateChange(World)
→ linkCausalParents + applyDeferredLoad
→ applyObservation(newEvents)  # observed/public visibility → knowledge transfer
→ counterfactual / budget checks
```

- `types.ts:DecisionOpportunity` is the Actor-scoped candidate container.
- `transitionOnly` candidates are skipped when their state changes would be no-ops.
- `category` metadata (`environment` / `system` / `relationship` / `interaction` / `decision` / `background` / `critical`) is derived at emit and stored inside the existing `trigger` JSON.
- Validated `RuleWhen.requiresPressure` gates candidates whose pressure is below threshold.

---

## 4. The 6 validation layers (§23–§30 in CCM.md)

| Layer | Purpose | Key implementation |
|-------|---------|---------------------|
| **L1. Constraint planner** | Does the candidate violate a narrative constraint (destination steering + auto-satisfaction + deadlines)? | `constraints.ts` |
| **L2. Existence** | Does the target path `state.*` / `attributes.*` exist in the world? | `validation.ts` |
| **L3. Knowledge gate** | Does the actor **know** the information they act on? Gates on `knowledge` + `beliefs.known` fed by `observation.ts`. | `validation.ts` + `observation.ts` |
| **L4. Event budget** | `transitionOnly` + micro/macro split; no-op skip; interaction boost. | `simulator.ts` |
| **L5. Relationship scope** | Rules gating on `relationship:X:Y` fields; scope is validated against the relationship table. | `rules.ts` + `validation.ts` |
| **L6. Attributes persistence** | `attributes.*` changes persist per-actor; validated as the owning actor's responsibility. | `validation.ts` + `persister.ts` |

Rejections surface with `layer + reason + guidance` so callers can distinguish legitimate failures from policy violations. L1–L7 are closed per the CCE audit.

---

## 5. MCP — the agent access surface

`mcp.ts` exposes **78 tools** over STDIO and Streamable HTTP (both with `hostHeaderValidation` + `localhostHostValidation` against DNS rebinding). The server builds a fresh `Server`+transport pair per `initialize` session and can also run embedded at `http://127.0.0.1:3100/mcp`.

All mutating tools call `storageService.recomputeUsage` and all quota accounting is byte-accurate. Text interpolated into export headers is sanitized to prevent prompt injection. Every tool enforces project ownership against `openId = "local:primary"`. The DB opens in WAL mode with `busy_timeout=5000` so the MCP server and the running app can share the encrypted database.

Full tool list and transport details: see `ARCHITECTURE.md` §MCP.

Distributable packages live in `mcp-npm/` and `mcp-python/` (identical READMEs, different launchers — npm uses `npx story-vault-mcp`, Python uses `uvx story-vault-mcp`).

---

## 6. How to verify

```bash
pnpm check                          # tsc --noEmit (entire project)
node --import tsx ccm/__smoke__.ts  # determinism: same seed twice, byte-identical
node --import tsx ccm/__emergent__.ts
node --import tsx ccm/__multiactor__.ts  # v1.1: multi-actor chains + counterfactual budget

# Tiered retrieval (CCM guidance tiers: section-level + world-model)
npx tsx ccm/guidance.test.ts

# Build the prebuilt index for any new CCM section edits:
npx tsx build-ccm-index.ts  # → ccm/ccm-index.json
```

All three smokes exit non-zero on failure.

---

## 7. Relationship to the parent project

This directory is a **view** into Story Vault's engine. The canonical source lives in:

- `../server/ccm/` — engine source (identical content to `ccm/`)
- `../CCM.md` + `../CCM_CCE_IMPLEMENTATION.md` — framework docs (identical to `docs/`)
- `../drizzle/schema.ts` + migrations `0000`→`0007` — persistence (identical to `db/`)
- `../server/mcp.ts` — MCP server (identical to `mcp.ts`)

When engine files are modified, update the parent copies via:

```bash
# manual mirror (no script yet — see roadmap)
cp -R engine-core/ccm/* server/ccm/
cp engine-core/mcp.ts server/mcp.ts
cp engine-core/docs/* ../            # into CCM.md + CCM_CCE_IMPLEMENTATION.md at root
```

Long-term roadmap: make `engine-core/` the single source and have the parent mirror it (symlinks on Windows are developer-mode only, so a copy task is the portable choice).

---

## 8. Known boundaries

- **Engine advisory surface**: the NLI/zero-shot ONNX models are **advisory only** — they produce contradiction flags that travel alongside the symbolic verdict but never flip a rejection. Quota is enforced independently.
- **Persistence**: the engine is pure — it never touches the DB in the step loop. `loader.ts` hydrates `World`, the simulator steps it, `persister.ts` writes the delta back (events, causes, queue, actor/system/env state).
- **No writing-workspace concerns here**: editor (TipTap), idea vault, manuscript export, scene versioning, and the ideas/scenes routers are not part of this directory. The MCP server's `scenes`/`ideas` tools remain — they are the external-facing surface over the same DB.
- **Admin is separate** (`../admin/` — 18 React pages) — not included here.

---

## License

MIT — see `../LICENSE.md`.
