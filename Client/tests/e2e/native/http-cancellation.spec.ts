import { test, expect } from "@playwright/test";
import { openSettings, switchSettingsTab } from "../helpers";
import { startNativeApp, withNativeArtifacts } from "../support/native-app";
import { startNativeHttpGate } from "../support/native-http-gate";
import { startTestServer } from "../support/server";
import { configureNativeServer, nativeLoginAndReady } from "./helpers";

declare global {
  interface Window {
    __nativeHttpReads?: { pending: number; started: number };
  }
}

// eslint-disable-next-line no-empty-pattern -- Playwright requires the destructuring form
test("native connection diagnostics cancel delayed HTTP headers and response bodies without unhandled errors", async ({}, info) => {
  const server = await startTestServer({ tls: true });
  let gate: Awaited<ReturnType<typeof startNativeHttpGate>> | undefined;
  let app: Awaited<ReturnType<typeof startNativeApp>> | undefined;
  try {
    const httpGate = await startNativeHttpGate(server);
    gate = httpGate;
    configureNativeServer(httpGate.origin);
    app = await startNativeApp();
    await withNativeArtifacts(
      app,
      async () => {
        const page = app!.page;
        await nativeLoginAndReady(page);
        // Observe the genuine IPC transport so the body scenario cancels with a
        // native read pending. Tauri seals every `__TAURI_INTERNALS__` member
        // (non-writable `defineProperty` values), so `invoke` cannot be wrapped;
        // on Windows each call is a `window.fetch` to the `ipc.localhost`
        // protocol instead. Requests, replies and rejections are delegated
        // unchanged; no transport or application result is mocked.
        await page.evaluate(() => {
          const nativeFetch = window.fetch;
          const requests = new Set<number>();
          const bodies = new Set<number>();
          const reads = { pending: 0, started: 0 };
          window.__nativeHttpReads = reads;
          window.fetch = async (input, init) => {
            const url =
              typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
            const ipc = /^https?:\/\/ipc\.localhost\/(.+)$/.exec(url);
            const command = ipc ? decodeURIComponent(ipc[1] ?? "") : undefined;
            const args =
              command && typeof init?.body === "string"
                ? (JSON.parse(init.body) as { rid?: number; clientConfig?: { url: string } })
                : undefined;
            const bodyRead = command === "plugin:http|fetch_read_body" && bodies.has(args!.rid!);
            if (bodyRead) {
              reads.pending++;
              reads.started++;
            }
            try {
              const response = await nativeFetch(input, init);
              if (response.headers.get("Tauri-Response") === "ok") {
                if (
                  command === "plugin:http|fetch" &&
                  args!.clientConfig!.url.endsWith("/api/v1/auth/me")
                )
                  requests.add(await response.clone().json());
                if (command === "plugin:http|fetch_send" && requests.has(args!.rid!))
                  bodies.add((await response.clone().json()).rid);
              }
              return response;
            } finally {
              if (bodyRead) reads.pending--;
            }
          };
        });
        await openSettings(page);
        await switchSettingsTab(page, "Logs");
        await page.getByLabel("Include a brief microphone permission check").uncheck();
        for (const [phase, completion] of [
          ["headers", "chunk"],
          ["body", "chunk"],
          ["body", "eof"],
          ["body", "error"],
        ] as const) {
          await info.attach(`http-${phase}-${completion}-stage`, {
            body: "Starting controlled cancellation",
            contentType: "text/plain",
          });
          httpGate.hold(phase);
          const started = await page.evaluate(() => window.__nativeHttpReads!.started);
          await page.getByRole("button", { name: "Start connection test", exact: true }).click();
          // The preceding real health check has a 5s production budget.
          await expect.poll(httpGate.isHeld, { timeout: 8000 }).toBe(true);
          if (phase === "body") {
            // First read receives the partial JSON; the next is waiting for EOF.
            await page.waitForFunction(
              (baseline) => {
                const reads = window.__nativeHttpReads!;
                return reads.started >= baseline + 2 && reads.pending > 0;
              },
              started,
              { timeout: 3000 },
            );
          }
          await page.getByRole("button", { name: "Cancel test", exact: true }).click();
          await expect(page.getByTestId("diagnostics-status")).toHaveText("Test cancelled.");
          // Cancellation rejects the logical request immediately. Rust can
          // still own an in-flight read until the peer sends data, EOF or an
          // error; each late outcome must settle without another disposal.
          httpGate.release(completion);
          await expect.poll(() => page.evaluate(() => window.__nativeHttpReads!.pending)).toBe(0);
          // The server answers at most two pings per user per second
          // (Server/ws/handlers_ping.go) and silently drops the rest. A phase
          // completes within milliseconds, so space the heartbeat probes out.
          await page.waitForTimeout(1100);
          // Complete another real request/heartbeat cycle before checking the
          // error collector, allowing late body-read and cleanup replies to land.
          await page.getByRole("button", { name: "Start connection test", exact: true }).click();
          await expect(page.getByTestId("diagnostics-status")).toContainText("Test complete");
          for (const stage of ["connection", "authentication", "websocket"])
            await expect(page.getByTestId(`diagnostic-${stage}`)).toHaveAttribute(
              "data-status",
              "passed",
            );
        }
      },
      info,
    );
  } finally {
    gate?.release();
    try {
      await app?.close();
    } finally {
      try {
        await gate?.close();
      } finally {
        await server.close();
      }
    }
  }
});
