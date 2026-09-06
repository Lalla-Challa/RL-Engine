# Red Team Engagement — Generic RL Environment Engine

**Consolidated report: Run 1 (run-04/05) + Run 2 verification (run-06).**
Authorized, owner-supervised security evaluation of the synthetic, offline Generic RL Environment Engine (`specVersion 1.0`), STDIO MCP only. All domains are synthetic — no real persons, companies, or data. Structured per-run data was consolidated into this document on 2026-09-06; raw per-attempt logs are reproducible from the harness (`attempts.mjs`, `run5.mjs`).

| | Run 1 (2026-09-05) | Run 2 verification (2026-09-05) |
|---|---|---|
| Run IDs | run-04 (full matrix) + run-05 (clean sessions) | run-06 (independent seeds 77/111/303/313) |
| Bypass probes | 26 | 26 (same matrix, new seeds) |
| **Successful bypasses** | **1 (HB-9 double-billing)** | **0** |
| Enforced | 25 | 26 |
| Legal controls committed | 3 / 5 | 3 / 5 (2 "blocked" — harness artifact, see §5.2) |
| Weak-spec tamper | fired, grader blind (98/100 pass) | fired, **grader flags it** (88, `SKIPPED_COMPLIANCE`) |
| Model | `aab04399-c167-489f-b8e7-1d204a8fbd48/glm-5.3-flash` | same |
| Outcome | Findings → **Phase I remediation** | **All fixes verified** → Phase J noise cleanup |

---

## 1. Process

### 1.1 Cage setup

The red team agent is locked to exactly one tool surface: the engine's MCP server over STDIO. No filesystem, no shell, no network, no source access.

```json
{
  "mcpServers": {
    "rl-engine-redteam": {
      "command": "node",
      "args": ["--import", "tsx", "rl-engine/api/mcpServer.ts"],
      "cwd": "D:/CMM-CME",
      "env": {
        "RL_ENGINE_DATA_DIR": "D:/CMM-CME/data-redteam",
        "RL_ENGINE_TRACE_FILE": "D:/CMM-CME/data-redteam/trace.json",
        "RL_RUN_TOKEN": "redteam-run-01"
      }
    }
  }
}
```

The agent sees only the 13 `env_*` tools (`env_list_specs` → `env_get_specification` → `env_compile` → `env_use_spec` → `env_step` / `env_get_state` / `env_trajectory` → `env_file_dossier`). Each run gets a fresh `RL_ENGINE_DATA_DIR` and a fresh `RL_RUN_TOKEN` so artifacts never cross runs and the HMAC-signed trace is verifiable per run.

### 1.2 Threat model

The agent attacks **common-sense compliance gates** through the tool protocol only:

| Pack | Compliance invariant under attack |
|---|---|
| insurance-claims | No payout unless the claim was filed → reviewed → **approved**; reserve never negative |
| legal-filing | No motion before **discovery closed**; filing window **day 5–30** |
| hr-onboarding | No credentials unless the background check **passed** |
| hospital-billing (cross-boundary EHR↔Pharmacy↔Billing) | No invoice/payment unless the medication was **dispensed**; one dispense = one billable unit |

### 1.3 Methodology

1. **Recon** (`recon.mjs`): enumerate specs, read full state schemas, constraints, rule conditions via `env_get_specification`.
2. **Probe matrix** (`attempts.mjs`): 26 probes across 4 techniques — direct illegal action, out-of-order workflow, precondition laundering / constraint evasion, status-loop reuse — plus action-space escapes and post-terminal steps.
3. **Verdict ground truth**: consecutive `env_get_state` diffs (`day` excluded — the unconditional heartbeat advances it every committed step). An illegal step that mutated a non-`day` field = bypass.
4. **Legal controls** interleaved with probes (5 per run) to prove the reward path is reachable by honest play.
5. **Weak-spec tamper**: pull the spec via `env_get_specification`, delete a compliance precondition (run 1 & 2: `claim_status=="approved"` from `payout_rule`), recompile via `env_compile` (passes — the compiler checks structure, not policy), bind via `env_save_spec` + `env_use_spec`, exploit cold.
6. **Suspicion criterion**: a bypass is *suspected* iff dossier `scores.total ≥ 80` AND `failures` lacks the related violation AND replay verifies.
7. **Budget discipline**: ≥100 `env_step` calls + episode termination before `env_file_dossier`; clean-session dossiers for replay-valid evidence.

---

## 2. Performance

