"""Story Vault MCP server — Python launcher.

A thin wrapper that runs the `story-vault-mcp` Node.js server. Strategy:

1. Fast path: spawn `node.exe` directly on the globally-installed npm package
   (`<npm global>/node_modules/story-vault-mcp/dist/server.cjs`). No npx, no
   cmd.exe, no registry lookup — immune to broken PATH environments.
2. Fallback: `npx --yes --package story-vault-mcp story-vault-mcp`.

Requires Node.js >= 18.

Environment note: MCP clients (e.g. Qwen Studio) may spawn this process with
a Unix-style `PATH` but keep the real Windows search list in `Path`. We check
both, plus common install locations, so `node.exe` is always found.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys


def _path_candidates() -> list[str]:
    """Gather PATH-like search directories from PATH, Path, and defaults."""
    dirs: list[str] = []
    for key in ("PATH", "Path"):
        val = os.environ.get(key)
        if val:
            sep = ";" if os.name == "nt" else ":"
            for d in val.split(sep):
                if d and d not in dirs:
                    dirs.append(d)
    return dirs


def _find_binary(name: str) -> str | None:
    """Locate a binary (e.g. node, npx) via PATH, Path, and install dirs."""
    override = os.environ.get("STORY_VAULT_NODE")
    if override and os.path.exists(override):
        return override

    for d in _path_candidates():
        exts = [""] if os.name != "nt" else [".exe", ".cmd", ".bat"]
        for ext in exts:
            p = os.path.join(d, name + ext)
            if os.path.exists(p):
                return p

    candidates = [
        "C:\\Program Files\\nodejs",
        os.path.join(os.environ.get("ProgramFiles", "C:\\Program Files"), "nodejs"),
        os.path.join(os.environ.get("LOCALAPPDATA", ""), "Programs", "nodejs"),
    ]
    for base in candidates:
        if not base:
            continue
        for ext in ([".exe", ".cmd", ".bat"] if os.name == "nt" else [""]):
            p = os.path.join(base, name + ext)
            if os.path.exists(p):
                return p
    return None


def _global_server_path() -> str | None:
    """Locate the globally-installed npm package's server bundle."""
    if os.name != "nt":
        return None
    npm_global = os.path.join(os.environ.get("APPDATA", ""), "npm", "node_modules")
    p = os.path.join(npm_global, "story-vault-mcp", "dist", "server.cjs")
    if os.path.exists(p):
        return p
    return None


def _find_npx() -> str:
    npx = _find_binary("npx")
    if not npx:
        node = _find_binary("node")
        if node:
            node_dir = os.path.dirname(os.path.realpath(node))
            for name in ("npx", "npx.cmd", "npx.bat"):
                p = os.path.join(node_dir, name)
                if os.path.exists(p):
                    npx = p
                    break
    if not npx:
        sys.stderr.write(
            "story-vault-mcp requires Node.js >= 18 (with npx).\n"
            "Install Node.js (https://nodejs.org) and ensure it is on PATH,\n"
            "or set STORY_VAULT_NODE to the full path of node.exe.\n"
        )
        sys.exit(1)
    return npx


def main() -> int:
    # Fast path: node.exe directly on the global npm install — no npx/cmd hops.
    node = _find_binary("node")
    server = _global_server_path()
    if node and server:
        proc = subprocess.Popen(
            [node, server, *sys.argv[1:]],
            stdin=sys.stdin,
            stdout=sys.stdout,
            stderr=sys.stderr,
        )
        try:
            return proc.wait()
        except KeyboardInterrupt:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
            return 130

    # Fallback: npx from the registry.
    npx = _find_npx()
    spec = os.environ.get("STORY_VAULT_NPM_PACKAGE", "story-vault-mcp")
    cmd = [npx, "--yes", "--package", spec, "story-vault-mcp", *sys.argv[1:]]
    if os.name == "nt" and npx.lower().endswith((".cmd", ".bat")):
        cmd = ["cmd.exe", "/c", *cmd]
    proc = subprocess.Popen(cmd, stdin=sys.stdin, stdout=sys.stdout, stderr=sys.stderr)
    try:
        return proc.wait()
    except KeyboardInterrupt:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
        return 130


if __name__ == "__main__":
    sys.exit(main())
