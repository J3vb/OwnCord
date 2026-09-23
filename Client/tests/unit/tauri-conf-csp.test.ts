// Regression guard for the webview Content-Security-Policy's image and
// connect sources.
//
// Inline images, OG images, YouTube thumbnails and GIFs are fetched by the
// external-content broker and shown from same-origin blob: URLs; server
// images are data: URIs from the attachment cache. Nothing needs the webview
// to load an https image itself, and dropping `https:` from img-src is what
// makes that enforced: without it a future `<img src="https://...">` would
// silently bypass the broker (B7-16 Decision 7). The capability scope cannot
// catch this — an <img> load never goes through the HTTP plugin.

import { describe, expect, it } from "vitest";

// Asserts src-tauri/tauri.conf.json, which is inside the Client component —
// not a cross-component contract test. See docs/contributing.md#testing.
import tauriConf from "../../src-tauri/tauri.conf.json";

function directive(name: string): string[] {
  const csp = tauriConf.app.security.csp;
  const entry = csp
    .split(";")
    .map((d) => d.trim().split(/\s+/))
    .find(([n]) => n === name);
  expect(entry, `${name} missing from the CSP`).toBeDefined();
  return entry!.slice(1);
}

describe("tauri.conf.json — CSP", () => {
  it("img-src allows only self, blob: (broker bytes) and data: (server images)", () => {
    expect(directive("img-src").sort()).toEqual(["'self'", "blob:", "data:"].sort());
  });

  it("img-src names no remote scheme or host", () => {
    for (const source of directive("img-src")) {
      expect(source).not.toMatch(/^(https?:|\*)|:\/\//);
    }
  });

  // connect-src is loopback only. REST, the chat socket, the updater and the
  // external-content broker all go through IPC; LiveKit and the native frame
  // sockets reach the renderer through loopback tunnels. A local server's
  // LiveKit direct URL is used only when it is itself loopback ws:/http:
  // (platform/desktop/nativeProxies.ts), so no https:/wss: source is needed.
  it("connect-src allows only self, IPC and loopback http/ws", () => {
    expect(directive("connect-src").sort()).toEqual(
      [
        "'self'",
        "http://ipc.localhost",
        "http://localhost:*",
        "ws://localhost:*",
        "http://127.0.0.1:*",
        "ws://127.0.0.1:*",
      ].sort(),
    );
  });
});
