import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";

// Mock the Tauri HTTP plugin — vi.hoisted ensures the fn is available when
// vi.mock's factory runs (hoisted above all imports).
const { mockFetch } = vi.hoisted(() => ({
  mockFetch: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: mockFetch,
}));

// Mock the Rust HTTP TOFU proxy so ensureHttpProxy resolves synchronously to a
// stable origin. Returning `https://{host}` keeps the URL assertions below
// unchanged — the proxy indirection is exercised by the Rust unit tests and by
// httpProxy's own tests, not here.
vi.mock("../../src/lib/httpProxy", () => ({
  ensureHttpProxy: (host: string) => Promise.resolve(`https://${host}`),
  stopHttpProxy: () => Promise.resolve(),
}));

import { createApiClient, ApiClientError, type OnUnauthorized } from "../../src/lib/api";

function jsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "OK",
    json: () => Promise.resolve(data),
    headers: new Headers(),
  } as unknown as Response;
}

function errorResponse(status: number, code: string, message: string): Response {
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
  let onUnauthorized: Mock<OnUnauthorized>;

  beforeEach(() => {
    mockFetch.mockReset();
    onUnauthorized = vi.fn<OnUnauthorized>();
    api = createApiClient({ host: "localhost:8443", token: "test-token" }, onUnauthorized);
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
      mockFetch.mockResolvedValue(jsonResponse({ token: "t", requires_2fa: false }));
      await api.login("user", "pass");
      expect(fetchCallUrl()).toBe("https://localhost:8443/api/v1/auth/login");
    });

    it("getMessages calls /api/v1/channels/{id}/messages", async () => {
      mockFetch.mockResolvedValue(jsonResponse({ messages: [], has_more: false }));
      await api.getMessages(5);
      expect(fetchCallUrl()).toBe("https://localhost:8443/api/v1/channels/5/messages");
    });

    it("search calls /api/v1/search", async () => {
      mockFetch.mockResolvedValue(jsonResponse({ results: [] }));
      await api.search("hello");
      expect(fetchCallUrl()).toContain("https://localhost:8443/api/v1/search");
    });

    it("getHealth calls /api/v1/health", async () => {
      mockFetch.mockResolvedValue(jsonResponse({ status: "ok", version: "1.0.0", uptime: 100 }));
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
      mockFetch.mockResolvedValue(errorResponse(403, "FORBIDDEN", "No permission"));
      await expect(api.getMe()).rejects.toThrow(ApiClientError);
      await expect(api.getMe()).rejects.toMatchObject({
        status: 403,
        code: "FORBIDDEN",
      });
    });

    it("calls onUnauthorized on 401", async () => {
      mockFetch.mockResolvedValue(errorResponse(401, "UNAUTHORIZED", "Invalid session"));
      await expect(api.getMe()).rejects.toThrow();
      expect(onUnauthorized).toHaveBeenCalledTimes(1);
    });

    it("does not call onUnauthorized on other errors", async () => {
      mockFetch.mockResolvedValue(errorResponse(500, "SERVER_ERROR", "Internal error"));
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
      mockFetch.mockResolvedValue(brokenJsonErrorResponse(502, "Bad Gateway"));
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
      mockFetch.mockResolvedValue(jsonResponse({ messages: [], has_more: false }));
      await api.getMessages(5, { before: 100, limit: 25 });
      expect(fetchCallUrl()).toContain("before=100");
      expect(fetchCallUrl()).toContain("limit=25");
    });

    it("getMessages works without options (no query string)", async () => {
      mockFetch.mockResolvedValue(jsonResponse({ messages: [], has_more: false }));
      await api.getMessages(3);
      expect(fetchCallUrl()).toBe("https://localhost:8443/api/v1/channels/3/messages");
    });

    it("getMessagesAround hits the around route with the message id in the path", async () => {
      mockFetch.mockResolvedValue(
        jsonResponse({ messages: [], has_more_before: false, has_more_after: false }),
      );
      await api.getMessagesAround(5, 4242);
      expect(fetchCallUrl()).toBe("https://localhost:8443/api/v1/channels/5/messages/around/4242");
    });

    it("getMessagesAround passes the limit", async () => {
      mockFetch.mockResolvedValue(
        jsonResponse({ messages: [], has_more_before: false, has_more_after: false }),
      );
      await api.getMessagesAround(5, 42, { limit: 30 });
      expect(fetchCallUrl()).toContain("limit=30");
    });

    it("getMessagesAround returns the has-more flags for both sides", async () => {
      mockFetch.mockResolvedValue(
        jsonResponse({ messages: [], has_more_before: true, has_more_after: false }),
      );
      const resp = await api.getMessagesAround(5, 42);
      expect(resp.has_more_before).toBe(true);
      expect(resp.has_more_after).toBe(false);
    });

    // The emoji is a path segment: unescaped it would either break the route or
    // resolve to a different emoji than the one on the pill.
    it("getReactionUsers percent-encodes the emoji in the path", async () => {
      mockFetch.mockResolvedValue(jsonResponse({ users: [] }));
      await api.getReactionUsers(5, 42, "👍");
      expect(fetchCallUrl()).toBe(
        "https://localhost:8443/api/v1/channels/5/messages/42/reactions/%F0%9F%91%8D/users",
      );
    });

    it("getReactionUsers returns the reactor list", async () => {
      mockFetch.mockResolvedValue(
        jsonResponse({ users: [{ id: 1, username: "alice", avatar: "" }] }),
      );
      const resp = await api.getReactionUsers(5, 42, "👍");
      expect(resp.users).toHaveLength(1);
      expect(resp.users[0]?.username).toBe("alice");
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
      });

      it("still rejects hosts that could inject headers", () => {
        expect(() => api.setConfig({ host: "evil\r\nhost:8443" })).toThrow("Invalid host format");
      });
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

    it("confirmTotp and disableTotp hand back the partial-success body on 200 (OC-0314)", async () => {
      // totp_handler.go answers 204 normally and 200 + warning when 2FA was
      // enabled/disabled but the other sessions could not be revoked.
      mockFetch.mockResolvedValue(jsonResponse(undefined, 204));
      await expect(api.confirmTotp("mypassword", "123456")).resolves.toBeUndefined();
      await expect(api.disableTotp("mypassword")).resolves.toBeUndefined();

      const partial = {
        warning:
          "2FA enabled, but other sessions could not be revoked; revoke them from the sessions list",
        sessions_revoked: 1,
      };
      mockFetch.mockResolvedValue(jsonResponse(partial));
      await expect(api.confirmTotp("mypassword", "123456")).resolves.toEqual(partial);
      await expect(api.disableTotp("mypassword")).resolves.toEqual(partial);
    });

    it("enableTotp throws ApiClientError on bad password", async () => {
      mockFetch.mockResolvedValue(errorResponse(401, "INVALID_PASSWORD", "Wrong password"));
      await expect(api.enableTotp("wrongpw")).rejects.toThrow(ApiClientError);
      await expect(api.enableTotp("wrongpw")).rejects.toMatchObject({
        status: 401,
      });
    });

    it("confirmTotp throws ApiClientError on invalid code", async () => {
      mockFetch.mockResolvedValue(errorResponse(400, "INVALID_CODE", "Invalid verification code"));
      await expect(api.confirmTotp("pw", "000000")).rejects.toThrow(ApiClientError);
    });

    it("confirmTotp does NOT call onUnauthorized on a wrong enrollment code, even though the server answers 401", async () => {
      // Server contract: handleConfirmTOTP answers 401 UNAUTHORIZED /
      // "invalid two-factor code" for a wrong code — the session itself is
      // still perfectly valid. Firing the global session-expiry sink here
      // would sign the user out and (via main.ts) delete their stored
      // credential over a mistyped enrollment code.
      mockFetch.mockResolvedValue(errorResponse(401, "UNAUTHORIZED", "invalid two-factor code"));
      await expect(api.confirmTotp("pw", "000000")).rejects.toMatchObject({
        status: 401,
        code: "UNAUTHORIZED",
      });
      expect(onUnauthorized).not.toHaveBeenCalled();
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
      mockFetch.mockResolvedValue(jsonResponse({ token: "full-token", user: { id: 1 } }));
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
      mockFetch.mockResolvedValue(errorResponse(401, "INVALID_TOTP", "Bad code"));
      await expect(api.verifyTotp("000000", "pt")).rejects.toMatchObject({
        status: 401,
        code: "INVALID_TOTP",
      });
      expect(onUnauthorized).toHaveBeenCalledTimes(1);
    });

    it("throws ApiClientError on non-ok non-401", async () => {
      mockFetch.mockResolvedValue(errorResponse(429, "RATE_LIMITED", "Too many attempts"));
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
      mockFetch.mockResolvedValue(jsonResponse({ token: "t", user: { id: 1 } }));
      const controller = new AbortController();
      await api.verifyTotp("123456", "pt", controller.signal);
      expect(fetchCallOpts().signal).toBe(controller.signal);
    });

    it("never sets danger.acceptInvalidCerts (cert pinning is handled by the Rust proxy)", async () => {
      mockFetch.mockResolvedValue(jsonResponse({ token: "t", user: { id: 1 } }));
      await api.verifyTotp("123456", "pt");
      const opts = fetchCallOpts();
      expect((opts as Record<string, unknown>).danger).toBeUndefined();
    });

    it("routes verify-totp through the resolved proxy origin", async () => {
      mockFetch.mockResolvedValue(jsonResponse({ token: "t", user: { id: 1 } }));
      await api.verifyTotp("123456", "pt");
      // The httpProxy mock resolves ensureHttpProxy("localhost:8443") to
      // https://localhost:8443, so the tunneled URL matches the direct one.
      expect(fetchCallUrl()).toBe("https://localhost:8443/api/v1/auth/verify-totp");
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
    });

    it("uploadAvatar calls onUnauthorized on 401", async () => {
      mockFetch.mockResolvedValue(errorResponse(401, "UNAUTHORIZED", "Invalid session"));
      const file = new File(["x"], "me.png", { type: "image/png" });
      await expect(api.uploadAvatar(file)).rejects.toMatchObject({ status: 401 });
      expect(onUnauthorized).toHaveBeenCalledTimes(1);
    });

    it("uploadFile throws ApiClientError on non-ok", async () => {
      mockFetch.mockResolvedValue(errorResponse(413, "FILE_TOO_LARGE", "File exceeds limit"));
      const file = new File(["x"], "big.bin");
      await expect(api.uploadFile(file)).rejects.toMatchObject({
        status: 413,
        code: "FILE_TOO_LARGE",
      });
    });

    it("uploadFile calls onUnauthorized on 401 like other REST calls", async () => {
      mockFetch.mockResolvedValue(errorResponse(401, "UNAUTHORIZED", "Invalid session"));
      const file = new File(["x"], "f.txt");
      await expect(api.uploadFile(file)).rejects.toMatchObject({ status: 401 });
      expect(onUnauthorized).toHaveBeenCalledTimes(1);
    });

    it("uploadFile does not call onUnauthorized on other errors", async () => {
      mockFetch.mockResolvedValue(errorResponse(500, "SERVER_ERROR", "Internal error"));
      const file = new File(["x"], "f.txt");
      await expect(api.uploadFile(file)).rejects.toThrow();
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
      expect(fetchCallOpts().signal).toBe(controller.signal);
    });

    it("uploadFile parseError fallback on non-JSON error body", async () => {
      mockFetch.mockResolvedValue(brokenJsonErrorResponse(500, "Internal Server Error"));
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
      expect(onUnauthorized).toHaveBeenCalledTimes(1);
    });

    it("uploadEmoji surfaces a 403 without calling onUnauthorized", async () => {
      mockFetch.mockResolvedValue(errorResponse(403, "FORBIDDEN", "insufficient permissions"));
      const file = new File(["png"], "wave.png", { type: "image/png" });
      await expect(api.uploadEmoji("wave", file)).rejects.toMatchObject({
        status: 403,
        code: "FORBIDDEN",
      });
      expect(onUnauthorized).not.toHaveBeenCalled();
    });

    it("deleteEmoji calls DELETE /emoji/{id}", async () => {
      mockFetch.mockResolvedValue(jsonResponse(undefined, 204));
      await api.deleteEmoji(5);
      expect(fetchCallUrl()).toBe("https://localhost:8443/api/v1/emoji/5");
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

  describe("health endpoint", () => {
    it("getHealth uses custom host when provided", async () => {
      mockFetch.mockResolvedValue(jsonResponse({ status: "ok", version: "1.0.0", uptime: 50 }));
      await api.getHealth("other-host:9443");
      expect(fetchCallUrl()).toBe("https://other-host:9443/api/v1/health");
    });

    it("getHealth falls back to config host when no host arg", async () => {
      mockFetch.mockResolvedValue(jsonResponse({ status: "ok", version: "1.0.0", uptime: 50 }));
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
      mockFetch.mockResolvedValue(jsonResponse({ status: "ok", version: "1.0.0", uptime: 0 }));
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
      mockFetch.mockResolvedValue(jsonResponse({ status: "ok", version: "1.0.0", uptime: 0 }));
      await api.getHealth(undefined, 5000);
      // setTimeout should have been called with the timeout value
      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 5000);
      setTimeoutSpy.mockRestore();
    });

    it("getHealth never sets danger (cert pinning handled by the Rust proxy)", async () => {
      mockFetch.mockResolvedValue(jsonResponse({ status: "ok", version: "1.0.0", uptime: 0 }));
      await api.getHealth();
      expect((fetchCallOpts() as Record<string, unknown>).danger).toBeUndefined();
    });

    it("getHealth fetches through the resolved proxy origin", async () => {
      mockFetch.mockResolvedValue(jsonResponse({ status: "ok", version: "1.0.0", uptime: 0 }));
      await api.getHealth();
      expect(fetchCallUrl()).toBe("https://localhost:8443/api/v1/health");
    });
  });

  describe("admin channel endpoints", () => {
    it("adminCreateChannel calls POST /admin/api/channels", async () => {
      mockFetch.mockResolvedValue(jsonResponse({ id: 1, name: "general", type: "text" }));
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
      mockFetch.mockResolvedValue(jsonResponse({ id: 5, name: "renamed", topic: "new topic" }));
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

  describe("doFetch transport", () => {
    it("never sets danger — TLS trust is enforced by the Rust HTTP proxy", async () => {
      mockFetch.mockResolvedValue(jsonResponse({}));
      await api.getMe();
      expect((fetchCallOpts() as Record<string, unknown>).danger).toBeUndefined();
    });

    it("fetches through the resolved proxy origin", async () => {
      mockFetch.mockResolvedValue(jsonResponse({}));
      await api.getMe();
      expect(fetchCallUrl()).toBe("https://localhost:8443/api/v1/users/me");
    });
  });

  describe("client without onUnauthorized callback", () => {
    it("does not throw when onUnauthorized is undefined and 401 received", async () => {
      const apiNoCallback = createApiClient({ host: "localhost:8443", token: "t" });
      mockFetch.mockResolvedValue(errorResponse(401, "UNAUTHORIZED", "No session"));
      await expect(apiNoCallback.getMe()).rejects.toMatchObject({
        status: 401,
        code: "UNAUTHORIZED",
      });
    });
  });

  describe("doFetch body serialization", () => {
    it("omits body when body is undefined (GET requests)", async () => {
      mockFetch.mockResolvedValue(jsonResponse({ sessions: [] }));
      await api.getSessions();
      expect(fetchCallOpts().body).toBeUndefined();
    });

    it("serializes body as JSON for POST requests", async () => {
      mockFetch.mockResolvedValue(jsonResponse({ token: "t", requires_2fa: false }));
      await api.login("u", "p");
      expect(typeof fetchCallOpts().body).toBe("string");
      expect(JSON.parse(fetchCallOpts().body as string)).toEqual({
        username: "u",
        password: "p",
      });
    });
  });
});
