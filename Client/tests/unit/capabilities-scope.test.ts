// Regression guard for the Tauri HTTP capability scope.
//
// Capabilities are enforced by the Rust/Tauri ACL at compile time, so TS
// cannot exercise them. What TS *can* do is lock the shape of the grant so a
// widening (or a re-added inert scope) has to be deliberate. See
// docs/plans/tauri-capability-narrowing.md for why only `http:allow-fetch`
// carries a scope: tauri-plugin-http validates the URL once, in the `fetch`
// command — `fetch_send`/`fetch_read_body` take an already-validated
// ResourceId and never consult a scope.

import { describe, expect, it } from "vitest";

// Asserts src-tauri/capabilities/default.json, which is inside the Client
// component — not a cross-component contract test. See
// docs/contributing.md#testing.
import capabilityJson from "../../src-tauri/capabilities/default.json";

interface ScopeEntry {
  readonly url?: string;
  readonly path?: string;
}
interface ScopedPermission {
  readonly identifier: string;
  readonly allow?: readonly ScopeEntry[];
  readonly deny?: readonly ScopeEntry[];
}
type Permission = string | ScopedPermission;

const permissions = capabilityJson.permissions as readonly Permission[];

function find(identifier: string): Permission {
  const entry = permissions.find((p) =>
    typeof p === "string" ? p === identifier : p.identifier === identifier,
  );
  expect(entry, `${identifier} missing from default capability`).toBeDefined();
  return entry as Permission;
}

function urls(entries: readonly ScopeEntry[] | undefined): string[] {
  return (entries ?? []).map((e) => e.url ?? "");
}

describe("Tauri default capability — HTTP scope", () => {
  it("http:allow-fetch allows only the loopback TOFU proxies", () => {
    // Every external fetch goes through the external-content broker
    // (src-tauri/src/external_content.rs), so the renderer's plugin client
    // reaches nothing but the Rust proxies on loopback (B7-16, C-09 clause 8).
    const fetchPerm = find("http:allow-fetch") as ScopedPermission;
    expect(urls(fetchPerm.allow)).toEqual(["http://127.0.0.1:*"]);
  });

  it("http:allow-fetch grants no https destination at all", () => {
    const fetchPerm = find("http:allow-fetch") as ScopedPermission;
    expect(urls(fetchPerm.allow).filter((url) => url.startsWith("https:"))).toEqual([]);
  });

  it("http:allow-fetch denies https loopback literals", () => {
    const fetchPerm = find("http:allow-fetch") as ScopedPermission;
    // All legitimate server traffic reaches loopback over http (the Rust TOFU
    // proxy). An https loopback fetch can only be an attempt to reach some
    // other local service, so deny it — deny wins over allow in Tauri's scope.
    // With no https allow left this is defence in depth: it still holds if a
    // future change re-adds a wildcard.
    expect(urls(fetchPerm.deny).sort()).toEqual(
      [
        "https://127.0.0.1",
        "https://127.0.0.1:*",
        "https://localhost",
        "https://localhost:*",
      ].sort(),
    );
  });

  it.each([
    "http:allow-fetch-send",
    "http:allow-fetch-read-body",
    "http:allow-fetch-cancel",
    "http:allow-fetch-cancel-body",
  ])("%s is a bare identifier (a scope there would be inert)", (identifier) => {
    expect(find(identifier)).toBe(identifier);
  });

  it("no permission grants a plaintext-http or any-scheme wildcard", () => {
    const allUrls = permissions.flatMap((p) =>
      typeof p === "string" ? [] : [...urls(p.allow), ...urls(p.deny)],
    );
    for (const url of allUrls) {
      expect(url.startsWith("http://") && !url.startsWith("http://127.0.0.1")).toBe(false);
      expect(url).not.toMatch(/^\*|^[a-z]*:\/\/\*\.?\*/);
    }
  });

  it("grants core:window:allow-set-fullscreen (a full-screen video tile fills the monitor through the window)", () => {
    // HTML full screen fills only the webview in WebView2, so a tile in full
    // screen also puts the window in full screen.
    expect(find("core:window:allow-set-fullscreen")).toBe("core:window:allow-set-fullscreen");
  });

  it("grants core:window:allow-request-user-attention (the Flash Taskbar notification setting needs it)", () => {
    // core:window:default's implicit permission set is getters only — no
    // request-user-attention — so without this explicit grant, every
    // win.requestUserAttention() call is ACL-rejected and the default-on
    // "Flash Taskbar" setting silently does nothing.
    expect(find("core:window:allow-request-user-attention")).toBe(
      "core:window:allow-request-user-attention",
    );
  });

  it("filesystem grants stay under $APPLOG only", () => {
    // $APPDATA holds credential_fallback.json/.key, certs.json and
    // identity_pins.json. fs:default grants recursive read of the app data
    // directory, so the renderer could read the fallback store and every
    // saved server's pins; nothing in the frontend needs $APPDATA at all
    // (saves go through dialog-granted paths and $APPLOG). Any grant that
    // reaches $APPDATA is the blast radius this locks out.
    const fsPaths = permissions.flatMap((p) =>
      typeof p !== "string" && p.identifier.startsWith("fs:")
        ? [...(p.allow ?? []), ...(p.deny ?? [])].map((e) => e.path ?? "")
        : [],
    );
    expect(fsPaths.length).toBeGreaterThan(0);
    for (const path of fsPaths) {
      // $APPLOG itself (for a read-dir on the log directory) or a path under it.
      expect(path).toMatch(/^\$APPLOG(\/|$)/);
      expect(path).not.toMatch(/^\$APPDATA(\/|$)/);
    }
  });

  it("every fs permission is a scoped object with an explicit allow list", () => {
    const fsEntries = permissions.filter((p) =>
      (typeof p === "string" ? p : p.identifier).startsWith("fs:"),
    );
    expect(fsEntries.length).toBeGreaterThan(0);
    for (const entry of fsEntries) {
      expect(typeof entry, `${JSON.stringify(entry)} is an unscoped fs grant`).not.toBe("string");
      expect((entry as ScopedPermission).allow?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it("does not grant fs:default (its recursive read includes $APPDATA)", () => {
    expect(permissions).not.toContain("fs:default");
  });

  it("grants no write scope over $APPDATA", () => {
    const writes = permissions.flatMap((p) =>
      typeof p !== "string" &&
      p.identifier.startsWith("fs:") &&
      /write|mkdir|remove|rename|copy|create/.test(p.identifier)
        ? (p.allow ?? []).map((e) => e.path ?? "")
        : [],
    );
    for (const path of writes) {
      expect(path).not.toMatch(/^\$APPDATA(\/|$)/);
    }
  });
});
