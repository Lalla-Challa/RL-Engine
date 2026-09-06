#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Harmon Creek Commissioning Benchmark — single-command quickstart.
#
# Runs a FULL grading cycle 100% offline:
#   0. offline readiness check
#   1. reference agent (headless, non-LLM) runs the golden loop over real MCP
#      and files a fresh dossier
#   2. grader scores the filed dossier
#   3. fixture classification: perfect dossier → 100/100, each broken fixture
#      → its exact named failure code
#
# Usage:  ./run_benchmark.sh            (from the workspace root)
#         bash run_benchmark.sh         (any POSIX shell)
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
cd "$(dirname "$0")"

TSX="node_modules/tsx/dist/cli.mjs"
if [ ! -f "$TSX" ]; then
  TSX="vendor/node_modules/tsx/dist/cli.mjs"
fi
if [ ! -f "$TSX" ]; then
  echo "✗ tsx loader not found. One-time toolchain install: npm ci --prefix vendor"
  exit 1
fi
echo "── loader: $TSX"

run() { node "$TSX" "$@"; }

echo ""
echo "═══ [0/3] offline readiness ═══"
run benchmark/scripts/verify-offline.ts

echo ""
echo "═══ [1/3] headless reference agent (real MCP run → dossier) ═══"
run benchmark/scripts/reference-agent.ts benchmark/dossier

echo ""
echo "═══ [2/3] grade the filed dossier ═══"
run benchmark/scripts/grade-dossier.ts benchmark/dossier

echo ""
echo "═══ [3/3] golden fixture classification ═══"
run benchmark/scripts/test-fixtures.ts

echo ""
echo "BENCHMARK CYCLE COMPLETE — dossier graded, fixtures verified."
