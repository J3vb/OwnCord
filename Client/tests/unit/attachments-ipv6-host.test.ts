// OC-0241: setServerHost/resolveServerUrl never bracket a bare IPv6 host, so
// on such a server every avatar falls back to a letter and every image
// attachment fails to load (and loses its bearer token). See
// attachments.ts::setServerHost / resolveServerUrl / isTrustedServerUrl.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { fetchMock, getTokenMock, ensureHttpProxyMock } = vi.hoisted(() => ({
  fetchMock: vi.fn<any>(),
  getTokenMock: vi.fn<any>(),
  ensureHttpProxyMock: vi.fn<any>(),
}));

vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: fetchMock,
}));

vi.mock("@lib/httpProxy", () => ({
  ensureHttpProxy: ensureHttpProxyMock,
}));

vi.mock("@stores/auth.store", () => ({
  getToken: getTokenMock,
}));

vi.mock("@lib/logger", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn() }));
vi.mock("@tauri-apps/plugin-fs", () => ({ writeFile: vi.fn() }));
vi.mock("@lib/icons", () => ({ createIcon: () => document.createElement("span") }));
vi.mock("@lib/media-visibility", () => ({ observeMedia: vi.fn() }));
vi.mock("../../src/components/message-list/media", () => ({ openImageLightbox: vi.fn() }));

// No-op IndexedDB so fetchImageAsDataUrl falls through to the network path.
vi.stubGlobal("indexedDB", {
  open: () => {
    const req: Record<string, unknown> = { onsuccess: null, onerror: null, onupgradeneeded: null };
    Promise.resolve().then(() => {
      const fn = req.onerror as ((ev: Event) => void) | null;
      fn?.(new Event("error"));
    });
    return req;
  },
});

import {
  clearAttachmentCaches,
  fetchImageAsDataUrl,
  isTrustedServerUrl,
  resolveServerUrl,
  setServerHost,
} from "../../src/components/message-list/attachments";

function imageResponse() {
  return {
    ok: true,
    headers: { get: () => "image/png" },
    arrayBuffer: vi.fn().mockResolvedValue(Uint8Array.from([1, 2, 3]).buffer),
  };
}

describe("attachment server-host handling for bare IPv6 literals", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    getTokenMock.mockReset();
    ensureHttpProxyMock.mockReset();
    clearAttachmentCaches();
  });

  it("brackets a bare IPv6 host so resolveServerUrl produces a parseable URL", () => {
    setServerHost("2001:db8::1");

    const resolved = resolveServerUrl("/api/v1/files/7");

    // A bare IPv6 authority is not a legal URL — WHATWG requires brackets.
    expect(resolved).toBe("https://[2001:db8::1]/api/v1/files/7");
    expect(() => new URL(resolved)).not.toThrow();
  });

  it("recognizes the resolved URL as a trusted server URL for a bare IPv6 host", () => {
    setServerHost("2001:db8::1");

    const resolved = resolveServerUrl("/api/v1/files/7");

    expect(isTrustedServerUrl(resolved)).toBe(true);
  });

  it("routes an IPv6-hosted attachment through the TOFU proxy with the bearer token", async () => {
    setServerHost("2001:db8::1");
    getTokenMock.mockReturnValue("session-token");
    ensureHttpProxyMock.mockResolvedValue("http://127.0.0.1:49812");
    fetchMock.mockResolvedValue(imageResponse());

    const resolved = resolveServerUrl("/api/v1/files/abc-123");
    const result = await fetchImageAsDataUrl(resolved);

    expect(result).not.toBeNull();
    expect(ensureHttpProxyMock).toHaveBeenCalledWith("[2001:db8::1]");
    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:49812/api/v1/files/abc-123", {
      headers: { Authorization: "Bearer session-token" },
    });
  });

  it("does not mistake a bare IPv6 literal ending in the '443' hextet for a default-port suffix", () => {
    // "fd00::443" is a complete, valid bare IPv6 literal — the trailing
    // ":443" here is part of the address, not a port. Blindly stripping
    // ":443" (as a naive trailing-port strip would) truncates the address to
    // "fd00:", pinning/serving a different host than the ws/livekit proxies
    // use for the same server (mirrors tofu.rs::cert_store_key, OC-0215).
    setServerHost("fd00::443");

    const resolved = resolveServerUrl("/api/v1/files/7");

    expect(resolved).toBe("https://[fd00::443]/api/v1/files/7");
  });

  it("still strips an explicit :443 default port from an already-bracketed IPv6 host", () => {
    setServerHost("[2001:db8::1]:443");

    const resolved = resolveServerUrl("/api/v1/files/7");

    expect(resolved).toBe("https://[2001:db8::1]/api/v1/files/7");
  });
});