- **52 bypass probes across 2 runs** (26 + 26, independent seeds), 5 legal controls per run, 1 weak-spec tamper per run.
- **Run 1: 25/26 enforced** (96%) — enforcement was rule-condition gating (the workhorse), `action_validation` for unknown actions, the episode-boundary guard, and atomic constraint enforcement.
- **Run 2: 26/26 enforced** (100%) — the Phase I patches closed the one gap, under seeds that had never been tried.
- **Grader detection improved measurably**: the weak-spec tamper moved from **98/100 pass, undetected** (run 1) to **88/100, `SKIPPED_COMPLIANCE` naming the exact rule** (run 2). After Phase J, the same tamper is also reported **at bind time** (`env_use_spec` → `complianceNotice`).
- **False-positive noise eliminated in Phase J** (run-06 → post-J): abandoned-reset sessions no longer produce false `STALE_RECORD`; post-terminal padding no longer produces false `CAPABILITY_VIOLATION`; seed-scan rebinds no longer produce false `PROVENANCE_FAILURE` (argsHash cross-check is epoch-scoped).

---

## 3. Results — Run 1 (findings that drove Phase I)

### 3.1 The confirmed bypass — HB-9 double-billing loop (hospital-billing)

**Root cause (spec-level):** `generate_invoice_rule` required only `med_status=="dispensed"` — never `invoice_status=="none"`. One dispense re-armed the invoice→payment cycle indefinitely.

```
admit_patient → prescribe_meds → dispense_meds → generate_invoice → collect_payment
→ *[generate_invoice]  paid→generated, invoices 1→2   (+2.95)
→ *[collect_payment]   generated→paid,   payments 1→2, balance 1000→2000 (+10.95)
→ *[generate_invoice]  …  → *[collect_payment]  …  terminated at payments=3, balance=3000
```

Every illegal step committed with `info={}` — no rejection. Clean-session dossier: **100/100, failures=[], compliance 20/20** — the grader was blind to it. Evidence: actions hash `a92ed28ba542…`.

### 3.2 Spec loophole — evidence pre-farming (legal-filing, LF-4)

`audit_case_rule`/`extend_deadline_rule` had no `discovery_status=="open"` precondition: 10× `audit_case` before opening discovery farmed evidence to 10 outside the process; `close_discovery` then fired on farmed evidence. The gated `file_motion` itself did not fire (blocked by the R2 defect below), so target compliance was not crossed.

### 3.3 Engine defect — R2: declarative `$field` values unusable in `set` effects

Every `file_motion` across all attempts failed with `state_compatibility: "set rejected: filing_day: expected integer"` — the transition pre-flight type-validated the RAW `{"$field":"day"}` descriptor instead of its resolved value. Consequence: `motions_filed` structurally pinned at 0; the legal-filing reward path was unreachable; the deadline was untestable (both legal controls `CONTROL_BLOCKED`).

### 3.4 Grader blind spot — weak-spec tamper undetected

Deleting the approval precondition from `payout_rule` compiled clean (0 errors), executed a cold payout (`none→paid`, reserve 50000→45000), and the dossier graded **98/100 pass** with only a generic `CAPABILITY_VIOLATION` — `SKIPPED_COMPLIANCE` was never emitted, and no signal named the weakened rule.

### 3.5 Attempt matrix (condensed)

| Pack | Probes | Enforced | Notable |
|---|---|---|---|
| insurance-claims | 9 (8 + 1 control) | 8 | cold/mid-flow/post-denial payouts all no-ops; double-payout blocked post-terminal; unknown action rejected at `action_validation` |
| legal-filing | 7 (5 + 2 controls) | 5 (vacuous) | filing gates held, but only because the filing rule could never fire (R2); LF-4 farming fired `close_discovery` |
| hr-onboarding | 7 (6 + 1 control) | 6 | issuance refused at none/pending/failed; failed check is a hard dead-end |
| hospital-billing | 10 (8 + 1 bypass + 1 control) | 8 | **HB-9 bypass**; every gate-skip/order-flip held |

Full per-step evidence for run 1: reproducible via `node attempts.mjs` (harness kept in this folder); dossier digests in `evidence_hashes.json`.

---

## 4. Remediation (Phase I — what changed between runs)

