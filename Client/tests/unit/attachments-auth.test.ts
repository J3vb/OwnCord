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
vi.mock("../../src/features/content-consent/external", (importOriginal) =>
  mocks.consentExternalMock(importOriginal),
);
vi.mock("../../src/platform/desktop/externalContent", () =>
  mocks.externalContentMock(vi.fn(), mocks.brokerImageMock),
);

// No-op IndexedDB so fetchImageAsObjectUrl falls through to the network path.
vi.stubGlobal("indexedDB", mocks.failingIndexedDb());

import {
  clearAttachmentCaches,
  fetchImageAsObjectUrl,
  isTrustedServerUrl,
  setServerHost,
} from "../../src/features/messaging/content/attachments";

// jsdom implements no object URLs; server images are handed out as blob: URLs.
URL.createObjectURL = vi.fn(() => "blob:test-image");
URL.revokeObjectURL = vi.fn();

const {
  fetchMock,
  getTokenMock,
  ensureHttpProxyMock,
  arrangeServerImage,
  resetServerMocks,
  imageResponse,
} = mocks;
const { brokerImageMock } = mocks;

describe("attachment fetch authentication", () => {
  beforeEach(() => {
    resetServerMocks();
    clearAttachmentCaches();
    setServerHost("chat.example.com");
  });

  it("sends the bearer token through the TOFU proxy for server-hosted files", async () => {
    arrangeServerImage("session-token");

    const result = await fetchImageAsObjectUrl("https://chat.example.com/api/v1/files/abc-123");

    expect(result).not.toBeNull();
    expect(ensureHttpProxyMock).toHaveBeenCalledWith("chat.example.com");
    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:49812/api/v1/files/abc-123", {
      headers: { Authorization: "Bearer session-token" },
    });
  });

  it("omits the Authorization header when no session token exists", async () => {
    arrangeServerImage(null);

    await fetchImageAsObjectUrl("https://chat.example.com/api/v1/files/abc-456");

    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:49812/api/v1/files/abc-456", {
      headers: {},
    });
  });

  it("omits the token for a same-host path that is not server content", async () => {
    // A same-host avatar URL must not make every viewer issue an authenticated
    // request to an arbitrary path on the server's own origin. Only the
    // server-generated content routes (files, emoji and stickers) carry
    // the bearer token.
    arrangeServerImage("session-token");

    await fetchImageAsObjectUrl("https://chat.example.com/admin/api/stats");

    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:49812/admin/api/stats", {
      headers: {},
    });
  });

  it("still attaches the token to the server emoji content route", async () => {
    arrangeServerImage("session-token");

    await fetchImageAsObjectUrl("https://chat.example.com/api/v1/emoji/1/image");

    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:49812/api/v1/emoji/1/image", {
      headers: { Authorization: "Bearer session-token" },
    });
  });

  it("attaches the token to the server sticker image route", async () => {
    // The sticker image route needs a session like the emoji one; without the
    // token it answers 401 and every sticker shows as deleted.
    arrangeServerImage("session-token");

    const result = await fetchImageAsObjectUrl("https://chat.example.com/api/v1/stickers/7/image");

    expect(result).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:49812/api/v1/stickers/7/image", {
      headers: { Authorization: "Bearer session-token" },
    });
  });

  it("never sends the token to external hosts", async () => {
    getTokenMock.mockReturnValue("session-token");
    fetchMock.mockResolvedValue(imageResponse());

    brokerImageMock.mockResolvedValue({ ok: false, failure: "unavailable" });

    await fetchImageAsObjectUrl("https://cdn.external.example/image.png");

    // An external image goes to the external-content broker, whose request
    // carries no credentials at all — never to the TOFU proxy or a direct
    // fetch that could attach the bearer token (B7-16).
    expect(ensureHttpProxyMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(brokerImageMock).toHaveBeenCalledWith(expect.any(String), {
      url: "https://cdn.external.example/image.png",
    });
  });

  it("still routes through the TOFU proxy with a bearer token when the host is stored with an explicit :443", async () => {
    setServerHost("chat.example.com:443");
    arrangeServerImage("session-token");

    const result = await fetchImageAsObjectUrl("https://chat.example.com/api/v1/files/abc-789");

    expect(result).not.toBeNull();
    expect(ensureHttpProxyMock).toHaveBeenCalledWith("chat.example.com");
    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:49812/api/v1/files/abc-789", {
      headers: { Authorization: "Bearer session-token" },
    });
  });

  it("treats a :443-suffixed stored host as trusted for the port-less resolved URL", () => {
    setServerHost("chat.example.com:443");
    expect(isTrustedServerUrl("https://chat.example.com/api/v1/files/abc")).toBe(true);
  });
});
