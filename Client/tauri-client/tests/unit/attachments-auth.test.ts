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
  setServerHost,
} from "../../src/components/message-list/attachments";

function imageResponse() {
  return {
    ok: true,
    headers: { get: () => "image/png" },
    arrayBuffer: vi.fn().mockResolvedValue(Uint8Array.from([1, 2, 3]).buffer),
  };
}

describe("attachment fetch authentication", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    getTokenMock.mockReset();
    ensureHttpProxyMock.mockReset();
    clearAttachmentCaches();
    setServerHost("chat.example.com");
  });

  it("sends the bearer token through the TOFU proxy for server-hosted files", async () => {
    getTokenMock.mockReturnValue("session-token");
    ensureHttpProxyMock.mockResolvedValue("http://127.0.0.1:49812");
    fetchMock.mockResolvedValue(imageResponse());

    const result = await fetchImageAsDataUrl("https://chat.example.com/api/v1/files/abc-123");

    expect(result).not.toBeNull();
    expect(ensureHttpProxyMock).toHaveBeenCalledWith("chat.example.com");
    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:49812/api/v1/files/abc-123", {
      headers: { Authorization: "Bearer session-token" },
    });
  });

  it("omits the Authorization header when no session token exists", async () => {
    getTokenMock.mockReturnValue(null);
    ensureHttpProxyMock.mockResolvedValue("http://127.0.0.1:49812");
    fetchMock.mockResolvedValue(imageResponse());

    await fetchImageAsDataUrl("https://chat.example.com/api/v1/files/abc-456");

    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:49812/api/v1/files/abc-456", {
      headers: {},
    });
  });

  it("never sends the token to external hosts", async () => {
    getTokenMock.mockReturnValue("session-token");
    fetchMock.mockResolvedValue(imageResponse());

    await fetchImageAsDataUrl("https://cdn.external.example/image.png");

    expect(ensureHttpProxyMock).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith("https://cdn.external.example/image.png");
  });
});
