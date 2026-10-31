import { describe, it, expect, vi } from "vitest";
import * as mocks from "../../helpers/apiMocks";
import {
  createApiClient,
  ApiClientError,
  TransportError,
  errorText,
  serverErrorText,
} from "../../../src/lib/api";
import { expectConsole } from "../../helpers/console";
import {
  jsonResponse,
  errorResponse,
  emptyBodyErrorResponse,
  fetchCallReaders,
  useDefaultApiClient,
} from "../../helpers/apiHarness";

vi.mock("@tauri-apps/plugin-http", () => mocks.pluginHttpMock());
vi.mock("../../../src/lib/net/httpProxy", () => mocks.netHttpProxyMock());

const { mockFetch } = mocks;

describe("API Client", () => {
  let api: ReturnType<typeof createApiClient>;

  useDefaultApiClient(mockFetch, (client) => {
    api = client;
  });

  const { url: fetchCallUrl, init } = fetchCallReaders(mockFetch);
  const fetchCallOpts = (n = 0) => init(n) as Record<string, unknown>;

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
      mockFetch.mockResolvedValue(emptyBodyErrorResponse(503, "Service Unavailable"));
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
      mockFetch.mockResolvedValue(emptyBodyErrorResponse(500, "Error"));
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

  describe("server-info endpoint", () => {
    const SERVER_INFO = {
      name: "Test Server",
      protocol_epoch: 1,
      browser_client_enabled: false,
    };

    it("getServerInfo reads name, protocol_epoch and browser_client_enabled", async () => {
      mockFetch.mockResolvedValue(jsonResponse(SERVER_INFO));
      await expect(api.getServerInfo("other-host:9443")).resolves.toEqual(SERVER_INFO);
      expect(fetchCallUrl()).toBe("https://other-host:9443/api/v1/server-info");
    });

    it("getServerInfo reads the registration and retention fields and tolerates unknown ones", async () => {
      mockFetch.mockResolvedValue(
        jsonResponse({
          ...SERVER_INFO,
          registration_mode: "approval",
          retention: { messages_days: 30 },
          future_field: "ignored",
        }),
      );
      const info = await api.getServerInfo();
      expect(info.protocol_epoch).toBe(1);
      expect(info.name).toBe("Test Server");
      expect(info.registration_mode).toBe("approval");
      expect(info.retention).toEqual({ messages_days: 30 });
    });

    it("getServerInfo throws ApiClientError on non-ok response", async () => {
      mockFetch.mockResolvedValue(emptyBodyErrorResponse(503, "Service Unavailable"));
      await expect(api.getServerInfo()).rejects.toMatchObject({
        status: 503,
        code: "SERVER_INFO_FAILED",
      });
    });

    it("getServerInfo rejects when the probe is aborted or times out", async () => {
      mockFetch.mockRejectedValue(new DOMException("Aborted", "AbortError"));
      await expect(api.getServerInfo("other-host:9443", 50)).rejects.toThrow(/Aborted/);
    });

    it("getServerInfo sets abort timeout with provided timeoutMs", async () => {
      const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
      mockFetch.mockResolvedValue(jsonResponse(SERVER_INFO));
      await api.getServerInfo(undefined, 5000);
      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 5000);
      setTimeoutSpy.mockRestore();
    });
  });

  describe("admin channel endpoints", () => {
    it("adminCreateChannel calls POST /api/v1/moderation/channels", async () => {
      mockFetch.mockResolvedValue(jsonResponse({ id: 1, name: "general", type: "text" }));
      const result = await api.adminCreateChannel({
        name: "general",
        type: "text",
        category: "Main",
        topic: "General chat",
        position: 0,
      });
      expect(fetchCallUrl()).toBe("https://localhost:8443/api/v1/moderation/channels");
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

    it("adminUpdateChannel calls PATCH /api/v1/moderation/channels/{id}", async () => {
      mockFetch.mockResolvedValue(jsonResponse({ id: 5, name: "renamed", topic: "new topic" }));
      const result = await api.adminUpdateChannel(5, {
        name: "renamed",
        topic: "new topic",
        slow_mode: 10,
        position: 2,
        archived: false,
      });
      expect(fetchCallUrl()).toBe("https://localhost:8443/api/v1/moderation/channels/5");
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

    it("adminUpdateForumSettings calls PUT /api/v1/moderation/channels/{id}/forum", async () => {
      mockFetch.mockResolvedValue(jsonResponse({ id: 9, name: "feedback", type: "forum" }));
      const body = {
        tags: [{ id: 1, name: "Bug", emoji: "🐛" }, { name: "Idea" }],
        require_tag: true,
        default_auto_archive_minutes: 1440,
      } as const;
      await api.adminUpdateForumSettings(9, body);
      expect(fetchCallUrl()).toBe("https://localhost:8443/api/v1/moderation/channels/9/forum");
      expect(fetchCallOpts().method).toBe("PUT");
      expect(JSON.parse(fetchCallOpts().body as string)).toEqual(body);
    });

    it("adminDeleteChannel calls DELETE /api/v1/moderation/channels/{id}", async () => {
      mockFetch.mockResolvedValue(jsonResponse(undefined, 204));
      await api.adminDeleteChannel(5);
      expect(fetchCallUrl()).toBe("https://localhost:8443/api/v1/moderation/channels/5");
      expect(fetchCallOpts().method).toBe("DELETE");
    });
  });

  describe("admin member endpoints", () => {
    it("adminKickMember calls DELETE /api/v1/moderation/members/{id}/sessions", async () => {
      mockFetch.mockResolvedValue(jsonResponse(undefined, 204));
      await api.adminKickMember(42);
      expect(fetchCallUrl()).toBe("https://localhost:8443/api/v1/moderation/members/42/sessions");
      expect(fetchCallOpts().method).toBe("DELETE");
    });

    it("adminBanMember calls PATCH /api/v1/moderation/members/{id} with banned:true", async () => {
      mockFetch.mockResolvedValue(jsonResponse(undefined, 204));
      await api.adminBanMember(42, "spamming");
      expect(fetchCallUrl()).toBe("https://localhost:8443/api/v1/moderation/members/42");
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

    it("adminBanMember sends delete_message_seconds only above 0 and never a role_id", async () => {
      mockFetch.mockResolvedValue(jsonResponse({ id: 42, purge: { deleted: 3, complete: true } }));
      const res = await api.adminBanMember(42, "spam", 24, undefined, 3600);
      // The response is handed back untouched; the Ban dialog reads `purge`.
      const body = JSON.parse(fetchCallOpts().body as string);
      expect(body).toEqual({
        banned: true,
        ban_reason: "spam",
        ban_duration_hours: 24,
        delete_message_seconds: 3600,
      });
      expect(res).toMatchObject({ purge: { deleted: 3, complete: true } });

      mockFetch.mockClear();
      mockFetch.mockResolvedValue(jsonResponse({ id: 42 }));
      await api.adminBanMember(42, "spam", 0, undefined, 0);
      expect(JSON.parse(fetchCallOpts().body as string)).not.toHaveProperty(
        "delete_message_seconds",
      );
    });

    it("adminUnbanMember calls PATCH /api/v1/moderation/members/{id} with banned:false", async () => {
      mockFetch.mockResolvedValue(jsonResponse(undefined, 204));
      await api.adminUnbanMember(42);
      expect(fetchCallUrl()).toBe("https://localhost:8443/api/v1/moderation/members/42");
      expect(fetchCallOpts().method).toBe("PATCH");
      const body = JSON.parse(fetchCallOpts().body as string);
      // Only the flag: the ban reason is dropped with the ban itself.
      expect(body).toEqual({ banned: false });
    });

    it("adminListUsers pages until a short page, so a user past the first 500 is reachable", async () => {
      const page = (from: number, count: number) =>
        Array.from({ length: count }, (_, i) => ({ id: from + i, username: `u${from + i}` }));
      mockFetch
        .mockResolvedValueOnce(jsonResponse(page(1, 500)))
        .mockResolvedValueOnce(jsonResponse(page(501, 2)));

      const users = await api.adminListUsers();

      expect(users).toHaveLength(502);
      expect(users[501]?.id).toBe(502);
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(fetchCallUrl(0)).toBe(
        "https://localhost:8443/api/v1/moderation/members?limit=500&offset=0",
      );
      expect(fetchCallUrl(1)).toBe(
        "https://localhost:8443/api/v1/moderation/members?limit=500&offset=500",
      );
    });

    it("adminChangeRole calls PATCH /api/v1/moderation/members/{id} with role_id", async () => {
      mockFetch.mockResolvedValue(jsonResponse(undefined, 204));
      await api.adminChangeRole(42, 3);
      expect(fetchCallUrl()).toBe("https://localhost:8443/api/v1/moderation/members/42");
      expect(fetchCallOpts().method).toBe("PATCH");
      const body = JSON.parse(fetchCallOpts().body as string);
      expect(body).toEqual({ role_id: 3 });
    });
  });

  describe("a 2xx response that is a web page, not JSON", () => {
    it("surfaces the reverse-proxy message instead of a raw JSON parse error", async () => {
      mockFetch.mockResolvedValue(
        new Response("<!DOCTYPE html><html></html>", {
          status: 200,
          headers: { "Content-Type": "text/html" },
        }),
      );
      const err = await api.adminChangeRole(42, 3).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ApiClientError);
      const text = errorText(err, "fallback");
      expect(text).toContain("web page instead of the API");
      expect(text).not.toContain("DOCTYPE");
      expectConsole("warn", /response is not JSON.*"status":200.*text\/html/);
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
      expect(fetchCallUrl()).toBe("https://localhost:8443/api/v1/auth/me");
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
      expectConsole("warn", /\[api\] API error/);
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

describe("errorText", () => {
  it("shows catalog text for a mapped server code, not the server's message", () => {
    const err = new ApiClientError(429, "RATE_LIMITED", "rate limit exceeded");
    expect(errorText(err, "Failed to change password.")).toBe(
      "Too many requests. Try again later.",
    );
  });

  it("shows catalog text for a REQUEST_TIMEOUT, not the server's English", () => {
    expect(serverErrorText("REQUEST_TIMEOUT", "the server is busy, try again", "Fallback")).toBe(
      "The server is busy — retry in a moment",
    );
  });

  it("shows the caller's catalog text for an internal server failure", () => {
    const err = new ApiClientError(500, "INTERNAL_ERROR", "internal error");
    expect(errorText(err, "Failed to delete account.")).toBe("Failed to delete account.");
  });

  it("shows the server's message only when its code has no mapping, capitalised", () => {
    const err = new ApiClientError(400, "INVALID_INPUT", "incorrect password");
    expect(errorText(err, "Failed to delete account.")).toBe("Incorrect password");
    expect(errorText(new ApiClientError(400, "INVALID_INPUT", ""), "Fallback")).toBe("Fallback");
  });

  it("keeps a non-server error's own message and falls back for a non-error", () => {
    expect(errorText(new Error("offline"), "Fallback")).toBe("offline");
    expect(errorText("nope", "Fallback")).toBe("Fallback");
  });

  it("maps a transport failure to friendly copy, not the raw fetch text", () => {
    const offline = new TransportError("Failed to fetch");
    expect(errorText(offline, "Fallback")).toBe(
      "Couldn't reach this server — it may be offline. Check your connection and try again.",
    );
  });

  it("maps auth, permission and capacity codes to plain capitalised copy", () => {
    expect(
      errorText(new ApiClientError(401, "UNAUTHORIZED", "invalid or expired session"), "F"),
    ).toBe("Your session has expired — sign in again.");
    expect(errorText(new ApiClientError(401, "UNAUTHORIZED", "invalid credentials"), "F")).toBe(
      "Incorrect username or password.",
    );
    expect(errorText(new ApiClientError(401, "UNAUTHORIZED", "not authenticated"), "F")).toBe(
      "Your session has expired — sign in again.",
    );
    expect(
      errorText(new ApiClientError(403, "FORBIDDEN", "missing CONNECT_VOICE permission"), "F"),
    ).toBe("You don't have permission to do that.");
    expect(errorText(new ApiClientError(404, "NOT_FOUND", "channel not found"), "F")).toBe(
      "That item no longer exists.",
    );
    expect(
      errorText(new ApiClientError(403, "BANNED", "your account has been suspended"), "F"),
    ).toBe("Your account has been suspended.");
    expect(
      errorText(new ApiClientError(503, "SERVICE_UNAVAILABLE", "backend unavailable"), "F"),
    ).toBe("The server is temporarily unavailable. Try again.");
    expect(
      errorText(
        new ApiClientError(
          507,
          "STORAGE_QUOTA_EXCEEDED",
          "upload rejected: your storage quota is full",
        ),
        "F",
      ),
    ).toBe("Your storage is full — delete files or ask a server admin.");
    expect(
      errorText(
        new ApiClientError(400, "GIF_DISABLED", "GIF search is not configured on this server"),
        "F",
      ),
    ).toBe("GIF search is not configured on this server.");
  });

  it("keeps the server's own sentence for an auth refusal that is not a session or permission", () => {
    expect(errorText(new ApiClientError(401, "UNAUTHORIZED", "invalid two-factor code"), "F")).toBe(
      "Invalid two-factor code",
    );
    expect(
      errorText(new ApiClientError(401, "UNAUTHORIZED", "invalid username or recovery kit"), "F"),
    ).toBe("Invalid username or recovery kit");
    expect(
      errorText(
        new ApiClientError(400, "INVALID_CREDENTIALS", "invalid invite or credentials"),
        "F",
      ),
    ).toBe("Invalid invite or credentials");
    expect(
      errorText(new ApiClientError(403, "FORBIDDEN", "your account has been suspended"), "F"),
    ).toBe("Your account has been suspended.");
    expect(
      errorText(new ApiClientError(403, "FORBIDDEN", "account is awaiting approval"), "F"),
    ).toBe("Account is awaiting approval");
    expect(
      errorText(new ApiClientError(403, "FORBIDDEN", "cannot delete the last admin account"), "F"),
    ).toBe("Cannot delete the last admin account");
    expect(errorText(new ApiClientError(403, "FORBIDDEN", "insufficient permissions"), "F")).toBe(
      "You don't have permission to do that.",
    );
  });

  it.each([
    [
      "RATE_LIMITED",
      "account temporarily locked due to too many failed attempts",
      "Your account is temporarily locked after too many failed sign-in attempts. Try again later.",
    ],
    [
      "RATE_LIMITED",
      "recovery temporarily locked due to too many failed attempts",
      "Account recovery is temporarily locked after too many failed attempts. Try again later.",
    ],
    [
      "RATE_LIMITED",
      "too many failed attempts, try again later",
      "Too many failed attempts. Try again later.",
    ],
    [
      "RATE_LIMITED",
      "registration queue is full, try again later",
      "This server is not accepting new applications right now. Try again later.",
    ],
    [
      "RATE_LIMITED",
      "too many registrations from this address, try again later",
      "Too many accounts have been created from this network. Try again later.",
    ],
    [
      "RATE_LIMITED",
      "too many authentication attempts in progress, try again later",
      "The server is busy right now. Try again in a moment.",
    ],
    [
      "AUTH_BUSY",
      "too many authentication attempts in progress, try again later",
      "The server is busy right now. Try again in a moment.",
    ],
    [
      "RATE_LIMITED",
      "too many recovery credentials issued; try again later",
      "Too many recovery credentials have been issued. Try again later.",
    ],
    ["RATE_LIMITED", "slow down, try again later", "Too many requests. Try again later."],
    [
      "INTERNAL_ERROR",
      "login temporarily unavailable",
      "Sign-in is temporarily unavailable. Try again shortly.",
    ],
    [
      "INTERNAL_ERROR",
      "failed to load authentication policy",
      "The server could not complete that right now. Try again shortly.",
    ],
    [
      "INTERNAL_ERROR",
      "failed to load registration policy",
      "Registration is temporarily unavailable. Try again shortly.",
    ],
    [
      "INTERNAL_ERROR",
      "registration failed — please try again",
      "Registration failed. Please try again.",
    ],
    [
      "INTERNAL_ERROR",
      "failed to process registration",
      "The server could not complete that right now. Try again shortly.",
    ],
    [
      "INTERNAL_ERROR",
      "failed to create session",
      "Could not start your session. Try signing in again.",
    ],
    [
      "INTERNAL_ERROR",
      "registration succeeded but user fetch failed",
      "Your account was created, but signing in failed. Sign in to continue.",
    ],
    [
      "INTERNAL_ERROR",
      "failed to start two-factor challenge",
      "Two-factor verification is temporarily unavailable. Try again shortly.",
    ],
    [
      "INTERNAL_ERROR",
      "failed to verify two-factor code",
      "Two-factor verification is temporarily unavailable. Try again shortly.",
    ],
    [
      "INTERNAL_ERROR",
      "two-factor verification temporarily unavailable",
      "Two-factor verification is temporarily unavailable. Try again shortly.",
    ],
    ["INTERNAL_ERROR", "failed to logout", "Could not sign out. Try again."],
    ["INTERNAL_ERROR", "failed to delete account", "Could not delete your account. Try again."],
    [
      "INTERNAL_ERROR",
      "failed to generate two-factor secret",
      "Could not turn on two-factor authentication. Try again.",
    ],
    [
      "INTERNAL_ERROR",
      "failed to stage two-factor enrolment",
      "Could not turn on two-factor authentication. Try again.",
    ],
    [
      "INTERNAL_ERROR",
      "failed to enable two-factor authentication",
      "Could not turn on two-factor authentication. Try again.",
    ],
    [
      "INTERNAL_ERROR",
      "failed to disable two-factor authentication",
      "Could not turn off two-factor authentication. Try again.",
    ],
    [
      "INTERNAL_ERROR",
      "failed to issue recovery codes",
      "Could not create new recovery codes. Try again.",
    ],
    [
      "INTERNAL_ERROR",
      "recovery failed — please try again",
      "Account recovery failed. Please try again.",
    ],
    [
      "INTERNAL_ERROR",
      "failed to issue the recovery kit",
      "Could not create a recovery kit. Try again.",
    ],
    [
      "INTERNAL_ERROR",
      "failed to issue the recovery credential",
      "Could not issue a recovery credential. Try again.",
    ],
    ["INTERNAL_ERROR", "internal error", "F"],
  ])("maps the auth slice's %s %j to its own copy", (code, message, shown) => {
    expect(
      errorText(new ApiClientError(code === "RATE_LIMITED" ? 429 : 500, code, message), "F"),
    ).toBe(shown);
  });

  it("keeps the server's text for a FORBIDDEN fault that is not a missing permission", () => {
    expect(
      errorText(
        new ApiClientError(403, "FORBIDDEN", "forbidden: permission service unavailable"),
        "F",
      ),
    ).toBe("Forbidden: permission service unavailable");
    expect(
      errorText(
        new ApiClientError(403, "FORBIDDEN", "forbidden: missing MANAGE_MESSAGES permission"),
        "F",
      ),
    ).toBe("You don't have permission to do that.");
    expect(
      errorText(new ApiClientError(403, "FORBIDDEN", "moderation permission required"), "F"),
    ).toBe("You don't have permission to do that.");
    expect(errorText(new ApiClientError(403, "FORBIDDEN", "owner role required"), "F")).toBe(
      "You don't have permission to do that.",
    );
    expect(errorText(new ApiClientError(403, "FORBIDDEN", "access denied"), "F")).toBe(
      "You don't have permission to do that.",
    );
  });

  it("keeps the server's own message for an unmapped code, capitalising it", () => {
    expect(errorText(new ApiClientError(400, "INVALID_INPUT", "name already exists"), "F")).toBe(
      "Name already exists",
    );
    expect(errorText(new ApiClientError(400, "INVALID_INPUT", ""), "Fallback")).toBe("Fallback");
  });
});
