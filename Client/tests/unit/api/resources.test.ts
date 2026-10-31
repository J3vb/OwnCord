import { describe, it, expect, vi, type Mock } from "vitest";
import * as mocks from "../../helpers/apiMocks";
import { createApiClient, type OnUnauthorized } from "../../../src/lib/api";
import { expectConsole } from "../../helpers/console";
import {
  jsonResponse,
  errorResponse,
  brokenJsonErrorResponse,
  fetchCallReaders,
  useDefaultApiClient,
} from "../../helpers/apiHarness";

vi.mock("@tauri-apps/plugin-http", () => mocks.pluginHttpMock());
vi.mock("../../../src/lib/net/httpProxy", () => mocks.netHttpProxyMock());

const { mockFetch } = mocks;

describe("API Client", () => {
  let api: ReturnType<typeof createApiClient>;
  let onUnauthorized: Mock<OnUnauthorized>;

  useDefaultApiClient(mockFetch, (client, unauthorized) => {
    api = client;
    onUnauthorized = unauthorized;
  });

  const { url: fetchCallUrl, init } = fetchCallReaders(mockFetch);
  const fetchCallOpts = (n = 0) => init(n) as Record<string, unknown>;

  describe("config management", () => {
    it("setConfig updates token", async () => {
      mockFetch.mockResolvedValue(jsonResponse({}));
      api.setConfig({ token: "new-token" });
      await api.getMe();
      const headers = fetchCallOpts().headers as Record<string, string>;
      expect(headers["Authorization"]).toBe("Bearer new-token");
    });

    it("getConfig returns config with redacted token", () => {
      const cfg = api.getConfig();
      expect(cfg.host).toBe("localhost:8443");
      expect(cfg.token).toBe("[redacted]");
    });

    it("getConfig returns undefined token when no token set", () => {
      const noTokenApi = createApiClient({ host: "h" });
      const cfg = noTokenApi.getConfig();
      expect(cfg.token).toBeUndefined();
    });

    it("omits Authorization header when no token is set", async () => {
      const noTokenApi = createApiClient({ host: "localhost:8443" });
      mockFetch.mockResolvedValue(jsonResponse({}));
      await noTokenApi.login("u", "p");
      const headers = fetchCallOpts().headers as Record<string, string>;
      expect(headers["Authorization"]).toBeUndefined();
      expect(headers["Content-Type"]).toBe("application/json");
    });

    // B4_conn_ipc-2: a host switch must not carry the previous host's bearer
    // token forward — otherwise a login/register request to a new server
    // rides a still-live session token for the old one.
    it("setConfig drops the previous token when switching to a different host without a new token", async () => {
      mockFetch.mockResolvedValue(jsonResponse({}));
      // `api` (beforeEach) already holds token "test-token" for "localhost:8443".
      api.setConfig({ host: "evil.example.com:8443" });
      await api.getMe();
      const headers = fetchCallOpts().headers as Record<string, string>;
      expect(headers["Authorization"]).toBeUndefined();
    });

    it("setConfig keeps the token when the host is unchanged", async () => {
      mockFetch.mockResolvedValue(jsonResponse({}));
      api.setConfig({ host: "localhost:8443" });
      await api.getMe();
      const headers = fetchCallOpts().headers as Record<string, string>;
      expect(headers["Authorization"]).toBe("Bearer test-token");
    });

    it("setConfig keeps a token provided alongside a host change", async () => {
      mockFetch.mockResolvedValue(jsonResponse({}));
      api.setConfig({ host: "new.example.com:8443", token: "fresh-token" });
      await api.getMe();
      const headers = fetchCallOpts().headers as Record<string, string>;
      expect(headers["Authorization"]).toBe("Bearer fresh-token");
    });

    // OC-0136: every other layer of this client (livekitSession.ts's
    // ensureLiveKitProxy, http_proxy.rs / livekit_proxy.rs's
    // validate_remote_host + parse_server_name) deliberately accepts IPv6
    // literals, bracketed or bare. setConfig's host gate must not be the one
    // place that refuses — otherwise login/register/auto-login to an IPv6
    // server throws "Invalid host format" even though the health check
    // (which tunnels through the same Rust proxy) already reported it
    // reachable.
    describe("host validation accepts IPv6 literals", () => {
      it("accepts a bracketed IPv6 literal with a port", () => {
        expect(() => api.setConfig({ host: "[::1]:8443" })).not.toThrow();
      });

      it("accepts a bracketed IPv6 literal without a port", () => {
        expect(() => api.setConfig({ host: "[fd00::1]" })).not.toThrow();
      });

      it("accepts a bare (unbracketed) IPv6 literal", () => {
        expect(() => api.setConfig({ host: "2001:db8::1" })).not.toThrow();
      });

      it("still rejects hosts with disallowed characters", () => {
        expect(() => api.setConfig({ host: "evil host name" })).toThrow("Invalid host format");
        expectConsole("error", /\[api\] setConfig rejected invalid host/);
      });

      it("still rejects hosts that could inject headers", () => {
        expect(() => api.setConfig({ host: "evil\r\nhost:8443" })).toThrow("Invalid host format");
        expectConsole("error", /\[api\] setConfig rejected invalid host/);
      });
    });
  });

  describe("user endpoints", () => {
    it("getMe calls GET /auth/me", async () => {
      mockFetch.mockResolvedValue(jsonResponse({ id: 1, username: "me" }));
      const result = await api.getMe();
      expect(fetchCallUrl()).toBe("https://localhost:8443/api/v1/auth/me");
      expect(fetchCallOpts().method).toBe("GET");
      expect(result).toEqual({ id: 1, username: "me" });
    });

    it("updateProfile sends PATCH /users/me with data", async () => {
      mockFetch.mockResolvedValue(jsonResponse({ id: 1, username: "newname" }));
      await api.updateProfile({ username: "newname" });
      expect(fetchCallUrl()).toBe("https://localhost:8443/api/v1/users/me");
      expect(fetchCallOpts().method).toBe("PATCH");
      const body = JSON.parse(fetchCallOpts().body as string);
      expect(body).toEqual({ username: "newname" });
    });

    it("updateProfile sends avatar field", async () => {
      mockFetch.mockResolvedValue(jsonResponse({ id: 1, avatar: "data:image/png;base64,abc" }));
      await api.updateProfile({ avatar: "data:image/png;base64,abc" });
      const body = JSON.parse(fetchCallOpts().body as string);
      expect(body.avatar).toBe("data:image/png;base64,abc");
    });

    it("updateProfile sends display_name and about, empty string included", async () => {
      mockFetch.mockResolvedValue(jsonResponse({ id: 1, username: "u" }));
      // "" is how the API says "clear it"; omitting a field means "leave it
      // alone", so the two must not be collapsed on the way out.
      await api.updateProfile({ username: "u", display_name: "Ada L.", about: "" });
      const body = JSON.parse(fetchCallOpts().body as string);
      expect(body).toEqual({ username: "u", display_name: "Ada L.", about: "" });
    });

    it("changePassword sends PUT /users/me/password", async () => {
      mockFetch.mockResolvedValue(jsonResponse(undefined, 204));
      await api.changePassword("oldpw", "newpw");
      expect(fetchCallUrl()).toBe("https://localhost:8443/api/v1/users/me/password");
      expect(fetchCallOpts().method).toBe("PUT");
      const body = JSON.parse(fetchCallOpts().body as string);
      // The server decodes json:"old_password" (Server/api/profile_handler.go),
      // and Go's encoding/json has no alias matching: any other key is a 400.
      expect(body).toEqual({ old_password: "oldpw", new_password: "newpw" });
    });

    it("changePassword resolves undefined on 204 and hands back the partial-success body on 200", async () => {
      // Server contract (profile_handler.go): when the password changed but
      // the other sessions could not be revoked, the answer is 200 with a
      // warning the user must see — a Promise<void> threw that away (OC-0314).
      mockFetch.mockResolvedValue(jsonResponse(undefined, 204));
      await expect(api.changePassword("oldpw", "newpw")).resolves.toBeUndefined();

      const partial = {
        warning:
          "password changed, but other sessions could not be revoked; revoke them from the sessions list",
        sessions_revoked: 0,
      };
      mockFetch.mockResolvedValue(jsonResponse(partial));
      await expect(api.changePassword("oldpw", "newpw")).resolves.toEqual(partial);
    });

    it("getSessions calls correct endpoint", async () => {
      mockFetch.mockResolvedValue(jsonResponse({ sessions: [] }));
      await api.getSessions();
      expect(fetchCallUrl()).toBe("https://localhost:8443/api/v1/users/me/sessions");
    });

    // Regression for v112: the server wraps the list in a {sessions: [...]}
    // envelope (Server/api/profile_handler.go's sessionsListResponse); a bare
    // array would make every consumer's .map/.length fail or read undefined.
    it("getSessions unwraps the {sessions: [...]} envelope", async () => {
      const session = {
        id: 1,
        device: "Chrome on Linux",
        ip: "127.0.0.1",
        created_at: "2026-01-01T00:00:00Z",
        last_used: "2026-01-02T00:00:00Z",
        is_current: true,
        unseen: true,
      };
      mockFetch.mockResolvedValue(jsonResponse({ sessions: [session] }));
      const result = await api.getSessions();
      expect(result).toEqual([session]);
    });

    it("revokeSession calls DELETE with session ID", async () => {
      mockFetch.mockResolvedValue(jsonResponse(undefined, 204));
      await api.revokeSession(42);
      expect(fetchCallUrl()).toBe("https://localhost:8443/api/v1/users/me/sessions/42");
      expect(fetchCallOpts().method).toBe("DELETE");
    });

    it("revokeAllSessions calls DELETE /users/me/sessions and returns the body", async () => {
      const body = { sessions_revoked: 3, current_session_revoked: true };
      mockFetch.mockResolvedValue(jsonResponse(body));
      await expect(api.revokeAllSessions()).resolves.toEqual(body);
      expect(fetchCallUrl()).toBe("https://localhost:8443/api/v1/users/me/sessions");
      expect(fetchCallOpts().method).toBe("DELETE");
    });
  });

  describe("channel endpoints", () => {
    it("getPins calls GET /channels/{id}/pins", async () => {
      mockFetch.mockResolvedValue(jsonResponse({ messages: [] }));
      await api.getPins(7);
      expect(fetchCallUrl()).toBe("https://localhost:8443/api/v1/channels/7/pins");
      expect(fetchCallOpts().method).toBe("GET");
    });

    it("pinMessage calls POST /channels/{id}/pins/{msgId}", async () => {
      mockFetch.mockResolvedValue(jsonResponse(undefined, 204));
      await api.pinMessage(7, 99);
      expect(fetchCallUrl()).toBe("https://localhost:8443/api/v1/channels/7/pins/99");
      expect(fetchCallOpts().method).toBe("POST");
    });

    it("unpinMessage calls DELETE /channels/{id}/pins/{msgId}", async () => {
      mockFetch.mockResolvedValue(jsonResponse(undefined, 204));
      await api.unpinMessage(7, 99);
      expect(fetchCallUrl()).toBe("https://localhost:8443/api/v1/channels/7/pins/99");
      expect(fetchCallOpts().method).toBe("DELETE");
    });

    it("discardUpload calls DELETE /uploads/{id}", async () => {
      mockFetch.mockResolvedValue(jsonResponse(undefined, 204));
      await api.discardUpload("a1b2");
      expect(fetchCallUrl()).toBe("https://localhost:8443/api/v1/uploads/a1b2");
      expect(fetchCallOpts().method).toBe("DELETE");
    });

    it("purgeMessages posts the limit to /channels/{id}/messages/purge", async () => {
      mockFetch.mockResolvedValue(jsonResponse({ channel_id: 7, ids: [3, 2], count: 2 }));
      const result = await api.purgeMessages(7, 25);
      expect(fetchCallUrl()).toBe("https://localhost:8443/api/v1/channels/7/messages/purge");
      expect(fetchCallOpts().method).toBe("POST");
      expect(JSON.parse(String(fetchCallOpts().body))).toEqual({ limit: 25 });
      expect(result.count).toBe(2);
    });

    it("purgeMessages includes before only when supplied", async () => {
      mockFetch.mockResolvedValue(jsonResponse({ channel_id: 7, ids: [], count: 0 }));
      await api.purgeMessages(7, 10, { before: 42 });
      expect(JSON.parse(String(fetchCallOpts().body))).toEqual({ limit: 10, before: 42 });
    });
  });

  describe("search endpoint", () => {
    it("passes channelId and limit options", async () => {
      mockFetch.mockResolvedValue(jsonResponse({ results: [] }));
      await api.search("hello", { channelId: 3, limit: 10 });
      const url = fetchCallUrl();
      expect(url).toContain("q=hello");
      expect(url).toContain("channel_id=3");
      expect(url).toContain("limit=10");
    });

    it("works with query only (no options)", async () => {
      mockFetch.mockResolvedValue(jsonResponse({ results: [] }));
      await api.search("test");
      const url = fetchCallUrl();
      expect(url).toContain("q=test");
      expect(url).not.toContain("channel_id");
      expect(url).not.toContain("limit");
    });

    it("passes sort and before for newest-first paging", async () => {
      mockFetch.mockResolvedValue(jsonResponse({ results: [], next_before: null }));
      const resp = await api.search("hello", { channelId: 3, sort: "recent", before: 42 });
      const url = fetchCallUrl();
      expect(url).toContain("sort=recent");
      expect(url).toContain("before=42");
      expect(resp.next_before).toBeNull();
    });

    it("a before cursor implies sort=recent rather than an invalid pairing", async () => {
      mockFetch.mockResolvedValue(jsonResponse({ results: [] }));
      await api.search("hello", { before: 7 });
      const url = fetchCallUrl();
      expect(url).toContain("sort=recent");
      expect(url).toContain("before=7");
    });
  });

  describe("file upload", () => {
    it("uploadFile sends POST /uploads with FormData", async () => {
      mockFetch.mockResolvedValue(
        jsonResponse({ url: "https://cdn/file.png", filename: "file.png" }),
      );
      const file = new File(["hello"], "file.png", { type: "image/png" });
      const result = await api.uploadFile(file);

      expect(fetchCallUrl()).toBe("https://localhost:8443/api/v1/uploads");
      expect(fetchCallOpts().method).toBe("POST");
      // Should use FormData (not JSON)
      expect(fetchCallOpts().body).toBeInstanceOf(FormData);
      // Auth header should be present
      const headers = fetchCallOpts().headers as Record<string, string>;
      expect(headers["Authorization"]).toBe("Bearer test-token");
      // Should NOT set Content-Type (browser sets multipart boundary)
      expect(headers["Content-Type"]).toBeUndefined();
      expect(result).toEqual({ url: "https://cdn/file.png", filename: "file.png" });
    });

    it("uploadAvatar posts multipart to /users/me/avatar", async () => {
      mockFetch.mockResolvedValue(
        jsonResponse({
          id: "abc",
          filename: "me.png",
          size: 100,
          mime: "image/png",
          url: "/api/v1/files/abc",
        }),
      );
      const file = new File(["png"], "me.png", { type: "image/png" });
      const result = await api.uploadAvatar(file);

      expect(fetchCallUrl()).toBe("https://localhost:8443/api/v1/users/me/avatar");
      expect(fetchCallOpts().method).toBe("POST");
      expect(fetchCallOpts().body).toBeInstanceOf(FormData);
      const headers = fetchCallOpts().headers as Record<string, string>;
      expect(headers["Authorization"]).toBe("Bearer test-token");
      // The browser has to set the multipart boundary itself.
      expect(headers["Content-Type"]).toBeUndefined();
      // The URL the server stored is what the caller needs back.
      expect(result.url).toBe("/api/v1/files/abc");
    });

    it("uploadAvatar surfaces a rejected image as an ApiClientError", async () => {
      mockFetch.mockResolvedValue(
        errorResponse(400, "BAD_REQUEST", "avatar must be a PNG, JPEG or WebP image"),
      );
      const file = new File(["x"], "me.gif", { type: "image/gif" });
      await expect(api.uploadAvatar(file)).rejects.toMatchObject({
        status: 400,
        code: "BAD_REQUEST",
      });
      expectConsole("warn", /\[api\] API error/);
    });

    it("uploadAvatar calls onUnauthorized on 401", async () => {
      mockFetch.mockResolvedValue(errorResponse(401, "UNAUTHORIZED", "Invalid session"));
      const file = new File(["x"], "me.png", { type: "image/png" });
      await expect(api.uploadAvatar(file)).rejects.toMatchObject({ status: 401 });
      expectConsole("warn", /\[api\] API error/);
      expect(onUnauthorized).toHaveBeenCalledTimes(1);
    });

    it("removeAvatar sends DELETE /users/me/avatar and returns the user", async () => {
      mockFetch.mockResolvedValue(
        jsonResponse({ id: 1, username: "alice", role: "member", status: "online" }),
      );
      const user = await api.removeAvatar("alice");

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(fetchCallUrl()).toBe("https://localhost:8443/api/v1/users/me/avatar");
      expect(fetchCallOpts().method).toBe("DELETE");
      expect(user.username).toBe("alice");
    });

    it("removeAvatar falls back to PATCH /users/me on 405 (older server)", async () => {
      mockFetch
        .mockResolvedValueOnce(errorResponse(405, "METHOD_NOT_ALLOWED", "no"))
        .mockResolvedValueOnce(
          jsonResponse({ id: 1, username: "alice", role: "member", status: "online" }),
        );
      const user = await api.removeAvatar("alice");
      expectConsole("warn", /\[api\] API error/);

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(fetchCallUrl(1)).toBe("https://localhost:8443/api/v1/users/me");
      expect(fetchCallOpts(1).method).toBe("PATCH");
      expect(JSON.parse(fetchCallOpts(1).body as string)).toEqual({
        username: "alice",
        avatar: "",
      });
      expect(user.avatar ?? null).toBeNull();
    });

    it("removeAvatar rethrows any other failure without the PATCH fallback", async () => {
      mockFetch.mockResolvedValue(errorResponse(500, "INTERNAL", "boom"));
      await expect(api.removeAvatar("alice")).rejects.toMatchObject({ status: 500 });
      expectConsole("warn", /\[api\] API error/);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("uploadFile throws ApiClientError on non-ok", async () => {
      mockFetch.mockResolvedValue(errorResponse(413, "FILE_TOO_LARGE", "File exceeds limit"));
      const file = new File(["x"], "big.bin");
      await expect(api.uploadFile(file)).rejects.toMatchObject({
        status: 413,
        code: "FILE_TOO_LARGE",
      });
      expectConsole("warn", /\[api\] API error/);
    });

    it("uploadFile calls onUnauthorized on 401 like other REST calls", async () => {
      mockFetch.mockResolvedValue(errorResponse(401, "UNAUTHORIZED", "Invalid session"));
      const file = new File(["x"], "f.txt");
      await expect(api.uploadFile(file)).rejects.toMatchObject({ status: 401 });
      expectConsole("warn", /\[api\] API error/);
      expect(onUnauthorized).toHaveBeenCalledTimes(1);
    });

    it("uploadFile does not call onUnauthorized on other errors", async () => {
      mockFetch.mockResolvedValue(errorResponse(500, "SERVER_ERROR", "Internal error"));
      const file = new File(["x"], "f.txt");
      await expect(api.uploadFile(file)).rejects.toThrow();
      expectConsole("warn", /\[api\] API error/);
      expect(onUnauthorized).not.toHaveBeenCalled();
    });

    it("uploadFile omits Authorization header when no token set", async () => {
      const noTokenApi = createApiClient({ host: "localhost:8443" });
      mockFetch.mockResolvedValue(jsonResponse({ url: "https://cdn/f.png", filename: "f.png" }));
      const file = new File(["data"], "f.png");
      await noTokenApi.uploadFile(file);
      const headers = fetchCallOpts().headers as Record<string, string>;
      expect(headers["Authorization"]).toBeUndefined();
    });

    it("uploadFile passes AbortSignal", async () => {
      mockFetch.mockResolvedValue(jsonResponse({ url: "u", filename: "f" }));
      const controller = new AbortController();
      await api.uploadFile(new File(["x"], "f"), controller.signal);
      // Requests combine caller cancellation with the session lifetime.
      expect(fetchCallOpts().signal).toBeInstanceOf(AbortSignal);
    });

    it("uploadFile parseError fallback on non-JSON error body", async () => {
      mockFetch.mockResolvedValue(brokenJsonErrorResponse(500, "Internal Server Error"));
      const file = new File(["x"], "f");
      await expect(api.uploadFile(file)).rejects.toMatchObject({
        status: 500,
        code: "UNKNOWN",
        message: "Internal Server Error",
      });
      expectConsole("warn", /\[api\] API error/);
    });
  });

  describe("invite endpoints", () => {
    it("getInvites calls GET /invites", async () => {
      mockFetch.mockResolvedValue(jsonResponse([]));
      const result = await api.getInvites();
      expect(fetchCallUrl()).toBe("https://localhost:8443/api/v1/invites");
      expect(fetchCallOpts().method).toBe("GET");
      expect(result).toEqual([]);
    });

    it("createInvite calls POST /invites with data", async () => {
      mockFetch.mockResolvedValue(jsonResponse({ id: 1, code: "abc123", max_uses: 5 }));
      const result = await api.createInvite({ max_uses: 5, expires_in_hours: 24 });
      expect(fetchCallUrl()).toBe("https://localhost:8443/api/v1/invites");
      expect(fetchCallOpts().method).toBe("POST");
      const body = JSON.parse(fetchCallOpts().body as string);
      expect(body).toEqual({ max_uses: 5, expires_in_hours: 24 });
      expect(result.code).toBe("abc123");
    });

    it("revokeInvite calls DELETE /invites/{code}", async () => {
      mockFetch.mockResolvedValue(jsonResponse(undefined, 204));
      await api.revokeInvite("abc123");
      expect(fetchCallUrl()).toBe("https://localhost:8443/api/v1/invites/abc123");
      expect(fetchCallOpts().method).toBe("DELETE");
    });
  });

  describe("emoji endpoints", () => {
    it("listEmoji calls GET /emoji", async () => {
      mockFetch.mockResolvedValue(
        jsonResponse([{ id: 1, shortcode: "smile", url: "/api/v1/emoji/1/image" }]),
      );
      const result = await api.listEmoji();
      expect(fetchCallUrl()).toBe("https://localhost:8443/api/v1/emoji");
      expect(fetchCallOpts().method).toBe("GET");
      expect(result).toEqual([{ id: 1, shortcode: "smile", url: "/api/v1/emoji/1/image" }]);
    });

    it("uploadEmoji POSTs multipart with the shortcode and file", async () => {
      mockFetch.mockResolvedValue(
        jsonResponse({ id: 7, shortcode: "wave", url: "/api/v1/emoji/7/image" }, 201),
      );
      const file = new File(["png"], "wave.png", { type: "image/png" });
      const result = await api.uploadEmoji("wave", file);

      expect(fetchCallUrl()).toBe("https://localhost:8443/api/v1/emoji");
      const opts = fetchCallOpts();
      expect(opts.method).toBe("POST");
      const body = opts.body as FormData;
      expect(body.get("shortcode")).toBe("wave");
      expect(body.get("file")).toBe(file);
      // The browser owns the multipart boundary — setting Content-Type breaks it.
      expect((opts.headers as Record<string, string>)["Content-Type"]).toBeUndefined();
      expect(result.shortcode).toBe("wave");
    });

    it("uploadEmoji calls onUnauthorized on 401", async () => {
      mockFetch.mockResolvedValue(errorResponse(401, "UNAUTHORIZED", "Invalid session"));
      const file = new File(["png"], "wave.png", { type: "image/png" });
      await expect(api.uploadEmoji("wave", file)).rejects.toMatchObject({ status: 401 });
      expectConsole("warn", /\[api\] API error/);
      expect(onUnauthorized).toHaveBeenCalledTimes(1);
    });

    it("uploadEmoji surfaces a 403 without calling onUnauthorized", async () => {
      mockFetch.mockResolvedValue(errorResponse(403, "FORBIDDEN", "insufficient permissions"));
      const file = new File(["png"], "wave.png", { type: "image/png" });
      await expect(api.uploadEmoji("wave", file)).rejects.toMatchObject({
        status: 403,
        code: "FORBIDDEN",
      });
      expectConsole("warn", /\[api\] API error/);
      expect(onUnauthorized).not.toHaveBeenCalled();
    });

    it("deleteEmoji calls DELETE /emoji/{id}", async () => {
      mockFetch.mockResolvedValue(jsonResponse(undefined, 204));
      await api.deleteEmoji(5);
      expect(fetchCallUrl()).toBe("https://localhost:8443/api/v1/emoji/5");
      expect(fetchCallOpts().method).toBe("DELETE");
    });
  });

  describe("sticker endpoints", () => {
    const sticker = { id: 3, name: "Wave", emoji: "👋", url: "/api/v1/stickers/3/image" };

    it("listStickers calls GET /stickers", async () => {
      mockFetch.mockResolvedValue(jsonResponse([sticker]));
      const result = await api.listStickers();
      expect(fetchCallUrl()).toBe("https://localhost:8443/api/v1/stickers");
      expect(fetchCallOpts().method).toBe("GET");
      expect(result).toEqual([sticker]);
    });
  });

  describe("DM endpoints", () => {
    it("getDmChannels calls GET /dms", async () => {
      mockFetch.mockResolvedValue(jsonResponse({ channels: [] }));
      const result = await api.getDmChannels();
      expect(fetchCallUrl()).toBe("https://localhost:8443/api/v1/dms");
      expect(fetchCallOpts().method).toBe("GET");
      expect(result).toEqual({ channels: [] });
    });

    it("createDm calls POST /dms with recipient_id", async () => {
      mockFetch.mockResolvedValue(jsonResponse({ channel: { id: 10, type: "dm" } }));
      const result = await api.createDm(42);
      expect(fetchCallUrl()).toBe("https://localhost:8443/api/v1/dms");
      expect(fetchCallOpts().method).toBe("POST");
      const body = JSON.parse(fetchCallOpts().body as string);
      expect(body).toEqual({ recipient_id: 42 });
      expect(result).toEqual({ channel: { id: 10, type: "dm" } });
    });

    it("createGroupDm calls POST /dms/group with recipient_ids and a name", async () => {
      mockFetch.mockResolvedValue(jsonResponse({ channel_id: 11, is_group: true }));
      const result = await api.createGroupDm([2, 3], "Crew");
      expect(fetchCallUrl()).toBe("https://localhost:8443/api/v1/dms/group");
      expect(fetchCallOpts().method).toBe("POST");
      expect(JSON.parse(fetchCallOpts().body as string)).toEqual({
        recipient_ids: [2, 3],
        name: "Crew",
      });
      expect(result).toEqual({ channel_id: 11, is_group: true });
    });

    it("createGroupDm sends an empty name when none is given", async () => {
      mockFetch.mockResolvedValue(jsonResponse({ channel_id: 11 }));
      await api.createGroupDm([2, 3]);
      expect(JSON.parse(fetchCallOpts().body as string)).toEqual({
        recipient_ids: [2, 3],
        name: "",
      });
    });

    it("renameGroupDm calls PATCH /dms/{channelId}", async () => {
      mockFetch.mockResolvedValue(jsonResponse({ channel_id: 11, name: "New" }));
      await api.renameGroupDm(11, "New");
      expect(fetchCallUrl()).toBe("https://localhost:8443/api/v1/dms/11");
      expect(fetchCallOpts().method).toBe("PATCH");
      expect(JSON.parse(fetchCallOpts().body as string)).toEqual({ name: "New" });
    });

    it("addGroupDmMembers calls POST /dms/{id}/members with user_ids and returns the summary", async () => {
      mockFetch.mockResolvedValue(jsonResponse({ channel_id: 11, owner_id: 1 }));
      const result = await api.addGroupDmMembers(11, [4, 5]);
      expect(fetchCallUrl()).toBe("https://localhost:8443/api/v1/dms/11/members");
      expect(fetchCallOpts().method).toBe("POST");
      expect(JSON.parse(fetchCallOpts().body as string)).toEqual({ user_ids: [4, 5] });
      expect(result).toEqual({ channel_id: 11, owner_id: 1 });
    });

    it("addGroupDmMembers and setGroupDmOwner resolve undefined on a 204", async () => {
      mockFetch.mockResolvedValue(jsonResponse(undefined, 204));
      await expect(api.addGroupDmMembers(11, [4])).resolves.toBeUndefined();
      await expect(api.setGroupDmOwner(11, 4)).resolves.toBeUndefined();
    });

    it("uploadGroupDmIcon posts multipart `file` to /dms/{id}/icon and returns the summary", async () => {
      mockFetch.mockResolvedValue(jsonResponse({ channel_id: 11, icon: "/api/v1/files/9" }));
      const file = new File(["x"], "group-icon.png", { type: "image/png" });
      const result = await api.uploadGroupDmIcon(11, file);
      expect(fetchCallUrl()).toBe("https://localhost:8443/api/v1/dms/11/icon");
      expect(fetchCallOpts().method).toBe("POST");
      const body = fetchCallOpts().body as FormData;
      expect(body).toBeInstanceOf(FormData);
      expect((body.get("file") as File).name).toBe("group-icon.png");
      expect(result).toEqual({ channel_id: 11, icon: "/api/v1/files/9" });
    });

    it("uploadGroupDmIcon and removeGroupDmIcon resolve undefined on a 204", async () => {
      mockFetch.mockResolvedValue(jsonResponse(undefined, 204));
      await expect(api.uploadGroupDmIcon(11, new File(["x"], "a.png"))).resolves.toBeUndefined();
      await expect(api.removeGroupDmIcon(11)).resolves.toBeUndefined();
    });

    it("removeGroupDmIcon calls DELETE /dms/{id}/icon", async () => {
      mockFetch.mockResolvedValue(jsonResponse({ channel_id: 11, icon: "" }));
      const result = await api.removeGroupDmIcon(11);
      expect(fetchCallUrl()).toBe("https://localhost:8443/api/v1/dms/11/icon");
      expect(fetchCallOpts().method).toBe("DELETE");
      expect(result).toEqual({ channel_id: 11, icon: "" });
    });

    it("removeGroupDmMember calls DELETE /dms/{id}/members/{userId}", async () => {
      mockFetch.mockResolvedValue(jsonResponse(undefined, 204));
      await api.removeGroupDmMember(11, 4);
      expect(fetchCallUrl()).toBe("https://localhost:8443/api/v1/dms/11/members/4");
      expect(fetchCallOpts().method).toBe("DELETE");
    });

    it("setGroupDmOwner calls PUT /dms/{id}/owner with user_id", async () => {
      mockFetch.mockResolvedValue(jsonResponse({ channel_id: 11, owner_id: 4 }));
      const result = await api.setGroupDmOwner(11, 4);
      expect(fetchCallUrl()).toBe("https://localhost:8443/api/v1/dms/11/owner");
      expect(fetchCallOpts().method).toBe("PUT");
      expect(JSON.parse(fetchCallOpts().body as string)).toEqual({ user_id: 4 });
      expect(result).toEqual({ channel_id: 11, owner_id: 4 });
    });

    it("closeDm calls DELETE /dms/{channelId}", async () => {
      mockFetch.mockResolvedValue(jsonResponse(undefined, 204));
      await api.closeDm(10);
      expect(fetchCallUrl()).toBe("https://localhost:8443/api/v1/dms/10");
      expect(fetchCallOpts().method).toBe("DELETE");
    });
  });

  describe("voice endpoints", () => {
    it("getVoiceCredentials calls GET /voice/credentials", async () => {
      mockFetch.mockResolvedValue(jsonResponse({ url: "wss://lk", token: "vt" }));
      const result = await api.getVoiceCredentials();
      expect(fetchCallUrl()).toBe("https://localhost:8443/api/v1/voice/credentials");
      expect(fetchCallOpts().method).toBe("GET");
      expect(result).toEqual({ url: "wss://lk", token: "vt" });
    });
  });
});
