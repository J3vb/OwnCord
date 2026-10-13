# owncord-introspect (MCP dev tool)

A small [MCP](https://modelcontextprotocol.io) server that lets Claude Code look
inside a **locally running** OwnCord server. It is a development tool, not part
of the product. It has two tools:

| Tool          | What it does                                                                            |
| ------------- | --------------------------------------------------------------------------------------- |
| `api_request` | Read-write passthrough to any OwnCord REST endpoint (`/api/v1/*`, `/admin/api/*`)       |
| `server_logs` | The server's in-memory log buffer, read through the admin log stream (ticket, then SSE) |

## Quickstart

Needs Node 26.

```bash
# 1. Install
cd tools/mcp-introspect && npm install

# 2. Create a token (it is printed once)
cd ../../Server && ./chatserver.exe token create --label mcp-introspect

# 3. Set it (Windows), then restart Claude Code
setx OWNCORD_API_TOKEN <paste-token>
```

4. Register the server in your local `.mcp.json` and allow it in
   `.claude/settings.local.json`. Both files are gitignored, so each developer
   creates their own. The full guide has an example.

## Full documentation

See **[`docs/mcp-introspect.md`](../../docs/mcp-introspect.md)**. It covers how
the tool works (auth, certificate pinning, the log-stream flow), the full tool
reference, configuration, troubleshooting and security notes.
