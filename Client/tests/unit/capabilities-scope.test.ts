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
  it("http:allow-fetch allows exactly the https wildcard plus loopback http", () => {
    const fetchPerm = find("http:allow-fetch") as ScopedPermission;
    expect(urls(fetchPerm.allow).sort()).toEqual(
      ["http://127.0.0.1:*", "https://*", "https://*:*"].sort(),
    );
  });

  it("http:allow-fetch denies https loopback literals", () => {
    const fetchPerm = find("http:allow-fetch") as ScopedPermission;
    // All legitimate server traffic reaches loopback over http (the Rust TOFU
    // proxy). An https loopback fetch can only be an attempt to reach some
    // other local service, so deny it — deny wins over allow in Tauri's scope.
    expect(urls(fetchPerm.deny).sort()).toEqual(
      [
        "https://127.0.0.1",
        "https://127.0.0.1:*",
        "https://localhost",
        "https://localhost:*",
      ].sort(),
    );
  });

  it.each(["http:allow-fetch-send", "http:allow-fetch-read-body"])(
    "%s is a bare identifier (a scope there would be inert)",
    (identifier) => {
      expect(find(identifier)).toBe(identifier);
    },
  );

  it("no permission grants a plaintext-http or any-scheme wildcard", () => {
    const allUrls = permissions.flatMap((p) =>
      typeof p === "string" ? [] : [...urls(p.allow), ...urls(p.deny)],
    );
    for (const url of allUrls) {
      expect(url.startsWith("http://") && !url.startsWith("http://127.0.0.1")).toBe(false);
      expect(url).not.toMatch(/^\*|^[a-z]*:\/\/\*\.?\*/);
    }
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

  it("filesystem grants stay under $APPDATA/$APPLOG", () => {
    const fsPaths = permissions.flatMap((p) =>
      typeof p !== "string" && p.identifier.startsWith("fs:")
        ? (p.allow ?? []).map((e) => e.path ?? "")
        : [],
    );
    expect(fsPaths.length).toBeGreaterThan(0);
    for (const path of fsPaths) {
      expect(path).toMatch(/^\$APP(DATA|LOG)\//);
    }
  });
});
