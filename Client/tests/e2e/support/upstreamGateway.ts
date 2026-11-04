/**
 * Shared plumbing for the loopback TLS gateways that sit in front of a real
 * OwnCord test server: its certificate pinned as the only trusted upstream,
 * socket tracking for teardown, and WebSocket upgrade forwarding.
 */
import { X509Certificate } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import type { Server } from "node:https";
import type { Socket } from "node:net";
import { join } from "node:path";
import { connect, type PeerCertificate } from "node:tls";
import type { TestServer } from "./server";

/** The server's own certificate, and the TLS options that trust exactly it on loopback. */
export async function loadUpstreamTLS(server: TestServer, label: string) {
  const cert = await readFile(join(server.directory, "data/cert.pem"));
  const key = await readFile(join(server.directory, "data/key.pem"));
  // OwnCord's generated certificate has no DNS/IP SANs. Trust its exact
  // certificate and identity on our owned loopback upstream, just as TOFU
  // does, while retaining TLS chain/signature/expiry verification.
  const fingerprint = new X509Certificate(cert).fingerprint256;
  const upstreamTLS = {
    ca: cert,
    checkServerIdentity(host: string, peer: PeerCertificate) {
      if (host !== "127.0.0.1" || peer.fingerprint256 !== fingerprint)
        return new Error(`${label} upstream certificate does not match its pin`);
      return undefined;
    },
  };
  return { cert, key, upstreamTLS };
}

/** Remembers every socket so `destroyAll` can drop them before the gateway closes. */
export function socketTracker() {
  const sockets = new Set<Socket>();
  const track = (socket: Socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
  };
  return {
    track,
    destroyAll() {
      for (const socket of sockets) socket.destroy();
    },
  };
}

/** Forward WebSocket upgrades to the real server over the pinned TLS connection. */
export function forwardUpgrades(
  gateway: Server,
  server: TestServer,
  upstreamTLS: object,
  track: (socket: Socket) => void,
): void {
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
}

/** Listen on a free loopback port and return the gateway's HTTPS origin. */
export async function listenOnLoopback(gateway: Server, label: string): Promise<string> {
  gateway.listen(0, "127.0.0.1");
  await once(gateway, "listening");
  const address = gateway.address();
  if (!address || typeof address === "string") throw new Error(`No ${label} port`);
  return `https://127.0.0.1:${address.port}`;
}