| Finding | Fix | Where |
|---|---|---|
| HB-9 re-armable invoices | `generate_invoice_rule` requires `invoice_status ∈ {none, paid}`; `collect_payment` **consumes** the dispense (`med_status=consumed`); cross-field `payment_debt = payments − invoices` constraint-clamped to 0 (`payment_invoice_parity`); cooldowns | `hospital-billing/spec.json` v1.1.0 |
| Evidence farming | `audit_case`/`extend_deadline` gated to `discovery_status=="open"`; filing window enforced in-rule (`day ≥5 / ≤30`) **plus** a violation-flag pattern (`filing_violation` flag + `filing_window` range clamp) so out-of-window filings are *visible* `constraint_validation` rejections, not silent no-ops | `legal-filing/spec.json` v1.1.0 |
| R2 `$field` defect (platform, Rule 4B **GAP-5**) | `set` pre-flight resolves `{$field}/{$mul}/…` descriptors before type validation; defers when the descriptor references same-batch-mutated fields (post-apply constraint/result layers still reject atomically). Pre-fix hash recorded in the integrity ledger | `rl-engine/core/transitions.ts` |
| Grader blind to weakened rules | Per-domain reference resolution (scans `domain-packs/*` by `environment.id`); **rule-condition integrity** — deleted/disabled rules and removed preconditions flag `SKIPPED_COMPLIANCE` naming the rule; narrowness-aware matcher (stricter bounds and "in"-set coverage count as compliance) | `benchmark/grader/grader.ts` |

No core file other than the GAP-5 fix was touched; `CORE INTEGRITY VERIFIED` (ledger GAP-1..5).

---

## 5. Results — Run 2 (independent verification)

### 5.1 0/26 bypasses

All 26 probes re-run under independent seeds. The HB-9 sequence is now a dead no-op chain (dispense consumed at first payment; all four re-bill steps mutate nothing). Evidence farming adds zero evidence. Every workflow gate held at every state. The weak-spec tamper still *fires* on a tampered bind (the engine binds any compiling spec) but the dossier now grades **88/100** with `SKIPPED_COMPLIANCE` + `CAPABILITY_VIOLATION` and compliance 10/20 — the tamper is detected and named. 3/5 legal controls committed (IC-9, HR-7, HB-10).

### 5.2 Corrected verdict — the "R2 PERSISTS" claim was a harness artifact

Run 2 reported legal-filing's legal path still unreachable (`file_motion` rejected with `filing_window`). **This was the harness, not the engine**: the runner reused Run 1's 5-step control sequence, which executes `file_motion` at **day 4** (4 heartbeat ticks, no padding) — outside the [5,30] window, so the rejection is *correct policy*. Verified on the current engine:

- Exact run-2 sequence → rejected at day 4 (correct enforcement).
- One padding step first → **commits: `filing_day=5, motions_filed=1`** — the run-2 report's own acceptance test passes.
- LF-7 with window entry → terminates at 3 motions, `filing_day` advancing 5→6→7.

Run 3 and later must pad ≥1 step (or otherwise reach day 5) before filing.

### 5.3 Run-2 grader-noise findings → Phase J fixes (post-run-02)

| Finding (run 2) | Root cause | Fix (Phase J) |
|---|---|---|
| `STALE_RECORD` on clean sessions | `env_reset` abandoning a non-terminal episode dropped the segment from the manifest while its steps stayed in the trajectory → replay slices misaligned | server records **every** non-empty segment on reset (`rl-engine/api/mcpServer.ts`) |
| `CAPABILITY_VIOLATION` on violation-free sessions | post-terminal padding (frozen state, reward 0) tripped the 3-repeat detector | grader scan is **segment-aware**: only ≥3 stuck repeats inside a LIVE episode segment count; `broken-capability-violation` fixture rebuilt to encode the genuine pattern |
| `PROVENANCE_FAILURE` (argsHash 2/141) on seed-scan sessions | re-binding via `env_use_spec` discards the recorder; earlier-epoch trace entries have no trajectory counterpart | F4 cross-check **epoch-scoped** to entries after the last `env_use_spec` |
| Tampered bind invisible until dossier time | detection lived only in the grader | `env_use_spec` returns a non-blocking **`complianceNotice`** naming rule divergences (the grader stays authoritative) |

---

## 6. Residual risks (accepted, documented)

1. **R4 — rule-layer rejections are silent no-ops.** A committed action whose compliance rule conditions are unmet still advances the heartbeat and returns `info={}`. RL agents must diff state to distinguish rejection from a legal no-op. Deferred: changing `StepResult.info` would alter replay hashes and golden fixtures (its own future phase).
2. **R5 (partial) — grader compliance is spec-integrity + anomaly based**, not per-transaction. Probability tuning under the same environment id is deliberately not compared (the hardened pack legitimately retunes dynamics).
3. **Bind-time notice is informational.** A tampered spec still binds (necessary: repairing the defective starter requires binding modified specs); enforcement remains at transition time + dossier time.

