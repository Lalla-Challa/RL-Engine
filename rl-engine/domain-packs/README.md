# Domain Packs — Spec-Authoring Contract

How to add a new environment to the generic engine **without touching `rl-engine/core/`**. A domain pack is one declarative `spec.json` — the engine never learns what the domain "is" (spec §1, §47: *"The engine should not know what the environment represents"*).

Eight packs currently prove the contract across eight domains: `harmon-creek/` (healthcare/logistics), `harmon-creek-hard/` (same domain, hardened variant with a hidden-parameter regime), `warehouse-logistics/` (logistics), `trading-market/` (trading), `insurance-claims/` (sequential compliance workflow), `legal-filing/` (deadline-bounded process), `hr-onboarding/` (gate-gated issuance), and `hospital-billing/` (cross-system EHR↔Pharmacy↔Billing workflow). All pass the same generic pipeline: **compile → validate → smoke → determinism gate → properties → forensic grade**.

Packs with a benchmark variant also ship `spec-starter.json` — the same spec with 4 deliberate compiler-level defects (`unknown_target`) for repair tasks. The compliance packs were additionally hardened against an authorized red-team engagement (see `RedTeamTest/report.md`): hospital-billing v1.1.0 enforces one-billable-unit-per-dispense with a cross-field `payment_invoice_parity` constraint, legal-filing v1.1.0 enforces its 5–30 filing window with visible `constraint_validation` rejections, and all rule preconditions are grader-checked against the domain reference.

## 1. Pack directory layout

```
domain-packs/<pack-name>/
├── spec.json        REQUIRED — the EnvironmentSpecification (§9)
└── (optional) starter-spec.json, checklist.json, scenario.json for
       benchmark variants — see benchmark/README.md
```

No code. No imports. No engine registration: pass the spec inline to `createEnvironment(spec, seed)` or `env_use_spec { spec }` over MCP.

## 2. The `spec.json` sections

| Section | Purpose | Keys the engine understands |
|---|---|---|
| `environment` | Identity | `id` (stable — used by cross-domain grading), `version`, `specVersion` (pin `"1.0"`), `description` |
| `state` | Typed state schema (§6) | per field: `type` (boolean/integer/float/string/enum/array/object), `min`, `max`, `default`, `mutable` (default true), `visibility` |
| `entities` / `relationships` | World objects (§7–8) | Entity: `{id, type, attributes, state}`. Relationship: `{id, source, target, type, state}` — stored at `entity:<id>` / `rel:<id>` in the root state; effect targets `entity:<id>` / `rel:<id>` address their records |
| `actions` | Action space (§5) | five kinds — see §3 below; every kind is addressable by `type` (or, for discrete, by each entry of `actions`) |
| `rules` | Transitions (§10–14) | `conditions` (composable), `effects`, optional `outcomes[]` (stochastic, probabilities sum to 1), `priority`, `probability`, `cooldown`, `enabled` |
| `observations` | Partial observability (§17) | `fields: [{field, source, filter?}]`, `fullyObservable` — `source: "entities"` + `filter: "<path> <op> <value>"` for collections |
| `rewards` | R(Sₜ,Aₜ,Sₜ₊₁) (§18–19) | `components: [{id, expression, weight}]`; `R = Σ component × weight` |
| `constraints` | Range/forbidden legality | `{id, type: "range"\|"forbidden", target: {field, min?, max?, forbidden?}}` — enforced atomically post-transition |
| `termination` | Episode end (§20) | `{field, op, value, kind: "terminated"}` (state condition) or `{kind: "truncated", maxSteps}` (temporal) |

## 3. Action-space kinds (§5)

| Kind | Envelope the agent sends | Validation |
|---|---|---|
| `discrete` | `{type: "admit_patient"}` | type ∈ `actions[]` |
| `parameterized` | `{type:"move", params:{direction:"north"}}` | params checked: required, `type`, `min/max`, `allowedValues` |
| `continuous` | `{type:"trade", value: -10}` | value is a finite number clamped to `[min,max]`, then written to `state[field]` **before** rule effects apply |
| `multiDiscrete` | `{type:"move_units", params:{dims:["A","DISPATCH",10]}}` | one entry per dim, each ∈ dim values |
| `conditional` | base kind's envelope | validated against `base` (availability gating belongs in rule conditions) |

Illegal actions are rejected atomically at `action_validation` — state never mutates (§4, §16).

## 4. Rules: conditions, effects, outcomes

- **Conditions** are `ConditionNode`s: flat `{field, op, value}` (`eq/ne/gt/gte/lt/lte/in/not_in/exists/absent/contains`, plus `==`-style aliases) or compositional `{all|any|not}`. The record conditions evaluate against is the live state plus `action` (the action type), action `params`, and — for continuous actions — the clamped value under the def's `field`.
- **Effects** are `{target, field, op, value}`. Targets: `state` (root), `entity:<id>`, `rel:<id>`. Ops: `set/add/subtract/multiply/divide/append/remove/increment/decrement/create/delete`.
- **Effect values** may be literals or declarative references (§31 subset): `{"$field":"market.price"}`, `{"$mul":[a,b]}`, `{"$add":[...]}`, `{"$sub":[...]}`, `{"$div":[...]}` — nestable, sandboxed, no eval. `$div` by zero leaves the field unchanged.
- **Outcomes** make a rule stochastic: `outcomes: [{id, probability, effects}]` with probabilities summing to 1 (compiler-enforced). A rule may use outcomes *instead of* top-level effects.
- The action type is readable as condition field `action` (e.g. `{field:"action", op:"eq", value:"receive_shipment"}`).

