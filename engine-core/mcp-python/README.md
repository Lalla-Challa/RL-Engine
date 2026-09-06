# story-vault-mcp

MCP server for **Story Vault** — a local-first writing app. This server lets any
MCP-compatible AI client (Claude Desktop, Cursor, Cline, Qwen Chat, …) read and write
your encrypted Story Vault project data: scenes, actors, environments, systems, ideas,
the main story/manuscript, and project memory.

This is the Python distribution (`uvx story-vault-mcp`). The server itself is a
Node.js program; this package embeds it and launches it for you. **Node.js >= 18 is
required on PATH.**

## Install / run

```sh
uvx story-vault-mcp
```

Or install with pip:

```sh
pip install story-vault-mcp
story-vault-mcp
```

## Configuration

The server needs three environment variables (your vault PIN is used **only** to
decrypt the database and is never exposed to the AI):

| Variable | Required | Purpose |
| --- | --- | --- |
| `STORY_VAULT_PIN` | yes | Your vault PIN. |
| `STORY_VAULT_DATA_DIR` | no | Path to the vault data dir (default `<cwd>/data`). |
| `STORY_VAULT_PROJECT_ID` | no | Default project ID — tools can omit `project_id`. |

### Claude Desktop

Edit `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "story-vault": {
      "command": "uvx",
      "args": ["story-vault-mcp"],
      "env": {
        "STORY_VAULT_PIN": "your-pin",
        "STORY_VAULT_PROJECT_ID": "1",
        "STORY_VAULT_DATA_DIR": "C:/path/to/your/vault/data"
      }
    }
  }
}
```

### Other clients (Cursor, Cline, …)

Use the same `command`/`args`/`env` shape in the client's MCP configuration.

## Tools

78 tools covering the full project surface — see the project's `ARCHITECTURE.md`
("MCP Server (External AI Access)" section) for the complete list. Highlights:

- `list_projects` / `get_project` / `create_project` / `update_project`
- `list_scenes` / `read_scene_content` / `create_scene` / `save_scene_version` (writes prose)
- `list_actors` / `create_actor` / `update_actor`
- `list_environments` / `create_environment` / `list_systems` / `create_system`
- `list_ideas` / `create_idea`
- `get_main_story` / `add_scene_to_story` / `reorder_main_story`
- `list_memory` / `add_memory` / `search_memory`

## Security

- The PIN is consumed only to derive the SQLCipher key (scrypt, N=4096). No tool
  output contains it.
- User metadata, AI provider settings/API keys, and filesystem paths are never returned.
- Every call enforces project ownership against the vault's local user.

## Building from source

```sh
# from the repo root: bundle the Node server and copy it into this package
pnpm build:mcp:npm
cp mcp/npm/dist/index.cjs mcp/python/story_vault_mcp/mcp_server.cjs
cd mcp/python && uv build
```

## HTTP mode (optional)

`story-vault-mcp --http` starts a Streamable HTTP server on `127.0.0.1:3100/mcp`
(port via `STORY_VAULT_PORT`).
