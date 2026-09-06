# Versioning Policy

Two version axes govern this repository. Both are surfaced by `node --import tsx rl-engine/testing/version-report.ts` (run first in CI, see `.github/workflows/ci.yml`).

## 1. Engine — Semantic Versioning

`rl-engine/package.json` `version` follows [semver](https://semver.org/) for the **public API surface** (`rl-engine/index.ts` exports + `dist/` entry points + the MCP tool set):

| Bump | When |
|---|---|
| **MAJOR** | Breaking change to the public API: removed/renamed exports, changed `Environment` interface semantics, changed `StepResult` shape, changed `EnvironmentSpecification` interpretation (spec format major bump), removed MCP tools or changed their contracts. |
| **MINOR** | Additive: new exports, new optional spec fields, new optional `Environment` methods, new MCP tools, new adapter implementations. |
| **PATCH** | Bug fixes with no API/behavioral contract change (including engine-gap fixes under Rule 4B that preserve behavior). |

The engine **spec format** version is separate: `SUPPORTED_SPEC_VERSION` in `rl-engine/environment/specification.ts` (currently `"1.0"`). Specs declare `environment.specVersion`; the compiler fails a newer major and warns on minor drift. Bump `SUPPORTED_SPEC_VERSION`'s major only with a MAJOR engine release.

`SNAPSHOT_VERSION` (`rl-engine/environment/snapshot.ts`) versions the persisted snapshot format; restore refuses mismatched versions.

## 2. Frozen content — Content hashes

Scenarios, domain packs, golden fixtures, and dossiers are **immutable data**. They are versioned by SHA-256 content hash, not by semver:

- Each pack's identity is `environment.id@environment.version` plus the SHA-256 of its `spec.json` (canonical serialization; printed by `version-report.ts`).
- The benchmark starter hash is recorded in `benchmark/scenario/scenario.json` (`starterHash`, written by `build-scenario.ts`).
- **Never edit a frozen artifact that fixtures or dossiers reference** — bump its `environment.version` and regenerate dependents instead. Editing content without a version bump is treated as tampering by the grader (echo/replay checks).

## 3. Rule 4B core ledger

`rl-engine/domain-packs/core-manifest.json` pins SHA-256 hashes of every `rl-engine/core/*.ts` file. Any core change must be recorded as a `documentedGaps` entry (pre-fix hash + rationale) before the manifest is regenerated — `testing/core-integrity.ts` enforces this in CI. Core changes that alter public API behavior also bump the engine semver per the table above.

Ledger status (2026-09-06): GAP-1..5 on record. GAP-5 (Phase I, red-team R2) fixed declarative-effect resolution in the `set` pre-flight (`core/transitions.ts`) — behavior-preserving for all previously-compiling transitions, engine version unchanged per the PATCH rule. The Phase J additions (bind-time `complianceNotice` on `env_use_spec`, grader epoch scoping) are additive and do not change tool contracts. hospital-billing and legal-filing packs moved to v1.1.0 with regenerated starters (content-hash versioning, §2).

## 4. Release checklist

1. `npm run verify-offline` — readiness.
2. `node rl-engine/testing/version-report.ts` — confirm versions + hashes.
3. Full CI locally: `npx tsc -p tsconfig.check.json` then every gate (see `ci.yml`).
4. `npm pack` inside `rl-engine/` → smoke-install the tarball into a scratch project.
5. Tag: `rl-engine-v<semver>`.
