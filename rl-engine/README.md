# rl-engine — Generic Reinforcement Learning Environment Engine

A domain-independent engine for creating and executing reinforcement-learning environments from **declarative specifications**. Implements the Software Architecture Specification v1.0 (`docs/engine-architecture-specification.md`, §1–47).

The engine owns **what happens**. The RL algorithm owns **learning what to do**. Environments are JSON specs — never engine-source changes.

```
Environment Specification → Compiler → Sandboxed Runtime → reset()/step() → trajectories
```

## Layout (spec §41)

```
rl-engine/
├── core/          state (schema, conditions, effects), randomness (RandomService), transitions (atomic), validation
├── environment/   specification, compiler (§32), validator (§33), generic Environment (§21-23)
├── observation/   observation engine + compiler (§17)
├── reward/        reward engine + compiler (§18-19)
├── episode/       episode lifecycle (§20), trajectory recorder (§26), replay (§27)
├── events/        event system + causal graph (§24-25)
├── plugins/       plugin interface + sandboxed function registry (§30-31)
├── persistence/   loader/persister — outside the kernel (§29)
├── rl/            policy/trainer/rollout/replayBuffer/feedback — thin interfaces (§34-38)
├── testing/       determinism, environment, property tests (§45) + end-to-end smoke
├── api/           public Environment API re-exports (§21)
└── domain-packs/  harmon-creek — first proof of domain-independence (§46 Phase 9)
```

## Guarantees

- **Deterministic (§28, §44):** all randomness flows through the seeded `RandomService` (mulberry32). Same spec + seed + action sequence → identical trajectory. No `Math.random`, no `Date.now` in the kernel.
- **Atomic (§16):** `step()` clones state → applies effects to the temp copy → validates → commits or discards. An invalid action never mutates the environment.
- **Pure kernel (§29, §40):** the engine never imports the DB, filesystem, or network; persistence and loaders live outside the step loop. Spec evaluation is sandboxed — no arbitrary code execution.
- **LLM-optional (§39):** no model is required; an LLM may generate specs or act as a policy but can never bypass validation.

## Usage

```ts
import { loadSpecFromFile, compileEnvironment, createEnvironment } from "./index.ts";

const spec = loadSpecFromFile("./domain-packs/harmon-creek/spec.json");
const compiled = compileEnvironment(spec);
if (!compiled.ok) throw new Error(compiled.errors.map((e) => e.message).join("; "));

const env = createEnvironment(spec, 42);
env.reset(42);
const result = env.step({ type: "admit_patient" });
// result: { observation, reward, rewardComponents, terminated, truncated, info, state }
```

## Verify

```bash
node --import tsx rl-engine/testing/smoke.ts        # from a checkout that provides tsx (e.g. ../story-vault)
```

The smoke proves: compiler defect detection (exactly 4 `unknown_target`), atomic invalid-action rejection, terminated + truncated episodes, ≥100 real `step()` calls, partial observability (`Observation ⊂ State`), reward composition (`R = Σ component × weight`), byte-identical replay, and dossier filing + grading.