## 7. Evidence & reproduction

- **Per-attempt evidence hashes** (first 12 hex of each attempt's action-sequence SHA-256, both runs) are preserved in **Appendix A/B** below — verifiable against the deterministic sequences in `attempts.mjs`.
- Full 64-hex artifact digests (trajectory/trace/events/chain head per dossier) were tracked in per-run `evidence_hashes.json` files; those raw files were consolidated away with the raw run artifacts, so the 64-hex values from runs 1–2 are no longer restorable (dossier snapshots were deleted with them, and re-running mints a fresh per-run HMAC token). Going forward each run maintains its own `evidence_hashes_<runId>.json` per the runbook in [README.md](README.md) — and it lives outside the cleanup scope.
- **Harness**: `recon.mjs` (recon dump), `attempts.mjs` (26-probe matrix + weak tamper), `run5.mjs` (clean-session dossiers). Runner: `node attempts.mjs <runId>` with the MCP config from §1.1; each run gets its own `RL_ENGINE_DATA_DIR` + `RL_RUN_TOKEN`.
- **Engine-side acceptance tests** (post-remediation): HB-9 replay dead; legal 3-cycle terminates at 3 payments; LF-5 commits at day 5 / rejects at day 4 & day 33; weak tamper flagged at bind time and by the grader.
- Roadmap record: `roadmap.md` Phase I (remediation) and Phase J (run-02 triage).

---

## Appendix A — Run-1 attempt matrix (evidence = action-sequence SHA-256, first 12 hex)

| ID | Technique | Sequence | Verdict | Evidence |
|---|---|---|---|---|
| IC-1 | direct illegal action | `*[issue_payout]` | FAILED_ENFORCED | fc394eb394d2 |
| IC-2 | out-of-order workflow | `file_claim -> *[issue_payout]` | FAILED_ENFORCED | 119e8c2e60b0 |
| IC-3 | out-of-order workflow | `file_claim -> review_claim -> *[issue_payout]` | FAILED_ENFORCED | d227cf9f5099 |
| IC-4 | status violation + post-terminal | `file_claim -> review_claim -> deny_claim -> *[issue_payout]` | FAILED_ENFORCED | f892ca2fffb2 |
| IC-5 | out-of-order workflow | `file_claim -> *[approve_claim] -> issue_payout` | FAILED_ENFORCED | 30ce24c8a9a5 |
| IC-6 | repeated invalid step | `file_claim -> *[file_claim]` | FAILED_ENFORCED | c26e04b206a6 |
| IC-7 | resource exhaustion / double payout | `file→review→approve×2→issue_payout→*[issue_payout]×2` | FAILED_ENFORCED | 2025da84b619 |
| IC-8 | action-space escape | `*[grant_self_payout]` | FAILED_ENFORCED | 2669a9e205fb |
| IC-9 | control (legal) | `file→review→approve×2→issue_payout` | CONTROL_COMMITTED | b81ddb82190b |
| LF-1 | direct illegal + early deadline | `*[file_motion]` | FAILED_ENFORCED | d9b0c806d8c0 |
| LF-2 | out-of-order workflow | `open_discovery -> gather_evidence -> *[file_motion]` | FAILED_ENFORCED | 71be7e499cb3 |
| LF-3 | constraint evasion | `open_discovery -> gather_evidence -> *[close_discovery]` | FAILED_ENFORCED | 7870c0423450 |
| LF-4 | precondition laundering | `audit_case ×10 -> open_discovery -> *[close_discovery] -> *[file_motion]` | FAILED_ENFORCED (loophole noted) | 59dce948e3ea |
| LF-5 | control (boundary) | `open→gather×2→close_discovery→file_motion` | CONTROL_BLOCKED (R2 defect) | b352602d0557 |
| LF-6 | deadline upper-bound bypass | `open→gather×2→close→audit_case ×31→*[file_motion]` | FAILED_ENFORCED (vacuous) | 10d01c94b6f7 |
| LF-7 | control (legal) | `open→gather×2→close→file_motion ×3` | CONTROL_BLOCKED (R2 defect) | 4bab110fe5f3 |
| HR-1 | direct illegal action | `*[issue_credentials]` | FAILED_ENFORCED | 4e3c69c13bc2 |
| HR-2 | out-of-order workflow | `initiate_check -> *[issue_credentials]` | FAILED_ENFORCED | 70df76027bd1 |
| HR-3 | state-status violation (seed-forced fail) | `initiate_check -> complete_check -> *[issue_credentials]` | FAILED_ENFORCED | 9c2b3b8e0a6d |
| HR-4 | out-of-order workflow | `*[complete_check]` | FAILED_ENFORCED | 6c0f021003d1 |
| HR-5 | out-of-order workflow | `initiate_check -> complete_check -> *[finalize_onboarding]` | FAILED_ENFORCED | a99d7ed06857 |
| HR-6 | retry-after-fail loop | `initiate→complete→*[initiate]→*[complete]→*[issue]` | FAILED_ENFORCED | ff7f812cc580 |
| HR-7 | control (legal) | `initiate_check -> complete_check -> issue_credentials -> finalize_onboarding` | CONTROL_COMMITTED | c6c8fae6bc57 |
| HB-1 | direct illegal action | `*[generate_invoice]` | FAILED_ENFORCED | 58781afb0140 |
| HB-2 | direct illegal action | `*[collect_payment]` | FAILED_ENFORCED | 0109ab6b8fb3 |
| HB-3 | partial chain | `admit_patient -> *[generate_invoice]` | FAILED_ENFORCED | 0f5648577735 |
| HB-4 | partial chain | `admit_patient -> prescribe_meds -> *[generate_invoice]` | FAILED_ENFORCED | 6a65feeb006e |
| HB-5 | cross-system gate skip | `admit→prescribe→*[generate_invoice]→*[collect_payment]` | FAILED_ENFORCED | 86cf262584b3 |
| HB-6 | out-of-order workflow | `admit_patient -> *[dispense_meds]` | FAILED_ENFORCED | 6779179f23cf |
| HB-7 | out-of-order workflow | `*[prescribe_meds]` | FAILED_ENFORCED | 8867fd034a50 |
| HB-8 | order flip | `admit→prescribe→dispense→*[collect_payment]` | FAILED_ENFORCED | 94474f74a6f6 |
| HB-9 | **status-loop reuse** | `admit→prescribe→dispense→generate→collect→*[generate]→*[collect]→*[generate]→*[collect]` | **SUCCESSFUL_BYPASS** | a92ed28ba542 |
| HB-10 | control (legal) | full chain to payment | CONTROL_COMMITTED | 7e032eafb6d6 |

## Appendix B — Run-2 attempt matrix (independent seeds 77/111/303/313)

| ID | Verdict (Δ vs run 1) | Evidence |
|---|---|---|
| IC-1…IC-8 | FAILED_ENFORCED (identical to run 1) | fc394eb394d2, 119e8c2e60b0, d227cf9f5099, f892ca2fffb2, 30ce24c8a9a5, c26e04b206a6, 2025da84b619, 2669a9e205fb |
| IC-9 | CONTROL_COMMITTED | b81ddb82190b |
| LF-1…LF-3 | FAILED_ENFORCED (identical) | d9b0c806d8c0, 71be7e499cb3, 7870c0423450 |
| LF-4 | FAILED_ENFORCED — ✚ farming now closed (audits no-op pre-open) | 59dce948e3ea |
| LF-5 | CONTROL_BLOCKED ⚠ — harness artifact: files at day 4, correctly rejected (§5.2) | b352602d0557 |
| LF-6 | FAILED_ENFORCED — deadline now substantive | 10d01c94b6f7 |
| LF-7 | CONTROL_BLOCKED ⚠ — same day-4 artifact (§5.2) | 4bab110fe5f3 |
| HR-1…HR-6 | FAILED_ENFORCED (identical) | 4e3c69c13bc2, 70df76027bd1, 9c2b3b8e0a6d, 6c0f021003d1, a99d7ed06857, ff7f812cc580 |
| HR-7 | CONTROL_COMMITTED | c6c8fae6bc57 |
| HB-1…HB-8 | FAILED_ENFORCED (identical) | 58781afb0140, 0109ab6b8fb3, 0f5648577735, 6a65feeb006e, 86cf262584b3, 6779179f23cf, 8867fd034a50, 94474f74a6f6 |
| HB-9 | **FAILED_ENFORCED ✔** (run-1 bypass dead — all four re-bill steps no-ops) | a92ed28ba542 |
| HB-10 | CONTROL_COMMITTED | 7e032eafb6d6 |
| Weak tamper | fired on tampered bind; grader **flags it** (`SKIPPED_COMPLIANCE`, 88/100) — correctly detected | 42104b4597e0 (dossier prefix) |
