@echo off
rem ─────────────────────────────────────────────────────────────────────────────
rem Harmon Creek Commissioning Benchmark — single-command quickstart (Windows).
rem Runs the same full grading cycle as run_benchmark.sh, 100% offline.
rem ─────────────────────────────────────────────────────────────────────────────
setlocal
cd /d "%~dp0"

set "TSX=node_modules\tsx\dist\cli.mjs"
if not exist "%TSX%" set "TSX=vendor\node_modules\tsx\dist\cli.mjs"
if not exist "%TSX%" (
  echo tsx loader not found. Run: cd vendor ^&^& npm install --offline
  exit /b 1
)
echo -- loader: %TSX%

echo.
echo === [0/3] offline readiness ===
node "%TSX%" benchmark\scripts\verify-offline.ts || goto :fail

echo.
echo === [1/3] headless reference agent (real MCP run -^> dossier) ===
node "%TSX%" benchmark\scripts\reference-agent.ts benchmark\dossier || goto :fail

echo.
echo === [2/3] grade the filed dossier ===
node "%TSX%" benchmark\scripts\grade-dossier.ts benchmark\dossier || goto :fail

echo.
echo === [3/3] golden fixture classification ===
node "%TSX%" benchmark\scripts\test-fixtures.ts || goto :fail

echo.
echo BENCHMARK CYCLE COMPLETE — dossier graded, fixtures verified.
exit /b 0

:fail
echo BENCHMARK CYCLE FAILED
exit /b 1
