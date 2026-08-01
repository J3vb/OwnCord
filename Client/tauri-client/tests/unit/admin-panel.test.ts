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
