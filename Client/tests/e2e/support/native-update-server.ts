import { createServer, request } from "node:https";
import { connect } from "node:tls";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Socket } from "node:net";
import type { TestServer } from "./server";

/** Real TLS + Rust updater and real OwnCord HTTP/WS. Only external release
 * metadata/downloads are supplied by the fixture, signed with the CI key. */
export async function startNativeUpdateServer(server: TestServer, packageDir: string) {
  const cert = await readFile(join(server.directory, "data/cert.pem"));
  const key = await readFile(join(server.directory, "data/key.pem"));
  const data = await readFile(join(packageDir, "new/update.nsis.zip"));
  const signature = (await readFile(join(packageDir, "new/update.nsis.zip.sig"), "utf8")).trim();
  let fault: "corrupt" | "interrupted" | "none" = "corrupt";
  let origin = "";
  let downloads = 0;
  const sockets = new Set<Socket>();
  const track = (socket: Socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
  };
  const gateway = createServer({ cert, key }, (req, res) => {
    const path = req.url ?? "/";
    if (path.startsWith("/api/v1/client-update/")) {
      const [target, current] = path.split("/").slice(4);
      if (current === "1.2.0-alpha.5") {
        res.writeHead(204);
        res.end();
        return;
      }
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          version: "1.2.0-alpha.5",
          notes: "Signed desktop test release",
          platforms: { [target!]: { signature, url: `${origin}/test-update.nsis.zip` } },
        }),
      );
      return;
    }
    if (path === "/test-update.nsis.zip") {
      downloads++;
      if (fault === "corrupt") {
        res.end(Buffer.from("invalid signature payload"));
        return;
      }
      res.setHeader("Content-Length", data.length);
      if (fault === "interrupted") {
        res.setHeader("Connection", "close");
        res.end(data.subarray(0, 1024));
        return;
      }
      res.end(data);
      return;
    }
    // This scoped bypass trusts only our own generated loopback upstream;
    // the app's connection to the gateway still goes through actual TOFU.
    const upstream = request(
      `${server.origin}${path}`,
      {
        method: req.method,
        headers: { ...req.headers, host: new URL(server.origin).host },
        rejectUnauthorized: false,
      },
      (response) => {
        res.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(res);
      },
    );
    upstream.on("error", () => {
      res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  });
  gateway.on("connection", track);
  gateway.on("upgrade", (req, socket, head) => {
    const upstream = connect(
      { host: "127.0.0.1", port: server.port, rejectUnauthorized: false },
      () => {
        const headers = { ...req.headers, host: new URL(server.origin).host };
        upstream.write(
          `${req.method} ${req.url} HTTP/1.1\r\n${Object.entries(headers)
            .map(([name, value]) => `${name}: ${value}`)
            .join("\r\n")}\r\n\r\n`,
        );
        upstream.write(head);
        socket.pipe(upstream).pipe(socket);
      },
    );
    track(upstream);
    socket.on("close", () => upstream.destroy());
    upstream.on("close", () => socket.destroy());
  });
  gateway.listen(0, "127.0.0.1");
  await once(gateway, "listening");
  const address = gateway.address();
  if (!address || typeof address === "string") throw new Error("No updater gateway port");
  origin = `https://127.0.0.1:${address.port}`;
  return {
    origin,
    downloads: () => downloads,
    fault(value: typeof fault) {
      fault = value;
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => gateway.close(() => resolve()));
    },
  };
}
