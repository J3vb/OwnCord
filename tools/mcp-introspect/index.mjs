#!/usr/bin/env node
// OwnCord introspection MCP server (dev tool for Claude Code).
//
// Exposes two tools over stdio:
//   api_request  — full read-write passthrough to any OwnCord REST endpoint
//   server_logs  — the admin ring-buffer log stream (SSE ticket -> stream)
//
// The desktop client's log file is an ordinary file at
// %LOCALAPPDATA%\com.owncord.client\logs\owncord-client.log — read it with
// Read/Grep rather than through a tool that duplicates them.
//
// Auth: a long-lived OwnCord API token in OWNCORD_API_TOKEN, sent as a bearer
// header (mint one with `server token create --label mcp-introspect`).
// TLS: pins the server's self-signed cert (Server/data/cert.pem). The cert has
// no SAN, so hostname verification is intentionally skipped — identity is proven
// by the pin.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient, MAX_FOLLOW_MS } from "./transport.mjs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// tools/mcp-introspect -> repo root
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const TOKEN = process.env.OWNCORD_API_TOKEN || "";
const CERT_PATH = process.env.OWNCORD_CERT_PATH || join(REPO_ROOT, "Server", "data", "cert.pem");

// Base URL: explicit override, else https://127.0.0.1:<server.port from config.yaml>.
function readServerPort() {
  try {
    const text = readFileSync(join(REPO_ROOT, "Server", "config.yaml"), "utf8");
    // Scope to the top-level `server:` block so we don't grab a voice/livekit port.
    const m = text.match(/^server:\s*$[\s\S]*?^\s+port:\s*(\d+)/m);
    if (m) return Number(m[1]);
  } catch {
    /* fall through to default */
  }
  return 8443;
}
const BASE_URL = process.env.OWNCORD_BASE_URL || `https://127.0.0.1:${readServerPort()}`;

const { request, collectLogs } = createClient({
  baseUrl: BASE_URL,
  token: TOKEN,
  certPath: CERT_PATH,
});

function requireToken() {
  if (!TOKEN)
    throw new Error("OWNCORD_API_TOKEN is not set - mint one with `server token create`.");
}

const server = new McpServer({ name: "owncord-introspect", version: "0.1.0" });
const ok = (obj) => ({ content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] });
const fail = (e) => ({ content: [{ type: "text", text: String(e?.message || e) }], isError: true });

server.registerTool(
  "api_request",
  {
    description:
      "Read-write passthrough to any OwnCord REST endpoint (/api/v1/*, /admin/api/*, plugins). " +
      "Returns {status, headers, body}. Any HTTP method is allowed, including destructive admin routes.",
    inputSchema: {
      method: z.string().describe("HTTP method: GET, POST, PATCH, PUT, DELETE"),
      path: z.string().describe("Path beginning with / (e.g. /admin/api/stats) or a full URL"),
      query: z.record(z.string(), z.string()).optional().describe("Query params"),
      body: z.any().optional().describe("JSON body (object or string)"),
      headers: z.record(z.string(), z.string()).optional().describe("Extra request headers"),
    },
  },
  async (a) => {
    try {
      requireToken();
      return ok(await request(a.method, a.path, a));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "server_logs",
  {
    description:
      "Fetch the server's in-memory ring-buffer logs (SSE backfill, optionally follow). " +
      "Each record is {ts, level, msg, source, attrs}. Filters by level/source and applies a limit.",
    inputSchema: {
      level: z.string().optional().describe("DEBUG | INFO | WARN | ERROR"),
      source: z
        .string()
        .optional()
        .describe("websocket|http|admin|auth|database|storage|updater|config|server"),
      limit: z.number().int().positive().optional().describe("Max records to return (default 500)"),
      follow_ms: z
        .number()
        .int()
        .nonnegative()
        .max(MAX_FOLLOW_MS)
        .optional()
        .describe("0 = backfill only (default); >0 keeps streaming that long"),
    },
  },
  async (a) => {
    try {
      requireToken();
      return ok(await collectLogs(a));
    } catch (e) {
      return fail(e);
    }
  },
);

await server.connect(new StdioServerTransport());
