// The Vite dev server that the development and smoke e2e runs boot must carry
// V8's --no-turbo-fast-api-calls.
//
// On Node 26 (V8 14.6) the dev server's transform middleware occasionally dies
// while writing a large module body through node:http:
//
//   [WebServer] abort: Lazy deopt after a fast API call with return value is unsupported
//   1: byteLength [node:buffer:926]
//   2: maybePrepareFinalChunk [node:_http_outgoing:1176]
//
// Every later page.goto then fails with net::ERR_CONNECTION_REFUSED at
// http://localhost:1420/. The flag turns the fast-API-call path off. V8 flags
// are refused in NODE_OPTIONS, so it has to sit on the `node` command line, and
// Vite has to be the process Playwright starts (see globalTeardown).
import { describe, expect, it } from "vitest";
import config from "../../playwright.config";

describe("playwright dev-server webServer", () => {
  const webServer = config.webServer;
  if (webServer === undefined || Array.isArray(webServer)) {
    throw new Error("playwright.config.ts must declare exactly one webServer");
  }

  it("runs Vite's entry point directly as a node child", () => {
    expect(webServer.command).toMatch(/^node (?:--\S+ )*node_modules\/vite\/bin\/vite\.js /);
  });

  it("starts Vite with --no-turbo-fast-api-calls (V8 14.6 lazy-deopt abort)", () => {
    // Before the script path: after it, the flag would go to Vite, not to V8.
    const tokens = webServer.command.split(/\s+/);
    const flag = tokens.indexOf("--no-turbo-fast-api-calls");
    expect(flag).toBeGreaterThan(0);
    expect(flag).toBeLessThan(tokens.indexOf("node_modules/vite/bin/vite.js"));
  });

  it("pipes the server's stdout so a crash message reaches the CI log", () => {
    expect(webServer.stdout).toBe("pipe");
  });
});
