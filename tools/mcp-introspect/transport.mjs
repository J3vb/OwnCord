import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";

export const MAX_FOLLOW_MS = 60_000;

// Separate the HTTP/SSE transport from MCP wiring so it can be tested offline.
export function createClient({
  baseUrl,
  token,
  certPath,
  requestTimeoutMs = 15_000,
  idleMs = 300,
}) {
  let agent;
  function options(url, headers, method) {
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error(`unsupported protocol: ${url.protocol}`);
    }
    if (url.protocol === "https:" && !agent) {
      let ca;
      try {
        ca = readFileSync(certPath);
      } catch {
        throw new Error(
          `OwnCord cert not found at ${certPath}. Start the server once or set OWNCORD_CERT_PATH.`,
        );
      }
      agent = new https.Agent({ ca, checkServerIdentity: () => undefined });
    }
    return {
      method,
      agent: url.protocol === "https:" ? agent : undefined,
      headers: { Authorization: `Bearer ${token}`, ...headers },
    };
  }
  const transport = (url) => (url.protocol === "http:" ? http : https);

  function request(method, path, { query, body, headers } = {}) {
    const url = new URL(/^https?:/.test(path) ? path : baseUrl + path);
    if (query)
      for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
    const payload =
      body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
    const opts = options(
      url,
      {
        ...(payload !== undefined ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      method,
    );
    return new Promise((resolve, reject) => {
      let req;
      let response;
      let settled = false;
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        response?.destroy();
        req?.destroy();
        if (error) reject(error);
        else resolve(result);
      };
      const deadline = setTimeout(
        () => finish(new Error(`request timed out after ${requestTimeoutMs} ms`)),
        requestTimeoutMs,
      );
      try {
        req = transport(url).request(url, opts, (res) => {
          if (settled) {
            res.destroy();
            return;
          }
          response = res;
          let data = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => {
            data += chunk;
          });
          res.once("error", (error) => finish(error));
          res.once("aborted", () => finish(new Error("response ended before completion")));
          res.once("end", () => {
            let parsed = data;
            try {
              parsed = JSON.parse(data);
            } catch {
              /* preserve raw text */
            }
            finish(null, { status: res.statusCode, headers: res.headers, body: parsed });
          });
        });
        req.once("error", (error) => finish(error));
        if (payload !== undefined) req.write(payload);
        req.end();
      } catch (error) {
        finish(error);
      }
    });
  }

  async function collectLogs({ level, source, limit = 500, follow_ms = 0 } = {}) {
    if (!Number.isInteger(follow_ms) || follow_ms < 0 || follow_ms > MAX_FOLLOW_MS) {
      throw new Error(`follow_ms must be between 0 and ${MAX_FOLLOW_MS}`);
    }
    const ticketRes = await request("POST", "/admin/api/logs/ticket");
    if (ticketRes.status !== 200 || !ticketRes.body?.ticket) {
      throw new Error(`log ticket request failed: HTTP ${ticketRes.status}`);
    }
    const url = new URL(`${baseUrl}/admin/api/logs/stream`);
    url.searchParams.set("ticket", ticketRes.body.ticket);
    const opts = options(url, { Accept: "text/event-stream" }, "GET");
    const records = await new Promise((resolve, reject) => {
      let req;
      let response;
      let idle;
      let hard;
      let settled = false;
      const out = [];
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(headersDeadline);
        clearTimeout(idle);
        clearTimeout(hard);
        response?.destroy();
        req?.destroy();
        if (error) reject(error);
        else resolve(out);
      };
      // Start before response headers: an unresponsive server must not hang the tool.
      const headersDeadline = setTimeout(
        () => finish(new Error(`log stream timed out after ${requestTimeoutMs} ms`)),
        requestTimeoutMs,
      );
      try {
        req = transport(url).request(url, opts, (res) => {
          if (settled) {
            res.destroy();
            return;
          }
          response = res;
          clearTimeout(headersDeadline);
          if (res.statusCode !== 200) {
            finish(new Error(`log stream failed: HTTP ${res.statusCode}`));
            return;
          }
          // A busy backfill can keep resetting the idle timer; it needs a hard bound too.
          hard = setTimeout(() => finish(), follow_ms || requestTimeoutMs);
          let buf = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => {
            buf += chunk;
            let i;
            while ((i = buf.indexOf("\n\n")) >= 0) {
              const frame = buf.slice(0, i);
              buf = buf.slice(i + 2);
              const line = frame.split("\n").find((value) => value.startsWith("data: "));
              if (!line) continue;
              try {
                out.push(JSON.parse(line.slice(6)));
              } catch {
                /* skip malformed frames */
              }
            }
            if (follow_ms === 0) {
              clearTimeout(idle);
              idle = setTimeout(() => finish(), idleMs);
            }
          });
          res.once("end", () => finish());
          res.once("error", (error) => finish(error));
          res.once("aborted", () => finish(new Error("log stream ended before completion")));
          if (follow_ms === 0) idle = setTimeout(() => finish(), idleMs);
        });
        req.once("error", (error) => finish(error));
        req.end();
      } catch (error) {
        finish(error);
      }
    });
    let rows = records;
    if (level) rows = rows.filter((row) => (row.level || "").toUpperCase() === level.toUpperCase());
    if (source) rows = rows.filter((row) => row.source === source);
    if (rows.length > limit) rows = rows.slice(-limit);
    return rows.map((row) => {
      if (!row.attrs) return row;
      try {
        return { ...row, attrs: JSON.parse(row.attrs) };
      } catch {
        return row;
      }
    });
  }

  return { request, collectLogs };
}
