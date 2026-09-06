# ⛔ FROZEN — Legacy Reference (do not modify)

**Status: FROZEN as of Phase G (2026-09-06).** This directory is an immutable snapshot of the CCM/CCE story engine as it stood when `rl-engine/` superseded it.

## Why it is frozen

`rl-engine/` is the active engine (spec `Generic Reinforcement Learning Environment Engine — Software Architecture Specification.md` §1–47). The old story domain now runs as a declarative domain pack (`rl-engine/domain-packs/harmon-creek/spec.json`) with zero code reuse from this directory — the Phase D proof of domain-independence. See `docs/migration-from-ccm.md` for the full concept mapping.

## Rules

1. **No edits.** Not even build fixes, dep bumps, or doc updates. This tree compiles only from its canonical parent checkout (`D:\story-vault`), and that context is historical.
2. **No build paths reference it.** `tsconfig.check.json`, the CI workflow, `pack-pipeline.ts`, and the benchmark treat this directory as data. `benchmark/scripts/verify-offline.ts` checks its *existence* only (reference integrity).
3. **It stays in the repository** as the historical reference the migration notes and the architecture spec cite.

## If you need something from here

- The story engine's *concepts*: read `docs/CCM.md` (framework) and `ARCHITECTURE.md` — then map them with `docs/migration-from-ccm.md`.
- The story engine's *code*: the parent repo `D:\story-vault` (`server/ccm/`) is the canonical, still-functioning copy for that application.
- The seeded-determinism techniques: they were promoted into `rl-engine/core/randomness.ts` and are covered by CI gates there.
