import { X509Certificate } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer, request } from "node:https";
import type { ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { join } from "node:path";
import { connect, type PeerCertificate } from "node:tls";
import type { TestServer } from "./server";

/** Pause one authenticated account response before headers or halfway through its JSON body.
 * All other HTTP and WebSocket traffic reaches the real OwnCord server. */
export async function startNativeHttpGate(server: TestServer) {
  const cert = await readFile(join(server.directory, "data/cert.pem"));
  const key = await readFile(join(server.directory, "data/key.pem"));
  const fingerprint = new X509Certificate(cert).fingerprint256;
  const upstreamTLS = {
    ca: cert,
    checkServerIdentity(host: string, peer: PeerCertificate) {
      if (host !== "127.0.0.1" || peer.fingerprint256 !== fingerprint)
        return new Error("Native HTTP test upstream certificate does not match its pin");
      return undefined;
    },
  };
  let phase: "headers" | "body" | undefined;
  let held: ServerResponse | undefined;
  const sockets = new Set<Socket>();
  const track = (socket: Socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
  };
  const gateway = createServer({ cert, key }, (req, res) => {
    res.on("error", () => res.destroy());
    if (phase && req.url === "/api/v1/auth/me") {
      held = res;
      if (phase === "body") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.write('{"id":');
      }
      return;
    }
    const upstream = request(
      `${server.origin}${req.url ?? "/"}`,
      {
        method: req.method,
        headers: { ...req.headers, host: new URL(server.origin).host },
        ...upstreamTLS,
      },
      (response) => {
        res.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(res);
      },
    );
    upstream.on("error", () => res.destroy());
    req.pipe(upstream);
  });
  gateway.on("connection", track);
  gateway.on("upgrade", (req, socket, head) => {
    const upstream = connect({ host: "127.0.0.1", port: server.port, ...upstreamTLS }, () => {
      const headers = { ...req.headers, host: new URL(server.origin).host };
      upstream.write(
        `${req.method} ${req.url} HTTP/1.1\r\n${Object.entries(headers)
          .map(([name, value]) => `${name}: ${value}`)
          .join("\r\n")}\r\n\r\n`,
      );
      upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    track(upstream);
    socket.on("close", () => upstream.destroy());
    upstream.on("close", () => socket.destroy());
  });
  gateway.listen(0, "127.0.0.1");
  await once(gateway, "listening");
  const address = gateway.address();
  if (!address || typeof address === "string") throw new Error("No HTTP gate port");
  return {
    origin: `https://127.0.0.1:${address.port}`,
    hold(value: typeof phase) {
      phase = value;
      held = undefined;
    },
    isHeld: () => !!held,
    release() {
      if (held && !held.destroyed) {
        if (phase === "body") held.end("1}");
        else held.end('{"id":1}');
      }
      held = undefined;
      phase = undefined;
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => gateway.close(() => resolve()));
    },
  };
}
