import { describe, it, expect, vi, beforeEach } from "vitest";

const openUrl = vi.fn(async () => {});
vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl,
}));

import { adminPanelUrl, openAdminPanel } from "@lib/admin-panel";

describe("adminPanelUrl", () => {
  it("points at the server's /admin path over https", () => {
    expect(adminPanelUrl("chat.example.com")).toBe("https://chat.example.com/admin");
  });

  it("keeps an explicit port", () => {
    expect(adminPanelUrl("localhost:8443")).toBe("https://localhost:8443/admin");
  });

  it("deep-links a section with a fragment", () => {
    expect(adminPanelUrl("localhost:8443", "audit")).toBe("https://localhost:8443/admin#audit");
  });

  it("omits the fragment for an empty section", () => {
    expect(adminPanelUrl("localhost:8443", "")).toBe("https://localhost:8443/admin");
  });

  // The REST client tunnels through a loopback TOFU proxy so the webview can
  // reach a self-signed server. That origin means nothing to an external
  // browser, so the panel URL must be the real host.
  it("does not route through the local http proxy", () => {
    expect(adminPanelUrl("localhost:8443")).not.toContain("127.0.0.1");
  });

  // A bare IPv6 host is a valid, accepted server address (hostValidation.ts,
  // livekitSession.ts's ensureLiveKitProxy, ws.ts's bracketBareIPv6Host) but
  // RFC 3986 requires brackets around an IPv6 literal authority — without
  // them the string isn't a valid absolute URL at all (OC-0190).
  it("brackets a bare IPv6 host", () => {
    expect(adminPanelUrl("::1")).toBe("https://[::1]/admin");
  });

  it("brackets a bare IPv6 host with a deep-linked section", () => {
    expect(adminPanelUrl("2001:db8::1", "audit")).toBe("https://[2001:db8::1]/admin#audit");
  });

  it("leaves an already-bracketed IPv6 host unchanged", () => {
    expect(adminPanelUrl("[::1]:8443")).toBe("https://[::1]:8443/admin");
  });
});

describe("openAdminPanel", () => {
  beforeEach(() => {
    openUrl.mockClear();
  });

  it("hands the URL to the system opener", async () => {
    await openAdminPanel("localhost:8443", "audit");
    expect(openUrl).toHaveBeenCalledWith("https://localhost:8443/admin#audit");
  });
});
