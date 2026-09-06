# Harmon Creek Domain Pack

First proof that the generic engine is domain-independent (spec §46 Phase 9).

This domain was the original CCM story world (8 actors, 5 envs, 5 systems, 6 rels, ~14 rules in `engine-core/ccm/__multiactor__.ts`). It now runs as a declarative `spec.json` on the generic engine without modifying `rl-engine/core/`.

Usage:

```ts
import { loadSpecFromFile } from "../../persistence/loader";
import { compileEnvironment } from "../../environment/compiler";
import { createEnvironment } from "../../environment/environment";

const spec = loadSpecFromFile("./spec.json");
const compiled = compileEnvironment(spec);
if (!compiled.ok) throw new Error(compiled.errors.map(e => e.message).join("; "));
const env = createEnvironment(spec, 42);
env.reset(42);
const result = env.step({ type: "admit_patient" });
```

No story engine import. No `engine-core/ccm` import. Pure generic API.
