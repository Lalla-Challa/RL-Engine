# Harmon Creek HARD — Hardened Variant (Phase H, audit F3)

**What changed vs the standard pack:** the environment has a **hidden parameter** — `budget`, `visibility: "hidden"`. It drains 1.5/step, resets to 100 at 0 (≈67-step cycle), and while it is below 25 an incident storm fires at p=0.5/step (each incident costs −2 reward). Combined with admits succeeding only 70% of the time and continuous supply depletion, **the value of any policy is non-stationary in a way no occupancy-keyed agent can observe.**

## Why this is the difficulty certificate

The audit's finding F3 asked for *measured* difficulty, not vibes. The certificate is the Phase F learning demo's validation curve run against this pack:

```bash
node --import tsx rl-engine/testing/learning-demo.ts \
  --spec rl-engine/domain-packs/harmon-creek-hard/spec.json \
  --cert rl-engine/domain-packs/harmon-creek-hard/difficulty-certificate.json
```

`difficulty-certificate.json` records the result: the validation curve swings between roughly −1330 and +86 across the standard 240-episode budget and never plateaus (range ≈ 1400; the standard pack plateaus at a flat 856.0 from episode 24). A tabular agent keyed on the visible state cannot model the hidden regime — the same argument extends to a frontier model that plans over the declared spec: the declared spec is not the whole environment. That is the point.

## The defective starter

`benchmark/scenario/spec-hard-starter.json` layers three defect classes:

1. **Compiler-level** (3): unknown targets `entity:Wrad_A`, `entity:Logistix`, `rel:finn-keal` — caught by `env_compile`.
2. **Runtime-only** (3): `admit_rule` sets `ward_occupancy` to the *string* `"full"` (state_compatibility), `discharge_rule` sets it to 15 (result_validation against the schema max), `capacity_boost` adds 20 (constraint_validation) — invisible until the compile-level defects are fixed and the loop starts running.
3. **The decoy**: `capacity_boost` makes `ward_occupancy` overshoot 12 on every `audit`. The *naive* fix is to weaken the `ward_capacity` constraint to max 32 — which the grader flags as `SKIPPED_COMPLIANCE`. The correct fix is to disable/correct the rule, not to weaken compliance.

## Grading

Same grader, same 100-point rubric, same provenance requirements — no fork. The hardened dossier chain is: fix starter → run ≥100 signed `env_step` calls → reach a terminal state (occupancy 12) → file with provenance.

## Bounds

The certificate certifies difficulty *for stateless/tabular policies on visible state*; it is evidence of hidden-regime non-stationarity, not a proof that no model can master the variant. Frontier models with memory can in principle detect the cycle — that residual gap is what evaluation runs measure.
