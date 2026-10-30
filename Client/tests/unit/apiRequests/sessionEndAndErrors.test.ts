import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import * as mocks from "../../helpers/apiRequestsMocks";
import {
  ApiClientError,
  TransportError,
  createApiClient,
  errorText,
  httpError,
  serverErrorCopy,
  serverErrorText,
  type OnUnauthorized,
} from "../../../src/lib/api";
import { connectText } from "../../../src/i18n/connect";
import { messageStatusText } from "../../../src/i18n/messageStatus";
import { expectConsole } from "../../helpers/console";
import { Api, okResponse, failResponse } from "../../helpers/apiRequestsHarness";

vi.mock("@tauri-apps/plugin-http", () => mocks.pluginHttpMock());
vi.mock("@tauri-apps/api/event", () => mocks.apiEventMock());
vi.mock("../../../src/lib/net/httpProxy", () => mocks.netHttpProxyMock());

const { mockFetch, proxy, progressHandlers } = mocks;

describe("REST client requests", () => {
  let api: Api;
  let onUnauthorized: Mock<OnUnauthorized>;

  beforeEach(() => {
    mockFetch.mockReset();
    proxy.impl = (host) => Promise.resolve(`https://${host}`);
    progressHandlers.clear();
    mockFetch.mockImplementation(() => Promise.resolve(okResponse({})));
    onUnauthorized = vi.fn<OnUnauthorized>();
    api = createApiClient({ host: "host.test:8443", token: "tok-1" }, onUnauthorized);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("probes whose session ends while they complete", () => {
    function endsAfterSettling<T>(value: T, end: () => void): PromiseLike<T> {
      return {
        // oxlint-disable-next-line unicorn/no-thenable -- the test double is deliberately thenable
        then(onFulfilled: (v: T) => void): void {
          onFulfilled(value);
          end();
        },
      } as unknown as PromiseLike<T>;
    }

    it.each(["getHealth", "getServerInfo"] as const)(
      "%s sends no request when the session ended as the proxy came up",
      async (name) => {
        proxy.impl = () => endsAfterSettling("https://host.test:8443", () => api.endSession());
        await expect(api[name]()).rejects.toMatchObject({ name: "AbortError" });
        expect(mockFetch).not.toHaveBeenCalled();
      },
    );

    it.each(["getHealth", "getServerInfo"] as const)(
      "%s does not read the body when the session ended as the response arrived",
      async (name) => {
        const json = vi.fn(() => Promise.resolve({}));
        mockFetch.mockReturnValue(
          endsAfterSettling({ ...okResponse(), json }, () => api.endSession()),
        );
        await expect(api[name]()).rejects.toMatchObject({ name: "AbortError" });
        expect(json).not.toHaveBeenCalled();
      },
    );

    it.each(["getHealth", "getServerInfo"] as const)(
      "%s reports the cancellation, not a refusal, when the session ended as a refusal arrived",
      async (name) => {
        mockFetch.mockReturnValue(endsAfterSettling(failResponse(503, {}), () => api.endSession()));
        await expect(api[name]()).rejects.toMatchObject({ name: "AbortError" });
      },
    );

    it.each(["getHealth", "getServerInfo"] as const)(
      "%s does not return data that arrived as the session ended",
      async (name) => {
        const res = okResponse();
        (res as { json: unknown }).json = () =>
          endsAfterSettling({ ok: true }, () => api.endSession());
        mockFetch.mockResolvedValue(res);
        await expect(api[name]()).rejects.toMatchObject({ name: "AbortError" });
      },
    );
  });

  describe("finished calls release what they held", () => {
    it("a request leaves no timer and detaches from the caller's signal", async () => {
      vi.useFakeTimers();
      const ac = new AbortController();
      const removed = vi.spyOn(ac.signal, "removeEventListener");
      mockFetch.mockResolvedValue(okResponse(undefined, 204));
      await api.logout(ac.signal);
      expect(vi.getTimerCount()).toBe(0);
      expect(removed).toHaveBeenCalledWith("abort", expect.any(Function));
    });

    it("a failed request leaves no timer either", async () => {
      vi.useFakeTimers();
      mockFetch.mockResolvedValue(failResponse(500, { error: "X", message: "m" }));
      await expect(api.logout()).rejects.toMatchObject({ status: 500 });
      expectConsole("warn", /API error/);
      expect(vi.getTimerCount()).toBe(0);
    });

    it.each(["getHealth", "getServerInfo"] as const)(
      "%s leaves no timer and detaches from the caller's signal",
      async (name) => {
        vi.useFakeTimers();
        const ac = new AbortController();
        const removed = vi.spyOn(ac.signal, "removeEventListener");
        await api[name]("other.test:9000", 3000, ac.signal);
        expect(vi.getTimerCount()).toBe(0);
        expect(removed).toHaveBeenCalledWith("abort", expect.any(Function));
      },
    );
  });

  describe("a session that is already over", () => {
    it("starts nothing for a request whose caller has already cancelled", async () => {
      const calls = vi.fn(proxy.impl);
      proxy.impl = calls;
      const ac = new AbortController();
      ac.abort();
      await expect(api.getMe(ac.signal)).rejects.toMatchObject({ name: "AbortError" });
      expect(calls).not.toHaveBeenCalled();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it.each(["getHealth", "getServerInfo"] as const)(
      "%s starts nothing when the caller has already cancelled",
      async (name) => {
        const calls = vi.fn(proxy.impl);
        proxy.impl = calls;
        const ac = new AbortController();
        ac.abort();
        await expect(api[name](undefined, 3000, ac.signal)).rejects.toMatchObject({
          name: "AbortError",
        });
        expect(calls).not.toHaveBeenCalled();
        expect(mockFetch).not.toHaveBeenCalled();
      },
    );
  });

  describe("starting the proxy fails", () => {
    it("types a bare string rejection as a transport error and keeps the raw text", async () => {
      proxy.impl = () => Promise.reject("bind refused");
      const err = await api.getMe().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(TransportError);
      expect(err).toMatchObject({ message: "bind refused", cause: "bind refused" });
      expectConsole("error", /proxy start failed.*"error":"bind refused"/);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("reports the cancellation when the session ended as the proxy failed", async () => {
      proxy.impl = () =>
        ({
          // oxlint-disable-next-line unicorn/no-thenable -- the test double is deliberately thenable
          then(_ok: unknown, fail: (e: unknown) => void): void {
            fail("bind refused");
            api.endSession();
          },
        }) as unknown as PromiseLike<string>;
      await expect(api.getMe()).rejects.toMatchObject({ name: "AbortError" });
    });

    it("uses the message of an Error rejection", async () => {
      const cause = new Error("no port");
      proxy.impl = () => Promise.reject(cause);
      const err = await api.getMe().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(TransportError);
      expect(err).toMatchObject({ message: "no port", cause });
      expectConsole("error", /proxy start failed/);
    });
  });

  describe("setConfig", () => {
    it("rejects a host that is not a valid address and keeps the current one", () => {
      expect(() => api.setConfig({ host: "bad host/path" })).toThrow("Invalid host format");
      expectConsole("error", /setConfig rejected invalid host.*bad host\/path/);
      expect(api.getConfig().host).toBe("host.test:8443");
    });
  });
});

describe("error mapping", () => {
  let api: Api;

  beforeEach(() => {
    mockFetch.mockReset();
    api = createApiClient({ host: "host.test:8443", token: "tok-1" });
  });

  describe("Retry-After", () => {
    it.each([
      ["7", 7000],
      [" 12 ", 12000],
      ["0", 0],
      ["007", 7000],
    ])("reads %j seconds as %i ms", async (value, ms) => {
      mockFetch.mockResolvedValue(
        failResponse(429, { error: "RATE_LIMITED", message: "slow" }, { "Retry-After": value }),
      );
      await expect(api.login("u", "p")).rejects.toMatchObject({ retryAfterMs: ms });
      expectConsole("warn", /API error/);
    });

    it.each(["", "7s", "-3", "1.5", "Wed, 21 Oct 2026 07:28:00 GMT", "abc7", "7abc", "1 2"])(
      "ignores %j, which is not a delta in seconds",
      async (value) => {
        mockFetch.mockResolvedValue(
          failResponse(429, { error: "RATE_LIMITED", message: "slow" }, { "Retry-After": value }),
        );
        const err = (await api.login("u", "p").catch((e: unknown) => e)) as ApiClientError;
        expect(err.retryAfterMs).toBeUndefined();
        expectConsole("warn", /API error/);
      },
    );
  });

  describe("error classes", () => {
    it("TransportError is named and keeps its cause", () => {
      const cause = new Error("raw");
      const err = new TransportError("offline", { cause });
      expect(err.name).toBe("TransportError");
      expect(err.message).toBe("offline");
      expect(err.cause).toBe(cause);
      expect(err).toBeInstanceOf(Error);
    });

    it("httpError makes a TransportError only for a code-less 502", () => {
      expect(httpError(502, "UNKNOWN", "bad gateway")).toBeInstanceOf(TransportError);
      expect(httpError(502, "BAD_GATEWAY", "x")).toBeInstanceOf(ApiClientError);
      expect(httpError(500, "UNKNOWN", "x")).toBeInstanceOf(ApiClientError);
      const err = httpError(429, "AUTH_BUSY", "busy", 3000) as ApiClientError;
      expect(err).toMatchObject({ status: 429, code: "AUTH_BUSY", message: "busy" });
      expect(err.retryAfterMs).toBe(3000);
    });
  });

  describe("a 2xx whose body does not parse", () => {
    function badBody(reject: unknown): Response {
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: () => Promise.reject(reject),
        headers: new Headers({ "content-type": "text/html" }),
      } as unknown as Response;
    }

    it.each([
      ["a SyntaxError with unrelated text", new SyntaxError("bad")],
      ["an Error that says Unexpected token", new Error("Unexpected token < in input")],
      ["an Error that mentions JSON", new Error("not valid JSON")],
    ])("is a NOT_JSON error for %s", async (_name, thrown) => {
      mockFetch.mockResolvedValue(badBody(thrown));
      const err = await api.getMe().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ApiClientError);
      expect(err).toMatchObject({
        status: 200,
        code: "NOT_JSON",
        message: connectText("error.notJson"),
      });
      expectConsole("warn", /response is not JSON/);
    });

    it.each([
      ["an unrelated Error", new Error("disk on fire")],
      ["a TypeError", new TypeError("x is not a function")],
      ["a string that mentions JSON", "JSON everywhere"],
    ])("rethrows %s unchanged", async (_name, thrown) => {
      mockFetch.mockResolvedValue(badBody(thrown));
      await expect(api.getMe()).rejects.toBe(thrown);
    });
  });

  describe("a server error body", () => {
    it("is read from error and message", async () => {
      mockFetch.mockResolvedValue(failResponse(409, { error: "CONFLICT", message: "taken" }));
      await expect(api.getMe()).rejects.toMatchObject({
        status: 409,
        code: "CONFLICT",
        message: "taken",
      });
      expectConsole("warn", /API error.*CONFLICT.*taken/);
    });

    it("logs the request id the server sent", async () => {
      mockFetch.mockResolvedValue(
        failResponse(500, { error: "X", message: "m" }, { "x-request-id": "req-77" }),
      );
      await expect(api.getMe()).rejects.toBeInstanceOf(ApiClientError);
      expectConsole("warn", /API error.*"status":500.*"reqId":"req-77"/);
    });

    it("runs the session-expiry callback after the error body is read, once", async () => {
      const calls: string[] = [];
      const cb = createApiClient({ host: "host.test:8443", token: "t" }, () => calls.push("cb"));
      mockFetch.mockResolvedValue({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        json: () => {
          calls.push("body");
          return Promise.resolve({ error: "UNAUTHORIZED", message: "expired" });
        },
        headers: new Headers(),
      });
      await expect(cb.getMe()).rejects.toMatchObject({ status: 401 });
      expectConsole("warn", /API error/);
      expect(calls).toEqual(["body", "cb"]);
    });
  });

  describe("serverErrorCopy", () => {
    it.each([
      ["TLS_CERT_UNVERIFIED", "x", "error.tlsFailed"],
      ["AUTH_BUSY", "x", "error.authBusy"],
      ["RATE_LIMITED", "something else", "error.rateLimited"],
      ["NOT_FOUND", "x", "error.notFound"],
      ["BANNED", "x", "error.banned"],
      ["SERVICE_UNAVAILABLE", "x", "error.unavailable"],
      ["BAD_GATEWAY", "x", "error.unavailable"],
      ["STORAGE_QUOTA_EXCEEDED", "x", "error.storageQuota"],
      ["STORAGE_LOW_DISK", "x", "error.storageLowDisk"],
      ["STORAGE_ERROR", "x", "error.storageError"],
      ["GIF_DISABLED", "x", "error.gifDisabled"],
      ["LAST_ROLE", "x", "error.lastRole"],
      ["PUSH_DISABLED", "x", "error.pushDisabled"],
    ] as const)("%s maps to %s copy", (code, message, key) => {
      expect(serverErrorCopy(code, message)).toBe(connectText(key));
    });

    it("maps the server's request timeout to the send-status copy", () => {
      expect(serverErrorCopy("REQUEST_TIMEOUT", "x")).toBe(
        messageStatusText("send.requestTimeout"),
      );
    });

    it("gives every plain code its own sentence", () => {
      const codes = [
        "TLS_CERT_UNVERIFIED",
        "AUTH_BUSY",
        "NOT_FOUND",
        "BANNED",
        "SERVICE_UNAVAILABLE",
        "STORAGE_QUOTA_EXCEEDED",
        "STORAGE_LOW_DISK",
        "STORAGE_ERROR",
        "GIF_DISABLED",
        "LAST_ROLE",
        "PUSH_DISABLED",
      ];
      const copies = codes.map((c) => serverErrorCopy(c, "x"));
      expect(copies.every((c) => typeof c === "string" && c.length > 0)).toBe(true);
      expect(new Set(copies).size).toBe(codes.length);
    });

    it("has no copy for an unknown code", () => {
      expect(serverErrorCopy("SOMETHING_NEW", "x")).toBeNull();
      expect(serverErrorCopy("", "x")).toBeNull();
    });

    describe("UNAUTHORIZED", () => {
      it("maps a refused sign-in", () => {
        expect(serverErrorCopy("UNAUTHORIZED", "invalid credentials")).toBe(
          connectText("error.invalidCredentials"),
        );
      });

      it.each([
        "session has expired",
        "invalid or expired session",
        "missing or invalid authorization header",
        "not authenticated",
      ])("maps the expired-session message %j", (message) => {
        expect(serverErrorCopy("UNAUTHORIZED", message)).toBe(connectText("error.unauthorized"));
      });

      it("keeps the server's sentence for anything else", () => {
        expect(serverErrorCopy("UNAUTHORIZED", "invalid code")).toBeNull();
        expect(serverErrorCopy("UNAUTHORIZED", "")).toBeNull();
      });
    });

    describe("FORBIDDEN", () => {
      it("maps a suspension", () => {
        expect(serverErrorCopy("FORBIDDEN", "your account has been suspended")).toBe(
          connectText("error.banned"),
        );
      });

      it.each([
        "missing manage_roles permission",
        "Missing Permission",
        "insufficient permissions",
        "manage server permission required",
        "admin role required",
        "access denied",
        "Access Denied",
      ])("maps the permission refusal %j", (message) => {
        expect(serverErrorCopy("FORBIDDEN", message)).toBe(connectText("error.forbidden"));
      });

      it.each([
        "account is awaiting approval",
        "permission required for this, sorry",
        "role required here",
        "access denied for now",
        "the access denied page",
        "unmissing permissions",
        "no access denied",
      ])("keeps the server's sentence for %j", (message) => {
        expect(serverErrorCopy("FORBIDDEN", message)).toBeNull();
      });
    });

    describe("auth-slice sentences", () => {
      const slice: ReadonlyArray<readonly [string, string]> = [
        ["account temporarily locked due to too many failed attempts", "error.accountLocked"],
        ["recovery temporarily locked due to too many failed attempts", "error.recoveryLocked"],
        ["too many failed attempts, try again later", "error.tooManyAttempts"],
        ["registration queue is full, try again later", "error.registrationQueueFull"],
        [
          "too many registrations from this address, try again later",
          "error.registrationRateLimited",
        ],
        ["too many authentication attempts in progress, try again later", "error.authBusy"],
        ["too many recovery credentials issued; try again later", "error.recoveryCredentialBudget"],
        ["login temporarily unavailable", "error.loginUnavailable"],
        ["failed to load authentication policy", "error.couldNotComplete"],
        ["failed to process registration", "error.couldNotComplete"],
        ["failed to load registration policy", "error.registrationUnavailable"],
        ["registration failed — please try again", "error.registrationFailed"],
        ["failed to create session", "error.sessionFailed"],
        ["registration succeeded but user fetch failed", "error.registeredSignInFailed"],
        ["failed to start two-factor challenge", "error.totpUnavailable"],
        ["failed to verify two-factor code", "error.totpUnavailable"],
        ["two-factor verification temporarily unavailable", "error.totpUnavailable"],
        ["failed to logout", "error.logoutFailed"],
        ["failed to delete account", "error.deleteAccountFailed"],
        ["failed to generate two-factor secret", "error.totpEnableFailed"],
        ["failed to stage two-factor enrolment", "error.totpEnableFailed"],
        ["failed to enable two-factor authentication", "error.totpEnableFailed"],
        ["failed to disable two-factor authentication", "error.totpDisableFailed"],
        ["failed to issue recovery codes", "error.recoveryCodesFailed"],
        ["recovery failed — please try again", "error.recoveryFailed"],
        ["failed to issue the recovery kit", "error.recoveryKitFailed"],
        ["failed to issue the recovery credential", "error.recoveryCredentialFailed"],
      ];

      it.each(slice)("RATE_LIMITED %j", (message, key) => {
        expect(serverErrorCopy("RATE_LIMITED", message)).toBe(
          connectText(key as Parameters<typeof connectText>[0]),
        );
      });

      it.each(["INTERNAL", "INTERNAL_ERROR"])("%s carries the same sentences", (code) => {
        for (const [message, key] of slice) {
          expect(serverErrorCopy(code, message)).toBe(
            connectText(key as Parameters<typeof connectText>[0]),
          );
        }
      });

      it.each(["INTERNAL", "INTERNAL_ERROR"])("%s has no copy for other messages", (code) => {
        expect(serverErrorCopy(code, "disk exploded")).toBeNull();
      });

      it("gives every sentence its own copy", () => {
        const copies = new Set(slice.map(([m]) => serverErrorCopy("INTERNAL", m)));
        expect(copies.has(null)).toBe(false);
        expect(copies.size).toBe(new Set(slice.map(([, k]) => k)).size);
      });
    });
  });

  describe("serverErrorText", () => {
    it("prefers catalog copy over the server's message", () => {
      expect(serverErrorText("NOT_FOUND", "no such thing", "fb")).toBe(
        connectText("error.notFound"),
      );
    });

    it("capitalises only the first letter of an unmapped message", () => {
      expect(serverErrorText("CONFLICT", "name already exists", "fb")).toBe("Name already exists");
      expect(serverErrorText("CONFLICT", "iPhone case", "fb")).toBe("IPhone case");
      expect(serverErrorText("CONFLICT", "x", "fb")).toBe("X");
    });

    it("falls back when the unmapped message is empty", () => {
      expect(serverErrorText("CONFLICT", "", "fallback")).toBe("fallback");
    });

    it.each(["INTERNAL", "INTERNAL_ERROR"])(
      "%s with an unmapped message shows the caller's fallback",
      (code) => {
        expect(serverErrorText(code, "stack trace here", "fallback")).toBe("fallback");
      },
    );
  });

  describe("errorText", () => {
    it("shows the connect-timeout copy for a transport failure", () => {
      expect(errorText(new TransportError("raw"), "fb")).toBe(
        connectText("session.connectTimeout"),
      );
    });

    it("maps an ApiClientError through its code", () => {
      expect(errorText(new ApiClientError(404, "NOT_FOUND", "gone"), "fb")).toBe(
        connectText("error.notFound"),
      );
      expect(errorText(new ApiClientError(409, "CONFLICT", "name taken"), "fb")).toBe("Name taken");
      expect(errorText(new ApiClientError(500, "INTERNAL", "boom"), "fb")).toBe("fb");
    });

    it("uses the message of any other Error, and the fallback otherwise", () => {
      expect(errorText(new Error("plain"), "fb")).toBe("plain");
      expect(errorText("not an error", "fb")).toBe("fb");
      expect(errorText(undefined, "fb")).toBe("fb");
    });
  });
});
