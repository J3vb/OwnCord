import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the Tauri HTTP plugin — vi.hoisted ensures the fn is available when
// vi.mock's factory runs (hoisted above all imports).
const { mockFetch } = vi.hoisted(() => ({
  mockFetch: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: mockFetch,
}));

import { createApiClient, ApiClientError } from "../../src/lib/api";

function jsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "OK",
    json: () => Promise.resolve(data),
    headers: new Headers(),
  } as unknown as Response;
}

function errorResponse(
  status: number,
  code: string,
  message: string,
): Response {
  return {
    ok: false,
    status,
    statusText: message,
    json: () => Promise.resolve({ error: code, message }),
    headers: new Headers(),
  } as unknown as Response;
}

/** Error response whose json() throws (simulates non-JSON body). */
function brokenJsonErrorResponse(status: number, statusText: string): Response {
  return {
    ok: false,
    status,
    statusText,
    json: () => Promise.reject(new SyntaxError("Unexpected token")),
    headers: new Headers(),
  } as unknown as Response;
}

describe("API Client", () => {
  let api: ReturnType<typeof createApiClient>;
  let onUnauthorized: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch.mockReset();
    onUnauthorized = vi.fn();
    api = createApiClient(
      { host: "localhost:8443", token: "test-token" },
      onUnauthorized,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── helpers ──────────────────────────────────────────────

  /** Extract the call args for the Nth fetch invocation. */
  function fetchCallUrl(n = 0): string {
    return mockFetch.mock.calls[n]?.[0] as string;
  }
  function fetchCallOpts(n = 0): Record<string, unknown> {
    return mockFetch.mock.calls[n]?.[1] as Record<string, unknown>;
  }

  describe("API base path uses /api/v1/", () => {
    it("login calls /api/v1/auth/login", async () => {
      mockFetch.mockResolvedValue(
        jsonResponse({ token: "t", requires_2fa: false }),
      );
      await api.login("user", "pass");
      expect(fetchCallUrl()).toBe("https://localhost:8443/api/v1/auth/login");
    });

    it("getMessages calls /api/v1/channels/{id}/messages", async () => {
      mockFetch.mockResolvedValue(
        jsonResponse({ messages: [], has_more: false }),
      );
      await api.getMessages(5);
      expect(fetchCallUrl()).toBe("https://localhost:8443/api/v1/channels/5/messages");
    });

    it("search calls /api/v1/search", async () => {
      mockFetch.mockResolvedValue(jsonResponse({ results: [] }));
      await api.search("hello");
      expect(fetchCallUrl()).toContain("https://localhost:8443/api/v1/search");
    });

    it("getHealth calls /api/v1/health", async () => {
      mockFetch.mockResolvedValue(
        jsonResponse({ status: "ok", version: "1.0.0", uptime: 100 }),
      );
      await api.getHealth();
      expect(fetchCallUrl()).toBe("https://localhost:8443/api/v1/health");
    });
  });

  describe("auth endpoints", () => {
    it("register sends invite_code", async () => {
      mockFetch.mockResolvedValue(
        jsonResponse({ user: { id: 1, username: "u" }, token: "t" }, 201),
      );
      await api.register("user", "pass", "invite123");
      const body = JSON.parse(fetchCallOpts().body as string);
      expect(body.invite_code).toBe("invite123");
    });

    it("sends Authorization header", async () => {
      mockFetch.mockResolvedValue(jsonResponse({}));
      await api.getMe();
      const headers = fetchCallOpts().headers as Record<string, string>;
      expect(headers["Authorization"]).toBe("Bearer test-token");
    });

    it("logout sends POST /auth/logout", async () => {
      mockFetch.mockResolvedValue(jsonResponse(undefined, 204));
      await api.logout();
      expect(fetchCallUrl()).toBe("https://localhost:8443/api/v1/auth/logout");
      expect(fetchCallOpts().method).toBe("POST");
    });

    it("deleteAccount sends DELETE /auth/account with password", async () => {
      mockFetch.mockResolvedValue(jsonResponse(undefined, 204));
      await api.deleteAccount("mypass");
      expect(fetchCallUrl()).toBe("https://localhost:8443/api/v1/auth/account");
      expect(fetchCallOpts().method).toBe("DELETE");
      const body = JSON.parse(fetchCallOpts().body as string);
      expect(body).toEqual({ password: "mypass" });
    });
  });

  describe("error handling", () => {
    it("throws ApiClientError on non-ok response", async () => {
      mockFetch.mockResolvedValue(
        errorResponse(403, "FORBIDDEN", "No permission"),
      );
      await expect(api.getMe()).rejects.toThrow(ApiClientError);
      await expect(api.getMe()).rejects.toMatchObject({
        status: 403,
        code: "FORBIDDEN",
      });
    });

    it("calls onUnauthorized on 401", async () => {
      mockFetch.mockResolvedValue(
        errorResponse(401, "UNAUTHORIZED", "Invalid session"),
      );
      await expect(api.getMe()).rejects.toThrow();
      expect(onUnauthorized).toHaveBeenCalledTimes(1);
    });

    it("does not call onUnauthorized on other errors", async () => {
      mockFetch.mockResolvedValue(
        errorResponse(500, "SERVER_ERROR", "Internal error"),
      );
      await expect(api.getMe()).rejects.toThrow();
      expect(onUnauthorized).not.toHaveBeenCalled();
    });

    it("throws original Error when fetch rejects with an Error instance", async () => {
      const networkErr = new TypeError("Failed to fetch");
      mockFetch.mockRejectedValue(networkErr);
      await expect(api.getMe()).rejects.toBe(networkErr);
    });

    it("wraps non-Error fetch rejection (string) in a new Error", async () => {
      mockFetch.mockRejectedValue("connection refused");
      await expect(api.getMe()).rejects.toThrow("connection refused");
    });

    it("wraps non-Error non-string fetch rejection in a new Error via String()", async () => {
      mockFetch.mockRejectedValue(42);
      await expect(api.getMe()).rejects.toThrow("42");
    });

    it("parseError falls back to statusText when JSON body is not parseable", async () => {
      mockFetch.mockResolvedValue(
        brokenJsonErrorResponse(502, "Bad Gateway"),
      );
      await expect(api.getMe()).rejects.toMatchObject({
        status: 502,
        code: "UNKNOWN",
        message: "Bad Gateway",
      });
    });

    it("parseError uses UNKNOWN when error field missing from JSON", async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 422,
        statusText: "Unprocessable",
        json: () => Promise.resolve({ message: "bad input" }),
        headers: new Headers(),
      } as unknown as Response);
      await expect(api.getMe()).rejects.toMatchObject({
        status: 422,
        code: "UNKNOWN",
        message: "bad input",
      });
    });

    it("parseError uses statusText when message field missing from JSON", async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 422,
        statusText: "Unprocessable",
        json: () => Promise.resolve({ error: "VALIDATION" }),
        headers: new Headers(),
      } as unknown as Response);
      await expect(api.getMe()).rejects.toMatchObject({
        status: 422,
        code: "VALIDATION",
        message: "Unprocessable",
      });
    });

    it("handles 204 No Content response", async () => {
      mockFetch.mockResolvedValue(jsonResponse(undefined, 204));
      const result = await api.logout();
      expect(result).toBeUndefined();
    });
  });

  describe("cancellation", () => {
    it("passes AbortSignal to fetch", async () => {
      mockFetch.mockResolvedValue(jsonResponse({}));
      const controller = new AbortController();
      await api.getMe(controller.signal);
      expect(fetchCallOpts().signal).toBe(controller.signal);
    });
  });

  describe("pagination", () => {
    it("getMessages passes before and limit params", async () => {
      mockFetch.mockResolvedValue(
        jsonResponse({ messages: [], has_more: false }),
      );
      await api.getMessages(5, { before: 100, limit: 25 });
      expect(fetchCallUrl()).toContain("before=100");
      expect(fetchCallUrl()).toContain("limit=25");
    });

    it("getMessages works without options (no query string)", async () => {
      mockFetch.mockResolvedValue(
        jsonResponse({ messages: [], has_more: false }),
      );
      await api.getMessages(3);
      expect(fetchCallUrl()).toBe("https://localhost:8443/api/v1/channels/3/messages");
    });
  });

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
  });

  describe("user endpoints", () => {
    it("getMe calls GET /users/me", async () => {
      mockFetch.mockResolvedValue(jsonResponse({ id: 1, username: "me" }));
      const result = await api.getMe();
      expect(fetchCallUrl()).toBe("https://localhost:8443/api/v1/users/me");
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

    it("changePassword sends PUT /users/me/password", async () => {
      mockFetch.mockResolvedValue(jsonResponse(undefined, 204));
      await api.changePassword("oldpw", "newpw");
      expect(fetchCallUrl()).toBe("https://localhost:8443/api/v1/users/me/password");
      expect(fetchCallOpts().method).toBe("PUT");
      const body = JSON.parse(fetchCallOpts().body as string);
      expect(body).toEqual({ current_password: "oldpw", new_password: "newpw" });
    });

    it("getSessions calls correct endpoint", async () => {
      mockFetch.mockResolvedValue(jsonResponse([]));
      await api.getSessions();
      expect(fetchCallUrl()).toBe("https://localhost:8443/api/v1/users/me/sessions");
    });

    it("revokeSession calls DELETE with session ID", async () => {
      mockFetch.mockResolvedValue(jsonResponse(undefined, 204));
      await api.revokeSession(42);
      expect(fetchCallUrl()).toBe("https://localhost:8443/api/v1/users/me/sessions/42");
      expect(fetchCallOpts().method).toBe("DELETE");
    });
  });

  describe("TOTP management endpoints", () => {
    it("enableTotp sends POST /users/me/totp/enable with password", async () => {
      mockFetch.mockResolvedValue(
        jsonResponse({ qr_uri: "otpauth://totp/test", backup_codes: ["abc"] }),
      );
      const result = await api.enableTotp("mypassword");
      expect(fetchCallUrl()).toBe("https://localhost:8443/api/v1/users/me/totp/enable");
      expect(fetchCallOpts().method).toBe("POST");
      const body = JSON.parse(fetchCallOpts().body as string);
      expect(body).toEqual({ password: "mypassword" });
      expect(result).toEqual({
        qr_uri: "otpauth://totp/test",
        backup_codes: ["abc"],
      });
    });

    it("confirmTotp sends POST /users/me/totp/confirm with password and code", async () => {
      mockFetch.mockResolvedValue(jsonResponse(undefined, 204));
      await api.confirmTotp("mypassword", "123456");
      expect(fetchCallUrl()).toBe("https://localhost:8443/api/v1/users/me/totp/confirm");
      expect(fetchCallOpts().method).toBe("POST");
      const body = JSON.parse(fetchCallOpts().body as string);
      expect(body).toEqual({ password: "mypassword", code: "123456" });
    });

    it("disableTotp sends DELETE /users/me/totp with password", async () => {
      mockFetch.mockResolvedValue(jsonResponse(undefined, 204));
      await api.disableTotp("mypassword");
      expect(fetchCallUrl()).toBe("https://localhost:8443/api/v1/users/me/totp");
      expect(fetchCallOpts().method).toBe("DELETE");
      const body = JSON.parse(fetchCallOpts().body as string);
      expect(body).toEqual({ password: "mypassword" });
    });

    it("enableTotp throws ApiClientError on bad password", async () => {
      mockFetch.mockResolvedValue(
        errorResponse(401, "INVALID_PASSWORD", "Wrong password"),
      );
      await expect(api.enableTotp("wrongpw")).rejects.toThrow(ApiClientError);
      await expect(api.enableTotp("wrongpw")).rejects.toMatchObject({
        status: 401,
      });
    });

    it("confirmTotp throws ApiClientError on invalid code", async () => {
      mockFetch.mockResolvedValue(
        errorResponse(400, "INVALID_CODE", "Invalid verification code"),
      );
      await expect(api.confirmTotp("pw", "000000")).rejects.toThrow(
        ApiClientError,
      );
    });

    it("disableTotp throws ApiClientError when 2FA is required", async () => {
      mockFetch.mockResolvedValue(
        errorResponse(403, "TOTP_REQUIRED", "2FA is required by server policy"),
      );
      await expect(api.disableTotp("pw")).rejects.toThrow(ApiClientError);
      await expect(api.disableTotp("pw")).rejects.toMatchObject({
        status: 403,
      });
    });
  });

  describe("verifyTotp", () => {
    it("sends POST /auth/verify-totp with partial token in header", async () => {
      mockFetch.mockResolvedValue(
        jsonResponse({ token: "full-token", user: { id: 1 } }),
      );
      const result = await api.verifyTotp("123456", "partial-tok");
      expect(fetchCallUrl()).toBe("https://localhost:8443/api/v1/auth/verify-totp");
      expect(fetchCallOpts().method).toBe("POST");
      const headers = fetchCallOpts().headers as Record<string, string>;
      expect(headers["Authorization"]).toBe("Bearer partial-tok");
      const body = JSON.parse(fetchCallOpts().body as string);
      expect(body).toEqual({ code: "123456" });
      expect(result.token).toBe("full-token");
    });

    it("throws ApiClientError on 401 and calls onUnauthorized", async () => {
      mockFetch.mockResolvedValue(
        errorResponse(401, "INVALID_TOTP", "Bad code"),
      );
      await expect(api.verifyTotp("000000", "pt")).rejects.toMatchObject({
        status: 401,
        code: "INVALID_TOTP",
      });
      expect(onUnauthorized).toHaveBeenCalledTimes(1);
    });

    it("throws ApiClientError on non-ok non-401", async () => {
      mockFetch.mockResolvedValue(
        errorResponse(429, "RATE_LIMITED", "Too many attempts"),
      );
      await expect(api.verifyTotp("000000", "pt")).rejects.toMatchObject({
        status: 429,
        code: "RATE_LIMITED",
      });
    });

    it("re-throws Error when fetch rejects with Error", async () => {
      const networkErr = new TypeError("Network failure");
      mockFetch.mockRejectedValue(networkErr);
      await expect(api.verifyTotp("123456", "pt")).rejects.toBe(networkErr);
    });

    it("wraps non-Error string rejection in new Error", async () => {
      mockFetch.mockRejectedValue("dns lookup failed");
      await expect(api.verifyTotp("123456", "pt")).rejects.toThrow("dns lookup failed");
    });

    it("wraps non-Error non-string rejection via String()", async () => {
      mockFetch.mockRejectedValue(99);
      await expect(api.verifyTotp("123456", "pt")).rejects.toThrow("99");
    });

    it("passes AbortSignal to fetch", async () => {
      mockFetch.mockResolvedValue(
        jsonResponse({ token: "t", user: { id: 1 } }),
      );
      const controller = new AbortController();
      await api.verifyTotp("123456", "pt", controller.signal);
      expect(fetchCallOpts().signal).toBe(controller.signal);
    });

    it("sets danger.acceptInvalidCerts for self-signed certs", async () => {
      mockFetch.mockResolvedValue(
        jsonResponse({ token: "t", user: { id: 1 } }),
      );
      await api.verifyTotp("123456", "pt");
      const opts = fetchCallOpts();
      expect((opts as Record<string, unknown>).danger).toEqual({
        acceptInvalidCerts: true,
        acceptInvalidHostnames: false,
      });
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

    it("uploadFile throws ApiClientError on non-ok", async () => {
      mockFetch.mockResolvedValue(
        errorResponse(413, "FILE_TOO_LARGE", "File exceeds limit"),
      );
      const file = new File(["x"], "big.bin");
      await expect(api.uploadFile(file)).rejects.toMatchObject({
        status: 413,
        code: "FILE_TOO_LARGE",
      });
    });

    it("uploadFile omits Authorization header when no token set", async () => {
      const noTokenApi = createApiClient({ host: "localhost:8443" });
      mockFetch.mockResolvedValue(
        jsonResponse({ url: "https://cdn/f.png", filename: "f.png" }),
      );
      const file = new File(["data"], "f.png");
      await noTokenApi.uploadFile(file);
      const headers = fetchCallOpts().headers as Record<string, string>;
      expect(headers["Authorization"]).toBeUndefined();
    });

    it("uploadFile passes AbortSignal", async () => {
      mockFetch.mockResolvedValue(
        jsonResponse({ url: "u", filename: "f" }),
      );
      const controller = new AbortController();
      await api.uploadFile(new File(["x"], "f"), controller.signal);
      expect(fetchCallOpts().signal).toBe(controller.signal);
    });

    it("uploadFile parseError fallback on non-JSON error body", async () => {
      mockFetch.mockResolvedValue(
        brokenJsonErrorResponse(500, "Internal Server Error"),
      );
      const file = new File(["x"], "f");
      await expect(api.uploadFile(file)).rejects.toMatchObject({
        status: 500,
        code: "UNKNOWN",
        message: "Internal Server Error",
      });
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
      mockFetch.mockResolvedValue(
        jsonResponse({ id: 1, code: "abc123", max_uses: 5 }),
      );
      const result = await api.createInvite({ max_uses: 5, expires_in_hours: 24 });
      expect(fetchCallUrl()).toBe("https://localhost:8443/api/v1/invites");
      expect(fetchCallOpts().method).toBe("POST");
      const body = JSON.parse(fetchCallOpts().body as string);
      expect(body).toEqual({ max_uses: 5, expires_in_hours: 24 });
      expect(result.code).toBe("abc123");
    });

    it("revokeInvite calls DELETE /invites/{id}", async () => {
      mockFetch.mockResolvedValue(jsonResponse(undefined, 204));
      await api.revokeInvite(10);
      expect(fetchCallUrl()).toBe("https://localhost:8443/api/v1/invites/10");
      expect(fetchCallOpts().method).toBe("DELETE");
    });
  });

  describe("emoji endpoints", () => {
    it("getEmoji calls GET /emoji", async () => {
      mockFetch.mockResolvedValue(jsonResponse([{ id: 1, name: "smile" }]));
      const result = await api.getEmoji();
      expect(fetchCallUrl()).toBe("https://localhost:8443/api/v1/emoji");
      expect(fetchCallOpts().method).toBe("GET");
      expect(result).toEqual([{ id: 1, name: "smile" }]);
    });

    it("deleteEmoji calls DELETE /emoji/{id}", async () => {
      mockFetch.mockResolvedValue(jsonResponse(undefined, 204));
      await api.deleteEmoji(5);
      expect(fetchCallUrl()).toBe("https://localhost:8443/api/v1/emoji/5");
      expect(fetchCallOpts().method).toBe("DELETE");
    });
  });

  describe("sound endpoints", () => {
    it("getSounds calls GET /sounds", async () => {
      mockFetch.mockResolvedValue(jsonResponse([{ id: 1, name: "beep" }]));
      const result = await api.getSounds();
      expect(fetchCallUrl()).toBe("https://localhost:8443/api/v1/sounds");
      expect(fetchCallOpts().method).toBe("GET");
      expect(result).toEqual([{ id: 1, name: "beep" }]);
    });

    it("deleteSound calls DELETE /sounds/{id}", async () => {
      mockFetch.mockResolvedValue(jsonResponse(undefined, 204));
      await api.deleteSound(3);
      expect(fetchCallUrl()).toBe("https://localhost:8443/api/v1/sounds/3");
      expect(fetchCallOpts().method).toBe("DELETE");
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
      mockFetch.mockResolvedValue(
        jsonResponse({ channel: { id: 10, type: "dm" } }),
      );
      const result = await api.createDm(42);
      expect(fetchCallUrl()).toBe("https://localhost:8443/api/v1/dms");
      expect(fetchCallOpts().method).toBe("POST");
      const body = JSON.parse(fetchCallOpts().body as string);
      expect(body).toEqual({ recipient_id: 42 });
      expect(result).toEqual({ channel: { id: 10, type: "dm" } });
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
      mockFetch.mockResolvedValue(
        jsonResponse({ url: "wss://lk", token: "vt" }),
      );
      const result = await api.getVoiceCredentials();
      expect(fetchCallUrl()).toBe("https://localhost:8443/api/v1/voice/credentials");
      expect(fetchCallOpts().method).toBe("GET");
      expect(result).toEqual({ url: "wss://lk", token: "vt" });
    });
  });

  describe("health endpoint", () => {
    it("getHealth uses custom host when provided", async () => {
      mockFetch.mockResolvedValue(
        jsonResponse({ status: "ok", version: "1.0.0", uptime: 50 }),
      );
      await api.getHealth("other-host:9443");
      expect(fetchCallUrl()).toBe("https://other-host:9443/api/v1/health");
    });

    it("getHealth falls back to config host when no host arg", async () => {
      mockFetch.mockResolvedValue(
        jsonResponse({ status: "ok", version: "1.0.0", uptime: 50 }),
      );
      await api.getHealth();
      expect(fetchCallUrl()).toBe("https://localhost:8443/api/v1/health");
    });

    it("getHealth throws ApiClientError on non-ok response", async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 503,
        statusText: "Service Unavailable",
        json: () => Promise.resolve({}),
        headers: new Headers(),
      } as unknown as Response);
      await expect(api.getHealth()).rejects.toMatchObject({
        status: 503,
        code: "HEALTH_CHECK_FAILED",
      });
    });

    it("getHealth clears timeout on success", async () => {
      const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
      mockFetch.mockResolvedValue(
        jsonResponse({ status: "ok", version: "1.0.0", uptime: 0 }),
      );
      await api.getHealth();
      expect(clearTimeoutSpy).toHaveBeenCalled();
      clearTimeoutSpy.mockRestore();
    });

    it("getHealth clears timeout on failure", async () => {
      const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        statusText: "Error",
        json: () => Promise.resolve({}),
        headers: new Headers(),
      } as unknown as Response);
      await expect(api.getHealth()).rejects.toThrow();
      expect(clearTimeoutSpy).toHaveBeenCalled();
      clearTimeoutSpy.mockRestore();
    });

    it("getHealth sets abort timeout with provided timeoutMs", async () => {
      const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
      mockFetch.mockResolvedValue(
        jsonResponse({ status: "ok", version: "1.0.0", uptime: 0 }),
      );
      await api.getHealth(undefined, 5000);
      // setTimeout should have been called with the timeout value
      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 5000);
      setTimeoutSpy.mockRestore();
    });

    it("getHealth sets danger.acceptInvalidCerts", async () => {
      mockFetch.mockResolvedValue(
        jsonResponse({ status: "ok", version: "1.0.0", uptime: 0 }),
      );
      await api.getHealth();
      expect((fetchCallOpts() as Record<string, unknown>).danger).toEqual({
        acceptInvalidCerts: true,
        acceptInvalidHostnames: false,
      });
    });
  });

  describe("admin channel endpoints", () => {
    it("adminCreateChannel calls POST /admin/api/channels", async () => {
      mockFetch.mockResolvedValue(
        jsonResponse({ id: 1, name: "general", type: "text" }),
      );
      const result = await api.adminCreateChannel({
        name: "general",
        type: "text",
        category: "Main",
        topic: "General chat",
        position: 0,
      });
      expect(fetchCallUrl()).toBe("https://localhost:8443/admin/api/channels");
      expect(fetchCallOpts().method).toBe("POST");
      const body = JSON.parse(fetchCallOpts().body as string);
      expect(body).toEqual({
        name: "general",
        type: "text",
        category: "Main",
        topic: "General chat",
        position: 0,
      });
      expect(result).toEqual({ id: 1, name: "general", type: "text" });
    });

    it("adminUpdateChannel calls PATCH /admin/api/channels/{id}", async () => {
      mockFetch.mockResolvedValue(
        jsonResponse({ id: 5, name: "renamed", topic: "new topic" }),
      );
      const result = await api.adminUpdateChannel(5, {
        name: "renamed",
        topic: "new topic",
        slow_mode: 10,
        position: 2,
        archived: false,
      });
      expect(fetchCallUrl()).toBe("https://localhost:8443/admin/api/channels/5");
      expect(fetchCallOpts().method).toBe("PATCH");
      const body = JSON.parse(fetchCallOpts().body as string);
      expect(body).toEqual({
        name: "renamed",
        topic: "new topic",
        slow_mode: 10,
        position: 2,
        archived: false,
      });
      expect(result.name).toBe("renamed");
    });

    it("adminDeleteChannel calls DELETE /admin/api/channels/{id}", async () => {
      mockFetch.mockResolvedValue(jsonResponse(undefined, 204));
      await api.adminDeleteChannel(5);
      expect(fetchCallUrl()).toBe("https://localhost:8443/admin/api/channels/5");
      expect(fetchCallOpts().method).toBe("DELETE");
    });
  });

  describe("admin member endpoints", () => {
    it("adminKickMember calls DELETE /admin/api/users/{id}/sessions", async () => {
      mockFetch.mockResolvedValue(jsonResponse(undefined, 204));
      await api.adminKickMember(42);
      expect(fetchCallUrl()).toBe("https://localhost:8443/admin/api/users/42/sessions");
      expect(fetchCallOpts().method).toBe("DELETE");
    });

    it("adminBanMember calls PATCH /admin/api/users/{id} with banned:true", async () => {
      mockFetch.mockResolvedValue(jsonResponse(undefined, 204));
      await api.adminBanMember(42, "spamming");
      expect(fetchCallUrl()).toBe("https://localhost:8443/admin/api/users/42");
      expect(fetchCallOpts().method).toBe("PATCH");
      const body = JSON.parse(fetchCallOpts().body as string);
      expect(body).toEqual({ banned: true, ban_reason: "spamming" });
    });

    it("adminBanMember uses empty string when no reason provided", async () => {
      mockFetch.mockResolvedValue(jsonResponse(undefined, 204));
      await api.adminBanMember(42);
      const body = JSON.parse(fetchCallOpts().body as string);
      expect(body).toEqual({ banned: true, ban_reason: "" });
    });

    it("adminChangeRole calls PATCH /admin/api/users/{id} with role_id", async () => {
      mockFetch.mockResolvedValue(jsonResponse(undefined, 204));
      await api.adminChangeRole(42, 3);
      expect(fetchCallUrl()).toBe("https://localhost:8443/admin/api/users/42");
      expect(fetchCallOpts().method).toBe("PATCH");
      const body = JSON.parse(fetchCallOpts().body as string);
      expect(body).toEqual({ role_id: 3 });
    });
  });

  describe("ApiClientError class", () => {
    it("has correct name, status, code, message properties", () => {
      const err = new ApiClientError(404, "NOT_FOUND", "Resource not found");
      expect(err.name).toBe("ApiClientError");
      expect(err.status).toBe(404);
      expect(err.code).toBe("NOT_FOUND");
      expect(err.message).toBe("Resource not found");
      expect(err).toBeInstanceOf(Error);
    });
  });

  describe("doFetch danger option", () => {
    it("all regular requests set danger.acceptInvalidCerts", async () => {
      mockFetch.mockResolvedValue(jsonResponse({}));
      await api.getMe();
      expect((fetchCallOpts() as Record<string, unknown>).danger).toEqual({
        acceptInvalidCerts: true,
        acceptInvalidHostnames: false,
      });
    });
  });

  describe("client without onUnauthorized callback", () => {
    it("does not throw when onUnauthorized is undefined and 401 received", async () => {
      const apiNoCallback = createApiClient({ host: "localhost:8443", token: "t" });
      mockFetch.mockResolvedValue(
        errorResponse(401, "UNAUTHORIZED", "No session"),
      );
      await expect(apiNoCallback.getMe()).rejects.toMatchObject({
        status: 401,
        code: "UNAUTHORIZED",
      });
    });
  });

  describe("doFetch body serialization", () => {
    it("omits body when body is undefined (GET requests)", async () => {
      mockFetch.mockResolvedValue(jsonResponse([]));
      await api.getSessions();
      expect(fetchCallOpts().body).toBeUndefined();
    });

    it("serializes body as JSON for POST requests", async () => {
      mockFetch.mockResolvedValue(
        jsonResponse({ token: "t", requires_2fa: false }),
      );
      await api.login("u", "p");
      expect(typeof fetchCallOpts().body).toBe("string");
      expect(JSON.parse(fetchCallOpts().body as string)).toEqual({
        username: "u",
        password: "p",
      });
    });
  });
});
