#!/usr/bin/env node
// OwnCord introspection MCP server (dev tool for Claude Code).
//
// Exposes three tools over stdio:
//   api_request  — full read-write passthrough to any OwnCord REST endpoint
//   server_logs  — the admin ring-buffer log stream (SSE ticket -> stream)
//   client_logs  — tail the desktop client's on-disk log file
//
// Auth: a long-lived OwnCord API token in OWNCORD_API_TOKEN, sent as a bearer
// header (mint one with `server token create --label mcp-introspect`).
// TLS: pins the server's self-signed cert (Server/data/cert.pem). The cert has
// no SAN, so hostname verification is intentionally skipped — identity is proven
// by the pin.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import https from "node:https";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// tools/mcp-introspect -> repo root
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const TOKEN = process.env.OWNCORD_API_TOKEN || "";
const CERT_PATH = process.env.OWNCORD_CERT_PATH || join(REPO_ROOT, "Server", "data", "cert.pem");
const CLIENT_LOG =
  process.env.OWNCORD_CLIENT_LOG ||
  join(process.env.LOCALAPPDATA || "", "com.owncord.client", "logs", "owncord-client.log");

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

// Lazily built so client_logs works even when the cert/server is absent. Only
// https bases need the pinned agent; an http override (rare) uses none.
let _agent;
function httpsAgent() {
  if (!BASE_URL.startsWith("https:")) return undefined;
  if (_agent) return _agent;
  let ca;
  try {
    ca = readFileSync(CERT_PATH);
  } catch {
    throw new Error(
      `OwnCord cert not found at ${CERT_PATH}. Start the server once to generate it, ` +
        `or set OWNCORD_CERT_PATH (or OWNCORD_BASE_URL for a non-TLS endpoint).`,
    );
  }
  // Pin the exact self-signed cert; skip hostname check (the cert has no SAN).
  _agent = new https.Agent({ ca, checkServerIdentity: () => undefined });
  return _agent;
}

function requireToken() {
  if (!TOKEN) throw new Error("OWNCORD_API_TOKEN is not set — mint one with `server token create`.");
}

// One request helper backs api_request and is reused by the log flow. Never
// sends an Origin header: the server treats a missing Origin as a non-browser
// client and skips CSRF/Origin checks.
function request(method, path, { query, body, headers } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(/^https?:/.test(path) ? path : BASE_URL + path);
    if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));
    const payload = body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
    const h = {
      Authorization: `Bearer ${TOKEN}`,
      ...(payload !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(headers || {}),
    };
    const req = https.request(url, { method, agent: httpsAgent(), headers: h }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        let parsed = data;
        try {
          parsed = JSON.parse(data);
        } catch {
          /* leave as raw text */
        }
        resolve({ status: res.statusCode, headers: res.headers, body: parsed });
      });
    });
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

// Fetch the server ring-buffer logs. The stream is SSE guarded by a single-use
// ticket (EventSource can't send auth headers). Read the backfill burst, then
// optionally keep reading for follow_ms, filter client-side, and return.
async function collectLogs({ level, source, limit = 500, follow_ms = 0 } = {}) {
  const ticketRes = await request("POST", "/admin/api/logs/ticket");
  if (ticketRes.status !== 200 || !ticketRes.body?.ticket) {
    throw new Error(`log ticket request failed: HTTP ${ticketRes.status} ${JSON.stringify(ticketRes.body)}`);
  }
  const url = new URL(`${BASE_URL}/admin/api/logs/stream`);
  url.searchParams.set("ticket", ticketRes.body.ticket);

  const records = await new Promise((resolve, reject) => {
    const req = https.request(
      url,
      { method: "GET", agent: httpsAgent(), headers: { Authorization: `Bearer ${TOKEN}`, Accept: "text/event-stream" } },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`log stream failed: HTTP ${res.statusCode}`));
          return;
        }
        const out = [];
        let buf = "";
        let idle;
        let hard;
        const done = () => {
          clearTimeout(idle);
          clearTimeout(hard);
          req.destroy();
          resolve(out);
        };
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          buf += chunk;
          let i;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const frame = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const line = frame.split("\n").find((l) => l.startsWith("data: "));
            if (!line) continue; // keepalive comment or blank
            try {
              out.push(JSON.parse(line.slice(6)));
            } catch {
              /* skip malformed frame */
            }
          }
          // In backfill-only mode, finish once the initial burst goes quiet.
          if (follow_ms === 0) {
            clearTimeout(idle);
            idle = setTimeout(done, 300);
          }
        });
        res.on("end", done);
        res.on("error", reject);
        if (follow_ms === 0) idle = setTimeout(done, 300);
        else hard = setTimeout(done, follow_ms);
      },
    );
    req.on("error", reject);
    req.end();
  });

  let rows = records;
  if (level) rows = rows.filter((r) => (r.level || "").toUpperCase() === level.toUpperCase());
  if (source) rows = rows.filter((r) => r.source === source);
  if (rows.length > limit) rows = rows.slice(-limit);
  // attrs arrives as a JSON string on the wire; parse it for readability.
  return rows.map((r) => (r.attrs ? { ...r, attrs: safeParse(r.attrs) } : r));
}

function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

function clientLogs({ lines = 200, level, grep } = {}) {
  let text;
  try {
    text = readFileSync(CLIENT_LOG, "utf8");
  } catch (e) {
    return { path: CLIENT_LOG, found: false, note: `client log not found (client may not have run yet): ${e.code}` };
  }
  let rows = text.split(/\r?\n/).filter(Boolean);
  if (level) rows = rows.filter((l) => l.toUpperCase().includes(`[${level.toUpperCase()}]`));
  if (grep) rows = rows.filter((l) => l.includes(grep));
  return { path: CLIENT_LOG, found: true, lines: rows.slice(-lines) };
}

// ─── MCP wiring ─────────────────────────────────────────────────────────────
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
      query: z.record(z.string()).optional().describe("Query params"),
      body: z.any().optional().describe("JSON body (object or string)"),
      headers: z.record(z.string()).optional().describe("Extra request headers"),
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
      source: z.string().optional().describe("websocket|http|admin|auth|database|storage|updater|config|server"),
      limit: z.number().int().positive().optional().describe("Max records to return (default 500)"),
      follow_ms: z.number().int().nonnegative().optional().describe("0 = backfill only (default); >0 keeps streaming that long"),
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

server.registerTool(
  "client_logs",
  {
    description:
      "Tail the desktop client's log file directly (no server needed). Optional level filter / substring grep.",
    inputSchema: {
      lines: z.number().int().positive().optional().describe("How many trailing lines (default 200)"),
      level: z.string().optional().describe("Filter to lines tagged with this level, e.g. ERROR"),
      grep: z.string().optional().describe("Keep only lines containing this substring"),
    },
  },
  async (a) => {
    try {
      return ok(clientLogs(a));
    } catch (e) {
      return fail(e);
    }
  },
);

await server.connect(new StdioServerTransport());
