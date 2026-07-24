# owncord-introspect (MCP dev tool)

A small [MCP](https://modelcontextprotocol.io) server that lets Claude Code introspect a **locally
running** OwnCord instance. Three tools:

| Tool | What it does |
|------|--------------|
| `api_request` | Read-write passthrough to any OwnCord REST endpoint (`/api/v1/*`, `/admin/api/*`). |
| `server_logs` | The server's in-memory ring-buffer logs (admin SSE ticket→stream). |
| `client_logs` | Tails the desktop client's on-disk log file. |

## Quickstart

```bash
# 1. install
cd tools/mcp-introspect && npm install

# 2. mint a token (prints it once)
cd ../../Server && ./server.exe token create --label mcp-introspect

# 3. set it, then restart Claude Code
setx OWNCORD_API_TOKEN <paste-token>
```

`owncord-introspect` is already enabled in `.claude/settings.local.json`.

## Full documentation

See **[`docs/mcp-introspect.md`](../../docs/mcp-introspect.md)** for how it works (auth, cert
pinning, the log-stream flow), the complete tool reference, configuration, troubleshooting, and
security notes.
