import { createServer, request } from "node:https";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { TestServer } from "./server";
import {
  forwardUpgrades,
  listenOnLoopback,
  loadUpstreamTLS,
  socketTracker,
} from "./upstreamGateway";

/** Real TLS + Rust updater and real OwnCord HTTP/WS. Only external release
 * metadata/downloads are supplied by the fixture, signed with the CI key —
 * or, given `release`, the shipped updater artifact and its release
 * signature, offered only to the one target it was built for. */
export async function startNativeUpdateServer(
  server: TestServer,
  packageDir: string,
  release?: { archive: string; signature: string; version: string; target: string },
) {
  const { cert, key, upstreamTLS } = await loadUpstreamTLS(server, "Native test");
  const data = await readFile(release?.archive ?? join(packageDir, "new/update.nsis.zip"));
  const signature = (
    await readFile(release?.signature ?? join(packageDir, "new/update.nsis.zip.sig"), "utf8")
  ).trim();
  const version = release?.version ?? "1.2.0-alpha.5";
  let fault: "corrupt" | "interrupted" | "none" = release ? "none" : "corrupt";
  let origin = "";
  let downloads = 0;
  const targets: string[] = [];
  const { track, destroyAll } = socketTracker();
  const gateway = createServer({ cert, key }, (req, res) => {
    const path = req.url ?? "/";
    if (path.startsWith("/api/v1/client-update/")) {
      const [target, current] = path.split("/").slice(4);
      targets.push(target!);
      // A foreign target gets 204, as the real server answers it
      // (Server/api/client_update.go): never another installer's artifact.
      if (current === version || (release && target !== release.target)) {
        res.writeHead(204);
        res.end();
        return;
      }
      // Name the artifact after the target it was built for, the way release
      // assets are (Server/updater/assets.go clientAssetSuffixByTarget). The
      // client refuses an artifact whose name does not name the running
      // machine's OS and architecture, so a generic name would never install.
      const artifact = `/artifact/${target!}`;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          version,
          notes: "Signed desktop test release",
          platforms: { [target!]: { signature, url: `${origin}${artifact}` } },
        }),
      );
      return;
    }
    if (path.startsWith("/artifact/")) {
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
    // The app's connection to this gateway still goes through actual TOFU.
    const upstream = request(
      `${server.origin}${path}`,
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
    upstream.on("error", () => {
      res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  });
  gateway.on("connection", track);
  forwardUpgrades(gateway, server, upstreamTLS, track);
  origin = await listenOnLoopback(gateway, "updater gateway");
  return {
    origin,
    downloads: () => downloads,
    /** Every updater target the client asked about, in order. */
    targets: () => [...targets],
    fault(value: typeof fault) {
      fault = value;
    },
    async close() {
      destroyAll();
      await new Promise<void>((resolve) => gateway.close(() => resolve()));
    },
  };
}
