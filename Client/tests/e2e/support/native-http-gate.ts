import { createServer, request } from "node:https";
import type { ServerResponse } from "node:http";
import type { TestServer } from "./server";
import {
  forwardUpgrades,
  listenOnLoopback,
  loadUpstreamTLS,
  socketTracker,
} from "./upstreamGateway";

/** Pause one authenticated account response before headers or halfway through its JSON body.
 * All other HTTP and WebSocket traffic reaches the real OwnCord server. */
export async function startNativeHttpGate(server: TestServer) {
  const { cert, key, upstreamTLS } = await loadUpstreamTLS(server, "Native HTTP test");
  let phase: "headers" | "body" | undefined;
  let held: ServerResponse | undefined;
  const { track, destroyAll } = socketTracker();
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
        // pipe() does not forward an upstream reset to the downstream client.
        // Propagate it so cancellation/error probes do not become stalled reads.
        response.on("error", () => res.destroy());
        response.on("aborted", () => res.destroy());
        response.pipe(res);
      },
    );
    upstream.on("error", () => res.destroy());
    res.on("close", () => upstream.destroy());
    req.pipe(upstream);
  });
  gateway.on("connection", track);
  forwardUpgrades(gateway, server, upstreamTLS, track);
  const origin = await listenOnLoopback(gateway, "HTTP gate");
  return {
    origin,
    hold(value: typeof phase) {
      phase = value;
      held = undefined;
    },
    isHeld: () => !!held,
    release(completion: "chunk" | "eof" | "error" = "chunk") {
      if (held && !held.destroyed) {
        if (completion === "error") held.destroy();
        else if (phase === "body") held.end(completion === "eof" ? undefined : "1}");
        else held.end('{"id":1}');
      }
      held = undefined;
      phase = undefined;
    },
    async close() {
      destroyAll();
      await new Promise<void>((resolve) => gateway.close(() => resolve()));
    },
  };
}
