// OC-0241: setServerHost/resolveServerUrl never bracket a bare IPv6 host, so
// on such a server every avatar falls back to a letter and every image
// attachment fails to load (and loses its bearer token). See
// attachments.ts::setServerHost / resolveServerUrl / isTrustedServerUrl.
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as mocks from "../helpers/attachmentsMocks";

vi.mock("@tauri-apps/plugin-http", () => mocks.httpPluginMock(mocks.fetchMock));
vi.mock("@lib/net/httpProxy", () => mocks.httpProxyMock(mocks.ensureHttpProxyMock));
vi.mock("@stores/auth.store", () => mocks.authStoreMock(mocks.getTokenMock));
vi.mock("@lib/logger", () => mocks.loggerMock());
vi.mock("@tauri-apps/plugin-dialog", () => mocks.dialogMock());
vi.mock("@tauri-apps/plugin-fs", () => mocks.fsMock());
vi.mock("@lib/icons", () => mocks.iconsMock());
vi.mock("@lib/prefs/mediaVisibility", () => mocks.mediaVisibilityMock());
vi.mock("../../src/features/messaging/content/media", () => mocks.contentMediaMock());

// No-op IndexedDB so fetchImageAsObjectUrl falls through to the network path.
vi.stubGlobal("indexedDB", mocks.failingIndexedDb());

import {
  clearAttachmentCaches,
  fetchImageAsObjectUrl,
  isTrustedServerUrl,
  resolveServerUrl,
  setServerHost,
} from "../../src/features/messaging/content/attachments";

// jsdom implements no object URLs; server images are handed out as blob: URLs.
URL.createObjectURL = vi.fn(() => "blob:test-image");
URL.revokeObjectURL = vi.fn();

const { fetchMock, ensureHttpProxyMock, arrangeServerImage, resetServerMocks } = mocks;

describe("attachment server-host handling for bare IPv6 literals", () => {
  beforeEach(() => {
    resetServerMocks();
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
    arrangeServerImage("session-token");

    const resolved = resolveServerUrl("/api/v1/files/abc-123");
    const result = await fetchImageAsObjectUrl(resolved);

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
