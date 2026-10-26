import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createClient, MAX_FOLLOW_MS } from "./transport.mjs";

async function fixture(t, handler, options = {}) {
  const server = http.createServer(handler);
  const sockets = new Set();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => {
      sockets.delete(socket);
      server.emit("fixtureClosed");
    });
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const client = createClient({
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    token: "fixture-token",
    requestTimeoutMs: 500,
    idleMs: 20,
    ...options,
  });
  return { server, client };
}

function ticketThen(stream) {
  return (req, res) => {
    if (req.url === "/admin/api/logs/ticket") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ticket: "fixture-ticket" }));
    } else stream(req, res);
  };
}

test(
  "HTTP override preserves method, bearer token, query and JSON body",
  { timeout: 3000 },
  async (t) => {
    const { client } = await fixture(t, (req, res) => {
      assert.equal(req.method, "POST");
      assert.equal(req.headers.authorization, "Bearer fixture-token");
      assert.equal(req.headers["x-fixture"], "yes");
      assert.equal(req.url, "/api/v1/example?name=a+b");
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        res.end(JSON.stringify({ received: JSON.parse(body) }));
      });
    });
    const result = await client.request("POST", "/api/v1/example", {
      query: { name: "a b" },
      body: { value: 3 },
      headers: { "X-Fixture": "yes" },
    });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { received: { value: 3 } });
  },
);

test("plain-text errors retain their HTTP status and body", { timeout: 3000 }, async (t) => {
  const { client } = await fixture(t, (req, res) => {
    res.writeHead(503);
    res.end("fixture unavailable");
  });
  const result = await client.request("GET", "/api/v1/example");
  assert.equal(result.status, 503);
  assert.equal(result.body, "fixture unavailable");
});

for (const partialBody of [false, true]) {
  test(
    `API deadline covers ${partialBody ? "a stalled body" : "missing headers"} and closes its socket`,
    { timeout: 3000 },
    async (t) => {
      const { server, client } = await fixture(t, (req, res) => {
        if (partialBody) {
          res.writeHead(200);
          res.write("partial");
        }
      });
      const closed = once(server, "fixtureClosed");
      await assert.rejects(client.request("GET", "/api/v1/example"), /request timed out/);
      await closed;
    },
  );
}

test(
  "an interrupted API response rejects rather than returning partial JSON",
  { timeout: 3000 },
  async (t) => {
    const { client } = await fixture(t, (req, res) => {
      res.writeHead(200);
      res.write('{"partial":');
      setImmediate(() => res.destroy());
    });
    await assert.rejects(
      client.request("GET", "/api/v1/example"),
      /completion|aborted|socket hang up/,
    );
  },
);

test("log-ticket requests have the same total deadline", { timeout: 3000 }, async (t) => {
  const { client } = await fixture(t, () => {});
  await assert.rejects(client.collectLogs(), /request timed out/);
});

test(
  "SSE missing-header timeout closes the stream and omits ticket URLs",
  { timeout: 3000 },
  async (t) => {
    let closed;
    const ended = new Promise((resolve) => {
      closed = resolve;
    });
    const { client } = await fixture(
      t,
      ticketThen((req, res) => res.once("close", closed)),
    );
    await assert.rejects(client.collectLogs(), (error) => {
      assert.match(error.message, /log stream timed out/);
      assert.doesNotMatch(error.message, /fixture-ticket|fixture-token|ticket=/);
      return true;
    });
    await ended;
  },
);

test(
  "SSE backfill parses split frames and preserves filters, limits and attrs",
  { timeout: 3000 },
  async (t) => {
    const { client } = await fixture(
      t,
      ticketThen((req, res) => {
        assert.match(req.url, /^\/admin\/api\/logs\/stream\?ticket=fixture-ticket$/);
        assert.equal(req.headers.authorization, "Bearer fixture-token");
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write('data: {"level":"INFO","source":"ws","msg":"ignore"}\n\n');
        res.write('data: {"level":"ERROR","source":"ws","msg":"old"}\n\ndata: {"level":');
        res.write('"ERROR","source":"ws","msg":"last","attrs":"{\\"count\\":2}"}\n\n');
      }),
    );
    assert.deepEqual(await client.collectLogs({ level: "error", source: "ws", limit: 1 }), [
      { level: "ERROR", source: "ws", msg: "last", attrs: { count: 2 } },
    ]);
  },
);

test(
  "continuous backfill ends at the hard deadline even when never idle",
  { timeout: 3000 },
  async (t) => {
    const { client } = await fixture(
      t,
      ticketThen((req, res) => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.flushHeaders();
        const timer = setInterval(() => res.write('data: {"msg":"busy"}\n\n'), 5);
        res.once("close", () => clearInterval(timer));
      }),
    );
    const records = await client.collectLogs();
    assert.ok(records.length > 0);
  },
);

test(
  "live follow ends at its requested duration and closes the connection",
  { timeout: 3000 },
  async (t) => {
    let closed;
    const ended = new Promise((resolve) => {
      closed = resolve;
    });
    const { client } = await fixture(
      t,
      ticketThen((req, res) => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write('data: {"msg":"live"}\n\n');
        res.once("close", closed);
      }),
    );
    assert.deepEqual(await client.collectLogs({ follow_ms: 30 }), [{ msg: "live" }]);
    await ended;
  },
);

test("rejected and interrupted log streams clean up and reject", { timeout: 3000 }, async (t) => {
  for (const interrupted of [false, true]) {
    const { client } = await fixture(
      t,
      ticketThen((req, res) => {
        res.writeHead(interrupted ? 200 : 403);
        res.flushHeaders();
        if (interrupted) setImmediate(() => res.destroy());
      }),
    );
    await assert.rejects(
      client.collectLogs(),
      interrupted ? /completion|aborted|socket hang up/ : /HTTP 403/,
    );
  }
});

test("follow durations above the cap fail before contacting the server", async () => {
  const client = createClient({ baseUrl: "http://127.0.0.1:1", token: "fixture-token" });
  await assert.rejects(
    client.collectLogs({ follow_ms: MAX_FOLLOW_MS + 1 }),
    /follow_ms must be between/,
  );
});

test("HTTPS retains the supplied trust anchor and reuses its verified agent", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "owncord-cert-fixture-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const certPath = join(dir, "cert.pem");
  writeFileSync(certPath, "fixture trust anchor");
  const agents = [];
  t.mock.method(https, "request", (url, opts, callback) => {
    assert.equal(url.protocol, "https:");
    agents.push(opts.agent);
    const req = new EventEmitter();
    req.destroy = () => {};
    req.end = () =>
      queueMicrotask(() => {
        const res = new EventEmitter();
        res.statusCode = 200;
        res.headers = {};
        res.setEncoding = () => {};
        res.destroy = () => {};
        callback(res);
        res.emit("data", "{}");
        res.emit("end");
      });
    return req;
  });
  const client = createClient({
    baseUrl: "https://fixture.invalid",
    token: "fixture-token",
    certPath,
  });
  await client.request("GET", "/one");
  await client.request("GET", "/two");
  assert.equal(agents[0], agents[1]);
  assert.equal(agents[0].options.ca.toString(), "fixture trust anchor");
  assert.notEqual(agents[0].options.rejectUnauthorized, false);
  assert.equal(typeof agents[0].options.checkServerIdentity, "function");
  agents[0].destroy();
});
