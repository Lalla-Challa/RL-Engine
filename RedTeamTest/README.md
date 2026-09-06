# RedTeamTest — harness for the engine's authorized red-team engagement

The full process, performance numbers, and results of both runs live in **[report.md](report.md)**. This folder keeps only what is needed to reproduce a run or audit its evidence.

## Layout

```
report.md                    ← consolidated process/performance/results (read this first)
evidence_hashes.json         ← run-1 dossier digests (8 dossiers: SHA-256 + HMAC chain heads)
evidence_hashes_run-06.json  ← run-2 dossier digests
recon.mjs                    ← recon pass: dump specs/state schemas via MCP
attempts.mjs                 ← 26-probe matrix + weak-spec tamper (node attempts.mjs <runId>)
run5.mjs                     ← clean-session dossier builder (replay-valid evidence)
```

## Running an engagement

1. Configure the MCP server (config in report.md §1.1) with a **fresh** `RL_ENGINE_DATA_DIR` (e.g. `data-redteam-03`) and a fresh `RL_RUN_TOKEN` (e.g. `redteam-run-03`).
2. `node recon.mjs` → recon dump; `node attempts.mjs <runId>` → full probe matrix + tamper; `node run5.mjs <runId>` → clean-session dossiers.
3. Dossier snapshots land in `<repo>/redteam_dossier_<runId>_*` — digest them into a new `evidence_hashes_<runId>.json`, write the run report, then delete the snapshot dirs (keep the digests).
4. **Known harness requirement**: legal-filing controls must reach day 5 before `file_motion` (pad ≥1 step) — filing at day 4 is correctly rejected by the `filing_window` policy (report.md §5.2).

Rules of engagement: caged to the 13 `env_*` tools, no filesystem/shell/network, verdicts from `env_get_state` diffs (`day` excluded), bypass = illegal step mutating a non-`day` field.
