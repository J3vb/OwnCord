// Measures what the desktop HTTP tunnel's `Connection: close` costs one request
// (CLI-04(b), docs/plans/http-tofu-proxy.md). It starts the e2e server binary
// with a self-signed certificate, uploads one PNG, and times a REST call
// (GET /api/v1/server-info) and an image fetch (GET /api/v1/files/{id}) two ways
// through a loopback delay gate: on a fresh TCP + TLS connection per request,
// as the tunnel does, and as the second request on a kept-alive connection.
//
// The gate delays every chunk by the given one-way delay in each direction and
// holds each new connection for one RTT before dialing the server, standing in
// for the TCP handshake a remote connect pays. Each fresh connection is a full
// TLS handshake, as the tunnel builds a new rustls config per connection.
//
//   cd Client && npm run test:e2e:build-server
//   node tests/e2e/scripts/measure-tunnel-tls.mjs [--tunnel] [one-way delay ms ...]
//
// With --tunnel, the same server and gates time the tunnel's own upstream code
// instead: one request per fresh connection with Nagle's algorithm on against
// the same with TCP_NODELAY off, through the ignored `measure_tunnel_nodelay`
// test in src-tauri/src/http_proxy.rs. It runs `cargo test`, so on Linux set up
// the webrtc toolchain first (Client/CLAUDE.md).
import { spawn } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import https from "node:https";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const args = process.argv.slice(2);
const tunnel = args.includes("--tunnel");
const delays = args.filter((arg) => arg !== "--tunnel").map(Number);
if (delays.length === 0) delays.push(0, 5, 10, 25, 50);
const SAMPLES = 15;
const PASSWORD = "OwnCord-Measure-pass-123!";
// A 1x1 transparent PNG.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

const freePort = () =>
  new Promise((done) => {
    const probe = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => done(port));
    });
  });

// The server's own self-signed certificate, pinned by fingerprint as the tunnel
// pins it: it carries no subject alternative name to check a host against. A
// kept-alive agent carries the pin itself: Node gives a per-request
// checkServerIdentity its own pool key, so the socket would never be reused.
let pinned;

/** One request on `agent`; resolves with the body and the elapsed ms. */
const request = (port, path, { agent, method = "GET", headers = {}, body } = {}) =>
  new Promise((done, fail) => {
    const start = performance.now();
    const req = https.request(
      { host: "127.0.0.1", port, path, method, headers, agent, ...(agent ? {} : pinned) },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString();
          if (res.statusCode >= 400)
            fail(new Error(`${method} ${path}: ${res.statusCode} ${text}`));
          else done({ text, ms: performance.now() - start });
        });
      },
    );
    req.on("error", fail);
    req.end(body);
  });

/** Loopback relay to `target` that adds `delay` ms each way. */
async function delayGate(target, delay) {
  const port = await freePort();
  const gate = net.createServer((client) => {
    client.setNoDelay(true);
    client.pause();
    setTimeout(() => {
      const server = net.connect(target, "127.0.0.1");
      server.setNoDelay(true);
      const pipe = (from, to) => {
        from.on("data", (chunk) => setTimeout(() => to.write(chunk), delay));
        from.on("end", () => setTimeout(() => to.end(), delay));
        from.on("error", () => to.destroy());
      };
      pipe(client, server);
      pipe(server, client);
      client.resume();
    }, 2 * delay);
  });
  await new Promise((done) => gate.listen(port, "127.0.0.1", done));
  return { port, close: () => gate.close() };
}

const median = (values) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];

async function time(port, path, headers) {
  const fresh = [];
  const kept = [];
  for (let i = 0; i < SAMPLES; i++) {
    fresh.push(
      (await request(port, path, { agent: false, headers: { ...headers, Connection: "close" } }))
        .ms,
    );
    const agent = new https.Agent({ keepAlive: true, maxSockets: 1, ...pinned });
    await request(port, path, { agent, headers });
    kept.push((await request(port, path, { agent, headers })).ms);
    agent.destroy();
  }
  return { fresh: median(fresh), kept: median(kept) };
}