### Compliance authoring patterns (from the red-team engagement)

Two patterns earned their place by surviving an adversarial review (`RedTeamTest/report.md`):

- **Set-once status gates.** Any "done" status that enables a reward path must be non-re-enterable: give the enabling rule a precondition on the *pre* state (`invoice_status in ["none","paid"]`, never just `=="dispensed"`), and have the consuming action close the cycle (hospital-billing's `collect_payment` sets `med_status="consumed"`). Otherwise one completion re-arms the reward loop forever.
- **Violation-flag rejections.** A rule-condition no-op is invisible to the agent (`info={}`); to make a forbidden action fail *loudly*, add a priority-N rule that sets a flag field under the forbidden conditions, give the flag schema range `0..1`, and clamp it to `0` with a range constraint — the transition then rejects atomically at `constraint_validation` naming the constraint (legal-filing's `filing_window`).
- **Cross-field counters.** Range constraints are single-field, but a derived audit field (`payment_debt = payments − invoices` via a `{"$sub":[…]}` effect) turns any parity violation into a clamped range breach.

## 5. Rewards

Component expressions are arithmetic over `state.*`, `prevState.*`, `nextState.*`, `action.value`, `action.type`, `action.params.*` — `+ - * /`, parentheses, no functions, no eval. Shape with multiple weighted components (e.g. trading: PnL delta minus quadratic inventory risk minus per-trade activity cost).

## 6. Workflow: spec → graded dossier

```bash
# one command for every pack:
node vendor/node_modules/tsx/dist/cli.mjs rl-engine/testing/pack-pipeline.ts
# or a single pack:
node vendor/node_modules/tsx/dist/cli.mjs rl-engine/testing/pack-pipeline.ts rl-engine/domain-packs/trading-market
```

Pipeline per pack (all generic, zero domain knowledge in the runner):
1. **compile** (§32) and **validate** (§33)
2. **smoke** — scripted mixed-action cycle; every illegal action (unknown type, out-of-range continuous value, wrong multiDiscrete dim arity, illegal dim choice) must be rejected atomically
3. **determinism gate** (§44) — canonical trajectory hash stable across 2 runs per seed
4. **property suite** (§45, P1–P7) — schema bounds, terminal freeze, outcome frequencies, immutability, entity-target resolution
5. **forensic grade** — a scripted episode run is filed as a dossier and graded by the Phase C grader (event-graph causality, replay verification, anti-bluff); must score ≥80 with zero named failures

## 7. The rules of the contract

1. **Never edit `rl-engine/core/` for a domain.** If your spec seems to need it: first fix the spec; if it's a genuine platform gap, record it (below), implement it as a *generic* abstraction, and re-baseline the integrity manifest.
2. **Domain knowledge lives in the spec.** No `if (domain === "trading")` anywhere in the engine — new domains must compile and run with the same primitives the first pack used.
3. **Determinism is part of the contract.** No wall-clock, no `Math.random` — all stochasticity flows through outcomes + the seeded `RandomService`.
4. **Verify you didn't drift:** `node --import tsx rl-engine/testing/core-integrity.ts` — hashes every core file against `domain-packs/core-manifest.json`.

## 8. Engine gap ledger (rule 4B)

| Gap | Files | What was missing | Why platform-level | Pre-fix hashes |
|---|---|---|---|---|
| **GAP-1** | `core/types.ts`, `core/validation.ts` | The DSL declared five action-space kinds but `continuous` and `multiDiscrete` had no `type` discriminator and only type-membership was validated — those two kinds were unaddressable and unvalidatable at runtime. | Any domain with continuous sizing or multi-dimensional selections needs action validation (§5 is a platform concern, not a domain one). Fix: `type` field on both kinds + one `validateActionAgainstSpace` covering all five kinds, shared by the runtime and the compiler. | `types.ts` cf4291f6…, `validation.ts` 3c54f708… |
| **GAP-2** | `core/state.ts` | Effect values were literals — rules could not express state-dependent magnitudes (`cash -= shares × price`), which §31's controlled function registry explicitly anticipates. | Any domain with proportional dynamics (trading fills, logistics transfers, resource flows). Fix: sandboxed declarative `$field/$mul/$add/$sub/$div` value resolution in `applyEffect`; `$div` by zero leaves state unchanged. | `state.ts` 3c3e7ec3… |

Non-core adjustments during Phase D (not gap fixes): reward expressions may reference `action.value`/`action.type` (`reward/reward.ts`); the §33 validator accepts outcome-only rules (`environment/validator.ts`); the benchmark grader scopes hospital-specific compliance/echo checks to same-domain dossiers (`benchmark/grader/grader.ts`). All outside `core/`.
