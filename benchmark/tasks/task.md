# Task — Harmon Creek Regional Hospital Commissioning (Generic Engine)

You are an agent operating the **Generic RL Environment Engine**. Your vault contains an `EnvironmentSpecification` JSON at `benchmark/scenario/spec.json` (also available as `rl-engine/domain-packs/harmon-creek/spec.json`).

## Objective

Commission the facility to a verifiable end state using the **generic API** only:

- `reset(seed?) → ResetResult`
- `step(action) → StepResult { observation, reward, rewardComponents, terminated, truncated, info }`
- `getActionSpace()`, `getObservationSpace()`, `getState()`, `getSpecification()`

The engine owns `State → Validate (6 layers) → Transition (atomic) → Reward → Observation → Episode`. You do not write canon directly — every `step(action)` is validated atomically (temp clone → validate → commit-or-discard per spec §16).

## Required Workflow (≥100 step() calls)

1. **Discovery (5 calls):** `getSpecification()`, `getActionSpace()`, `getObservationSpace()`, `getState()`, compiler check via `compileEnvironment` (report errors).

2. **Fix 4 deliberate spec defects:** The starter spec contains 4 unresolvable effect targets that `compileEnvironment` flags as `unknown_target`: `entity:Wrad_A` → `entity:ward_a`, `entity:Marra` → `entity:mara`, `entity:Logistix` → `state` (restock writes supplies), `rel:finn-keal` → `rel:finn-kael`. Fix each and re-compile until `ok:true`. The corrected reference spec lives at `rl-engine/domain-packs/harmon-creek/spec.json`.

3. **Commissioning loop (≥80 calls):** `reset(42)`, then `step(action)` repeatedly. You must:
   - Hit at least 2 distinct action types.
   - Trigger at least one `terminated` or `truncated` episode.
   - Demonstrate that an invalid action does not mutate state (call with unknown type and show `info.valid === false` and state unchanged).

4. **Partial observability check (5 calls):** Show `getState()` vs `getObservationSpace()` difference — `Observation ⊂ State` when `fullyObservable:false`.

5. **Reward composition (5 calls):** After steps, show `rewardComponents` breakdown and `R = Σ component×weight`.

6. **Replay & filing (5 calls):** `replay(spec, seed, actionSequence)` → identical trajectory proof. Persist trajectory to `benchmark/dossier/trajectory.json` and spec snapshot to `benchmark/dossier/spec-snapshot.json`.

## Verifiable End State (grader checks)

- `trajectory.json` exists, length ≥40, contains `rewardComponents`.
- At least one episode terminated or truncated.
- At least 4 compiler errors were fixed (trace shows before/after).
- Invalid action was correctly rejected (atomicity).
- `benchmark/dossier/scores.json` is written by grader with 100-pt rubric.

## Anti-bluff

Empty trajectory, echoed spec hash, boilerplate observations, or bluff parent chains all fail with `layer:result_validation`.

## Rules

- Engine core is read-only. Do not edit `rl-engine/core/`.
- All data is synthetic. No real patient data.
- Offline only. No network.