const directory = await mkdtemp(join(tmpdir(), "owncord-tls-cost-"));
const port = await freePort();
await writeFile(
  join(directory, "config.yaml"),
  JSON.stringify({
    server: { port, data_dir: join(directory, "data") },
    database: { path: join(directory, "data", "chatserver.db") },
    tls: { mode: "self_signed" },
    voice: { auto_download_livekit: false },
  }),
);
let log = "";
const binary = resolve(`tests/e2e/.bin/chatserver${process.platform === "win32" ? ".exe" : ""}`);
const server = spawn(binary, [], { cwd: directory });
server.stdout.on("data", (chunk) => (log += chunk));
server.stderr.on("data", (chunk) => (log += chunk));
const running = () =>
  server.pid !== undefined && server.exitCode === null && server.signalCode === null;
try {
  await new Promise((done, fail) => {
    server.once("spawn", done);
    server.once("error", (error) =>
      fail(
        new Error(`cannot start ${binary} (run npm run test:e2e:build-server): ${error.message}`),
      ),
    );
  });
  let setupToken;
  for (let i = 0; i < 300 && !setupToken && running(); i++) {
    await sleep(100);
    setupToken = /Setup token\s+(\S+)/.exec(log)?.[1];
  }
  if (!setupToken) throw new Error("the server printed no setup token");
  const cert = await readFile(join(directory, "data", "cert.pem"));
  const fingerprint = new X509Certificate(cert).fingerprint256;
  pinned = {
    ca: cert,
    checkServerIdentity: (_host, peer) =>
      peer.fingerprint256 === fingerprint
        ? undefined
        : new Error("the server certificate does not match its pin"),
  };
  await sleep(500);
  const json = { "Content-Type": "application/json" };
  const { token } = JSON.parse(
    (
      await request(port, "/admin/api/setup", {
        method: "POST",
        headers: json,
        body: JSON.stringify({ username: "measure", password: PASSWORD, setup_token: setupToken }),
      })
    ).text,
  );
  const auth = { Authorization: `Bearer ${token}` };
  const boundary = "owncordmeasure";
  const upload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="pixel.png"\r\nContent-Type: image/png\r\n\r\n`,
    ),
    PNG,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const { id } = JSON.parse(
    (
      await request(port, "/api/v1/uploads", {
        method: "POST",
        headers: { ...auth, "Content-Type": `multipart/form-data; boundary=${boundary}` },
        body: upload,
      })
    ).text,
  );

  if (tunnel) {
    const gates = await Promise.all(delays.map((delay) => delayGate(port, delay)));
    try {
      const exitCode = await new Promise((done, fail) => {
        const cargo = spawn(
          "cargo",
          ["test", "--lib", "measure_tunnel_nodelay", "--", "--ignored", "--nocapture"],
          {
            cwd: resolve("src-tauri"),
            stdio: "inherit",
            env: {
              ...process.env,
              OWNCORD_MEASURE_GATES: delays.map((delay, i) => `${delay}:${gates[i].port}`).join(),
              OWNCORD_MEASURE_REQUESTS: `REST=/api/v1/server-info,Image=/api/v1/files/${id}`,
              OWNCORD_MEASURE_TOKEN: token,
            },
          },
        );
        cargo.once("error", fail);
        cargo.once("exit", done);
      });
      if (exitCode !== 0) throw new Error(`cargo test exited with ${exitCode}`);
    } finally {
      for (const gate of gates) gate.close();
    }
  } else {
    console.log(
      "| One-way delay | RTT | Request | Fresh connection | Keep-alive | Handshake overhead |",
    );
    console.log("| --- | --- | --- | --- | --- | --- |");
    for (const delay of delays) {
      const gate = await delayGate(port, delay);
      for (const [name, path] of [
        ["REST (server-info)", "/api/v1/server-info"],
        ["Image (files/{id})", `/api/v1/files/${id}`],
      ]) {
        const { fresh, kept } = await time(gate.port, path, auth);
        console.log(
          `| ${delay} ms | ${2 * delay} ms | ${name} | ${fresh.toFixed(1)} ms | ${kept.toFixed(1)} ms | ${(fresh - kept).toFixed(1)} ms |`,
        );
      }
      gate.close();
    }
  }
} catch (error) {
  console.error(`server log:\n${log}`);
  throw error;
} finally {
  if (running()) {
    const exited = new Promise((done) => server.once("exit", done));
    server.kill();
    await exited;
  }
  await rm(directory, { recursive: true, force: true });
}
