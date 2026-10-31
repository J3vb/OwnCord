import { describe, it, expect, vi, type Mock } from "vitest";
import * as mocks from "../../helpers/apiMocks";
import {
  createApiClient,
  ApiClientError,
  TransportError,
  errorText,
  type OnUnauthorized,
} from "../../../src/lib/api";
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

  describe("moderation endpoints", () => {
    // (20)
    it("timeoutMember POSTs the length and reason to /moderation/users/{id}/timeout", async () => {
      mockFetch.mockResolvedValue(jsonResponse({ id: 12, voice: "skipped" }, 201));
      const res = await api.timeoutMember(7, 300, "");
      expect(fetchCallUrl()).toBe("https://localhost:8443/api/v1/moderation/users/7/timeout");
      expect(fetchCallOpts().method).toBe("POST");
      expect(JSON.parse(fetchCallOpts().body as string)).toEqual({
        reason: "",
        duration_seconds: 300,
      });
      expect(res).toEqual({ id: 12, voice: "skipped" });
    });

    it("PUT /moderation/users/{id}/nickname sends the name, and null to clear", async () => {
      mockFetch.mockResolvedValue(jsonResponse({ user_id: 7, display_name: "Dave" }));
      const res = await api.setMemberNickname(7, "Dave");
      expect(fetchCallUrl()).toBe("https://localhost:8443/api/v1/moderation/users/7/nickname");
      expect(fetchCallOpts().method).toBe("PUT");
      expect(JSON.parse(fetchCallOpts().body as string)).toEqual({ display_name: "Dave" });
      expect(res).toEqual({ user_id: 7, display_name: "Dave" });

      mockFetch.mockResolvedValue(jsonResponse({ user_id: 7, display_name: null }));
      await api.setMemberNickname(7, null);
      expect(JSON.parse(fetchCallOpts(1).body as string)).toEqual({ display_name: null });
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
      expectConsole("warn", /\[api\] API error/);
      await expect(api.getMe()).rejects.toMatchObject({
        status: 403,
        code: "FORBIDDEN",
      });
      expectConsole("warn", /\[api\] API error/);
    });

    it("surfaces a Retry-After in seconds on the error, and none when absent", async () => {
      const busy = errorResponse(429, "AUTH_BUSY", "busy");
      (busy.headers as Headers).set("Retry-After", "7");
      mockFetch.mockResolvedValueOnce(busy);
      await expect(api.login("u", "p")).rejects.toMatchObject({
        status: 429,
        code: "AUTH_BUSY",
        retryAfterMs: 7000,
      });
      expectConsole("warn", /\[api\] API error/);
      mockFetch.mockResolvedValueOnce(errorResponse(429, "AUTH_BUSY", "busy"));
      await expect(api.login("u", "p")).rejects.toMatchObject({ retryAfterMs: undefined });
      expectConsole("warn", /\[api\] API error/);
    });

    it("calls onUnauthorized on 401", async () => {
      mockFetch.mockResolvedValue(errorResponse(401, "UNAUTHORIZED", "Invalid session"));
      await expect(api.getMe()).rejects.toThrow();
      expectConsole("warn", /\[api\] API error/);
      expect(onUnauthorized).toHaveBeenCalledTimes(1);
    });

    it("does not call onUnauthorized on other errors", async () => {
      mockFetch.mockResolvedValue(errorResponse(500, "SERVER_ERROR", "Internal error"));
      await expect(api.getMe()).rejects.toThrow();
      expectConsole("warn", /\[api\] API error/);
      expect(onUnauthorized).not.toHaveBeenCalled();
    });

    it("classifies an Error fetch rejection as a typed transport error", async () => {
      const networkErr = new TypeError("Failed to fetch");
      mockFetch.mockRejectedValue(networkErr);
      const err = await api.getMe().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(TransportError);
      // The raw detail stays reachable for the log and for diagnostics.
      expect((err as TransportError).cause).toBe(networkErr);
      expectConsole("error", /\[api\] API fetch failed/);
    });

    it("classifies a non-Error fetch rejection (string) as a typed transport error", async () => {
      mockFetch.mockRejectedValue("connection refused");
      const err = await api.getMe().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(TransportError);
      expect(err).toMatchObject({ message: "connection refused" });
      expectConsole("error", /\[api\] API fetch failed/);
    });

    it("classifies a non-Error non-string fetch rejection as a typed transport error via String()", async () => {
      mockFetch.mockRejectedValue(42);
      const err = await api.getMe().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(TransportError);
      expect(err).toMatchObject({ message: "42" });
      expectConsole("error", /\[api\] API fetch failed/);
    });

    it("parseError falls back to statusText when JSON body is not parseable", async () => {
      mockFetch.mockResolvedValue(brokenJsonErrorResponse(503, "Service Unavailable"));
      await expect(api.getMe()).rejects.toMatchObject({
        status: 503,
        code: "UNKNOWN",
        message: "Service Unavailable",
      });
      expectConsole("warn", /\[api\] API error/);
    });

    it("treats the tunnel's bare 502 as a transport error, not a server refusal", async () => {
      // A refused certificate now carries a TLS_CERT_UNVERIFIED JSON body (see
      // the test below); only a code-less 502 stays a transport error.
      mockFetch.mockResolvedValue(brokenJsonErrorResponse(502, "Bad Gateway"));
      const err = await api.getMe().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(TransportError);
      expect(errorText(err, "Fallback")).toBe(
        "Couldn't reach this server — it may be offline. Check your connection and try again.",
      );
      expectConsole("warn", /\[api\] API error/);
    });

    it("keeps a 502 that carries a server error code as a server error", async () => {
      mockFetch.mockResolvedValue(errorResponse(502, "BAD_GATEWAY", "upstream failed"));
      await expect(api.getMe()).rejects.toMatchObject({ status: 502, code: "BAD_GATEWAY" });
      expectConsole("warn", /\[api\] API error/);
    });

    it("maps the tunnel's distinct TLS certificate code to the certificate copy", async () => {
      // The desktop proxy answers a refused certificate with a 502 whose JSON
      // body carries TLS_CERT_UNVERIFIED (http_pool.rs). The webview must show
      // the certificate message, not the generic unreachable copy.
      mockFetch.mockResolvedValue(
        errorResponse(502, "TLS_CERT_UNVERIFIED", "the server's certificate could not be verified"),
      );
      const err = await api.getMe().catch((e: unknown) => e);
      expect(err).toMatchObject({ status: 502, code: "TLS_CERT_UNVERIFIED" });
      expect(errorText(err, "Fallback")).toBe(
        "The server's certificate couldn't be verified. Check the server address, or ask the server owner.",
      );
      expectConsole("warn", /\[api\] API error/);
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
      expectConsole("warn", /\[api\] API error/);
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
      expectConsole("warn", /\[api\] API error/);
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
      // Requests combine caller cancellation with the session lifetime.
      expect(fetchCallOpts().signal).toBeInstanceOf(AbortSignal);
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

  describe("account recovery endpoints", () => {
    it("recoverAccount POSTs /auth/recover with the secret in kit_secret", async () => {
      mockFetch.mockResolvedValue(jsonResponse({ token: "t", requires_2fa: false }));
      await expect(api.recoverAccount("alice", "KIT-SECRET", "N3w-Pass!")).resolves.toEqual({
        token: "t",
        requires_2fa: false,
      });
      expect(fetchCallUrl()).toBe("https://localhost:8443/api/v1/auth/recover");
      expect(fetchCallOpts().method).toBe("POST");
      expect(JSON.parse(fetchCallOpts().body as string)).toEqual({
        username: "alice",
        kit_secret: "KIT-SECRET",
        new_password: "N3w-Pass!",
      });
    });

    it("enrolRecoveryKit POSTs the password only, so the server generates the secret", async () => {
      const body = { kit_secret: "AAAA-BBBB", created_at: "2026-09-21T00:00:00Z" };
      mockFetch.mockResolvedValue(jsonResponse(body));
      await expect(api.enrolRecoveryKit("pw")).resolves.toEqual(body);
      expect(fetchCallUrl()).toBe("https://localhost:8443/api/v1/users/me/recovery-kit");
      expect(fetchCallOpts().method).toBe("POST");
      expect(JSON.parse(fetchCallOpts().body as string)).toEqual({ password: "pw" });
    });

    it("getRecoveryKitStatus GETs /users/me/recovery-kit", async () => {
      const body = { enrolled: true, created_at: "2026-09-21T00:00:00Z", used_at: null };
      mockFetch.mockResolvedValue(jsonResponse(body));
      await expect(api.getRecoveryKitStatus()).resolves.toEqual(body);
      expect(fetchCallUrl()).toBe("https://localhost:8443/api/v1/users/me/recovery-kit");
      expect(fetchCallOpts().method).toBe("GET");
    });

    it("getOwnModeration GETs /users/me/moderation", async () => {
      const body = [
        {
          id: 42,
          kind: "timeout",
          reason: "cool off",
          created_at: "2026-09-23 10:00:00",
          expires_at: "2026-09-23 11:00:00",
          lifted_at: null,
          acknowledged_at: null,
          appealable: true,
          appeal: null,
        },
      ];
      mockFetch.mockResolvedValue(jsonResponse(body));
      await expect(api.getOwnModeration()).resolves.toEqual(body);
      expect(fetchCallUrl()).toBe("https://localhost:8443/api/v1/users/me/moderation");
      expect(fetchCallOpts().method).toBe("GET");
    });

    it("regenerateRecoveryCodes POSTs the password to /users/me/totp/recovery-codes", async () => {
      mockFetch.mockResolvedValue(jsonResponse({ backup_codes: ["AAAAA-BBBBB"] }));
      await expect(api.regenerateRecoveryCodes("pw")).resolves.toEqual({
        backup_codes: ["AAAAA-BBBBB"],
      });
      expect(fetchCallUrl()).toBe("https://localhost:8443/api/v1/users/me/totp/recovery-codes");
      expect(fetchCallOpts().method).toBe("POST");
      expect(JSON.parse(fetchCallOpts().body as string)).toEqual({ password: "pw" });
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

    it("confirmTotp and disableTotp hand back the partial-success body on 200", async () => {
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
      expectConsole("warn", /\[api\] API error/);
      await expect(api.enableTotp("wrongpw")).rejects.toMatchObject({
        status: 401,
      });
      expectConsole("warn", /\[api\] API error/);
    });

    it("confirmTotp throws ApiClientError on invalid code", async () => {
      mockFetch.mockResolvedValue(errorResponse(400, "INVALID_CODE", "Invalid verification code"));
      await expect(api.confirmTotp("pw", "000000")).rejects.toThrow(ApiClientError);
      expectConsole("warn", /\[api\] API error/);
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
      expectConsole("warn", /\[api\] API error/);
      expect(onUnauthorized).not.toHaveBeenCalled();
    });

    it("disableTotp throws ApiClientError when 2FA is required", async () => {
      mockFetch.mockResolvedValue(
        errorResponse(403, "TOTP_REQUIRED", "2FA is required by server policy"),
      );
      await expect(api.disableTotp("pw")).rejects.toThrow(ApiClientError);
      expectConsole("warn", /\[api\] API error/);
      await expect(api.disableTotp("pw")).rejects.toMatchObject({
        status: 403,
      });
      expectConsole("warn", /\[api\] API error/);
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
      expectConsole("warn", /\[api\] API error/);
      expect(onUnauthorized).toHaveBeenCalledTimes(1);
    });

    it("throws ApiClientError on non-ok non-401", async () => {
      mockFetch.mockResolvedValue(errorResponse(429, "RATE_LIMITED", "Too many attempts"));
      await expect(api.verifyTotp("000000", "pt")).rejects.toMatchObject({
        status: 429,
        code: "RATE_LIMITED",
      });
      expectConsole("warn", /\[api\] API error/);
    });

    it("classifies an Error fetch rejection as a typed transport error", async () => {
      const networkErr = new TypeError("Network failure");
      mockFetch.mockRejectedValue(networkErr);
      const err = await api.verifyTotp("123456", "pt").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(TransportError);
      expect((err as TransportError).cause).toBe(networkErr);
      expectConsole("error", /\[api\] API fetch failed/);
    });

    it("classifies a non-Error string rejection as a typed transport error", async () => {
      mockFetch.mockRejectedValue("dns lookup failed");
      const err = await api.verifyTotp("123456", "pt").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(TransportError);
      expect(err).toMatchObject({ message: "dns lookup failed" });
      expectConsole("error", /\[api\] API fetch failed/);
    });

    it("classifies a non-Error non-string rejection as a typed transport error via String()", async () => {
      mockFetch.mockRejectedValue(99);
      const err = await api.verifyTotp("123456", "pt").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(TransportError);
      expect(err).toMatchObject({ message: "99" });
      expectConsole("error", /\[api\] API fetch failed/);
    });

    it("passes AbortSignal to fetch", async () => {
      mockFetch.mockResolvedValue(jsonResponse({ token: "t", user: { id: 1 } }));
      const controller = new AbortController();
      await api.verifyTotp("123456", "pt", controller.signal);
      // Requests combine caller cancellation with the session lifetime.
      expect(fetchCallOpts().signal).toBeInstanceOf(AbortSignal);
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
});
