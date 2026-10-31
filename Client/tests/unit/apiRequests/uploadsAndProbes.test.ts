import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import * as mocks from "../../helpers/apiRequestsMocks";
import {
  ApiClientError,
  TransportError,
  createApiClient,
  type OnUnauthorized,
} from "../../../src/lib/api";
import { expectConsole } from "../../helpers/console";
import { Api, okResponse, failResponse, BASE } from "../../helpers/apiRequestsHarness";

vi.mock("@tauri-apps/plugin-http", () => mocks.pluginHttpMock());
vi.mock("@tauri-apps/api/event", () => mocks.apiEventMock());
vi.mock("../../../src/lib/net/httpProxy", () => mocks.netHttpProxyMock());

const { mockFetch, proxy, progressHandlers } = mocks;

describe("REST client requests", () => {
  let api: Api;
  let onUnauthorized: Mock<OnUnauthorized>;

  const callUrl = (n = 0): string => mockFetch.mock.calls[n]?.[0] as string;
  const callInit = (n = 0): RequestInit => mockFetch.mock.calls[n]?.[1] as RequestInit;
  const callHeaders = (n = 0): Record<string, string> =>
    callInit(n).headers as Record<string, string>;
  const callBody = (n = 0): unknown => JSON.parse(callInit(n).body as string);

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

  describe("multipart uploads", () => {
    const file = new File(["hello"], "pic.png", { type: "image/png" });

    async function sentForm(): Promise<FormData> {
      const body = callInit().body;
      expect(body).toBeInstanceOf(FormData);
      return body as FormData;
    }

    it.each([
      ["uploadAvatar", (a: Api) => a.uploadAvatar(file), "/users/me/avatar"],
      ["uploadBanner", (a: Api) => a.uploadBanner(file), "/users/me/banner"],
      ["uploadFile", (a: Api) => a.uploadFile(file), "/uploads"],
      ["uploadGroupDmIcon", (a: Api) => a.uploadGroupDmIcon(9, file), "/dms/9/icon"],
    ] as const)("%s posts the file as form data", async (_name, call, path) => {
      await call(api);
      expect(callUrl()).toBe(`${BASE}${path}`);
      expect(callInit().method).toBe("POST");
      const form = await sentForm();
      const sent = form.get("file") as File;
      expect(sent.name).toBe("pic.png");
      expect(sent.size).toBe(5);
      expect(callHeaders()["Content-Type"]).toBeUndefined();
    });

    it("uploadEmoji sends the shortcode and the image", async () => {
      await api.uploadEmoji("party", file);
      expect(callUrl()).toBe(`${BASE}/emoji`);
      expect(callInit().method).toBe("POST");
      const form = await sentForm();
      expect(form.get("shortcode")).toBe("party");
      expect((form.get("file") as File).name).toBe("pic.png");
      expect(callHeaders()["Content-Type"]).toBeUndefined();
    });

    it("uploadFile declares a voice message's length and waveform in the query", async () => {
      await api.uploadFile(file, undefined, undefined, {
        durationMs: 1234.6,
        waveform: "AB_-cd",
      });
      expect(callUrl()).toBe(`${BASE}/uploads?voice_duration_ms=1235&voice_waveform=AB_-cd`);
    });

    it("uploadFile percent-encodes the waveform", async () => {
      await api.uploadFile(file, undefined, undefined, { durationMs: 10, waveform: "a b&c" });
      expect(callUrl()).toBe(`${BASE}/uploads?voice_duration_ms=10&voice_waveform=a%20b%26c`);
    });
  });

  describe("removeAvatar", () => {
    it("deletes the avatar", async () => {
      mockFetch.mockResolvedValue(okResponse({ id: 1 }));
      await expect(api.removeAvatar("ann")).resolves.toEqual({ id: 1 });
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(callUrl()).toBe(`${BASE}/users/me/avatar`);
      expect(callInit().method).toBe("DELETE");
    });

    it("falls back to a profile PATCH when the server answers 405", async () => {
      mockFetch
        .mockResolvedValueOnce(failResponse(405, { error: "METHOD_NOT_ALLOWED", message: "no" }))
        .mockResolvedValueOnce(okResponse({ id: 1, avatar: "" }));
      await expect(api.removeAvatar("ann")).resolves.toEqual({ id: 1, avatar: "" });
      expectConsole("warn", /API error/);
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(callUrl(1)).toBe(`${BASE}/users/me`);
      expect(callInit(1).method).toBe("PATCH");
      expect(callBody(1)).toEqual({ username: "ann", avatar: "" });
    });

    it.each([404, 500])("rethrows a %i without retrying", async (status) => {
      mockFetch.mockResolvedValue(failResponse(status, { error: "X", message: "no" }));
      await expect(api.removeAvatar("ann")).rejects.toMatchObject({ status });
      expectConsole("warn", /API error/);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("rethrows a transport failure without retrying", async () => {
      mockFetch.mockRejectedValue(new Error("offline"));
      await expect(api.removeAvatar("ann")).rejects.toBeInstanceOf(TransportError);
      expectConsole(
        "error",
        /fetch failed.*"method":"DELETE".*"path":"\/users\/me\/avatar".*"error":"Error: offline"/,
      );
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe("sessions", () => {
    it("getSessions reads GET /users/me/sessions and unwraps the list", async () => {
      const sessions = [{ id: 1, device: "d", ip: "i", is_current: true }];
      mockFetch.mockResolvedValue(okResponse({ sessions }));
      await expect(api.getSessions()).resolves.toEqual(sessions);
      expect(callUrl()).toBe(`${BASE}/users/me/sessions`);
      expect(callInit().method).toBe("GET");
    });

    it("getSessions rejects when the session ended while the call was in flight", async () => {
      let release: (r: Response) => void = () => {};
      mockFetch.mockReturnValue(new Promise<Response>((resolve) => (release = resolve)));
      const pending = api.getSessions();
      const settled = pending.catch((e: unknown) => e);
      await vi.waitFor(() => expect(mockFetch).toHaveBeenCalled());
      api.endSession();
      release(okResponse({ sessions: [] }));
      await expect(settled).resolves.toMatchObject({ name: "AbortError" });
    });
  });

  describe("adminListUsers", () => {
    const page = (from: number, n: number) =>
      Array.from({ length: n }, (_, i) => ({ id: from + i }));

    it("fetches one page and stops on a short page", async () => {
      mockFetch.mockResolvedValue(okResponse(page(0, 3)));
      await expect(api.adminListUsers()).resolves.toHaveLength(3);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(callUrl()).toBe(`${BASE}/moderation/members?limit=500&offset=0`);
      expect(callInit().method).toBe("GET");
    });

    it("walks every page of 500 until a short one arrives", async () => {
      mockFetch
        .mockResolvedValueOnce(okResponse(page(0, 500)))
        .mockResolvedValueOnce(okResponse(page(500, 500)))
        .mockResolvedValueOnce(okResponse(page(1000, 7)));
      const users = await api.adminListUsers();
      expect(users).toHaveLength(1007);
      expect(users[1006]).toEqual({ id: 1006 });
      expect(mockFetch).toHaveBeenCalledTimes(3);
      expect(callUrl(1)).toBe(`${BASE}/moderation/members?limit=500&offset=500`);
      expect(callUrl(2)).toBe(`${BASE}/moderation/members?limit=500&offset=1000`);
    });

    it("stops after 200 pages when a server never sends a short one", async () => {
      mockFetch.mockImplementation(() => Promise.resolve(okResponse(page(0, 500))));
      const users = await api.adminListUsers();
      expect(mockFetch).toHaveBeenCalledTimes(200);
      expect(users).toHaveLength(200 * 500);
      expect(callUrl(199)).toBe(`${BASE}/moderation/members?limit=500&offset=${199 * 500}`);
    });
  });

  describe("logout", () => {
    it("does not run the session-expiry callback on a 401", async () => {
      mockFetch.mockResolvedValue(failResponse(401, { error: "UNAUTHORIZED", message: "gone" }));
      await expect(api.logout()).rejects.toMatchObject({ status: 401 });
      expectConsole("warn", /API error/);
      expect(onUnauthorized).not.toHaveBeenCalled();
    });

    it("survives the end of the session it was sent from", async () => {
      let release: (r: Response) => void = () => {};
      mockFetch.mockReturnValue(new Promise<Response>((resolve) => (release = resolve)));
      const pending = api.logout();
      await vi.waitFor(() => expect(mockFetch).toHaveBeenCalled());
      api.endSession();
      expect((callInit().signal as AbortSignal).aborted).toBe(false);
      release(okResponse(undefined, 204));
      await expect(pending).resolves.toBeUndefined();
    });

    it("gives up on a server that never answers after ten seconds", async () => {
      vi.useFakeTimers();
      mockFetch.mockReturnValue(new Promise<Response>(() => {}));
      const pending = api.logout().catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(9_900);
      expect((callInit().signal as AbortSignal).aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(200);
      expect((callInit().signal as AbortSignal).aborted).toBe(true);
      await expect(pending).resolves.toMatchObject({ name: "AbortError" });
    });
  });

  describe("confirmTotp", () => {
    it("does not sign the user out on a refused enrolment code", async () => {
      mockFetch.mockResolvedValue(failResponse(401, { error: "UNAUTHORIZED", message: "bad" }));
      await expect(api.confirmTotp("pw", "000000")).rejects.toMatchObject({ status: 401 });
      expectConsole("warn", /API error/);
      expect(onUnauthorized).not.toHaveBeenCalled();
    });

    it("other calls do run the session-expiry callback on a 401", async () => {
      mockFetch.mockResolvedValue(failResponse(401, { error: "UNAUTHORIZED", message: "bad" }));
      await expect(api.disableTotp("pw")).rejects.toMatchObject({ status: 401 });
      expectConsole("warn", /API error/);
      expect(onUnauthorized).toHaveBeenCalledTimes(1);
    });
  });

  describe("upload progress", () => {
    it("is not subscribed for a JSON call", async () => {
      await api.getMe();
      expect(callHeaders()["X-Upload-Id"]).toBeUndefined();
      expect(progressHandlers.size).toBe(0);
    });

    async function progressSeenFor(
      ticks: readonly { sent: number; total: number }[],
    ): Promise<number[]> {
      const seen: number[] = [];
      let finish: (r: Response) => void = () => {};
      mockFetch.mockReturnValue(new Promise<Response>((resolve) => (finish = resolve)));
      const upload = api.uploadFile(new File(["x"], "a.png"), undefined, (f) => seen.push(f));
      await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(progressHandlers.size).toBe(1));
      const id = callHeaders()["X-Upload-Id"];
      for (const tick of ticks) {
        for (const handler of progressHandlers) handler({ payload: { id, ...tick } });
      }
      finish(okResponse({ id: "srv" }));
      await upload;
      return seen;
    }

    it("reports the fraction sent", async () => {
      await expect(
        progressSeenFor([
          { sent: 0, total: 200 },
          { sent: 50, total: 200 },
          { sent: 200, total: 200 },
        ]),
      ).resolves.toEqual([0, 0.25, 1]);
    });

    it("never reports below 0 or above 1", async () => {
      await expect(
        progressSeenFor([
          { sent: -10, total: 100 },
          { sent: 250, total: 100 },
        ]),
      ).resolves.toEqual([0, 1]);
    });

    it("reports 0 while the total is unknown", async () => {
      await expect(
        progressSeenFor([
          { sent: 40, total: 0 },
          { sent: 40, total: -5 },
        ]),
      ).resolves.toEqual([0, 0]);
    });

    it("ignores another upload's ticks and stops listening once settled", async () => {
      const seen: number[] = [];
      mockFetch.mockResolvedValue(okResponse({ id: "srv" }));
      const upload = api.uploadFile(new File(["x"], "a.png"), undefined, (f) => seen.push(f));
      await upload;
      for (const handler of progressHandlers) handler({ payload: { id: "x", sent: 1, total: 2 } });
      expect(seen).toEqual([]);
      expect(progressHandlers.size).toBe(0);
    });
  });

  describe("health and server-info probes", () => {
    it("getHealth fetches /health for the signed-in server with a signal and no auth", async () => {
      mockFetch.mockResolvedValue(okResponse({ status: "ok" }));
      await expect(api.getHealth()).resolves.toEqual({ status: "ok" });
      expect(callUrl()).toBe(`${BASE}/health`);
      expect((callInit().signal as AbortSignal).aborted).toBe(false);
    });

    it("getHealth reaches an explicit host", async () => {
      await api.getHealth("other.test:9000");
      expect(callUrl()).toBe("https://other.test:9000/api/v1/health");
    });

    it("getHealth maps a refusal to a HEALTH_CHECK_FAILED error carrying the status", async () => {
      mockFetch.mockResolvedValue(failResponse(503, {}));
      const err = await api.getHealth().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ApiClientError);
      expect(err).toMatchObject({ status: 503, code: "HEALTH_CHECK_FAILED" });
    });

    it("getServerInfo fetches /server-info for the signed-in server", async () => {
      mockFetch.mockResolvedValue(okResponse({ name: "srv" }));
      await expect(api.getServerInfo()).resolves.toEqual({ name: "srv" });
      expect(callUrl()).toBe(`${BASE}/server-info`);
      expect((callInit().signal as AbortSignal).aborted).toBe(false);
    });

    it("getServerInfo reaches an explicit host", async () => {
      await api.getServerInfo("other.test:9000");
      expect(callUrl()).toBe("https://other.test:9000/api/v1/server-info");
    });

    it("getServerInfo maps a refusal to a SERVER_INFO_FAILED error carrying the status", async () => {
      mockFetch.mockResolvedValue(failResponse(404, {}));
      const err = await api.getServerInfo().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ApiClientError);
      expect(err).toMatchObject({ status: 404, code: "SERVER_INFO_FAILED" });
    });

    it.each(["getHealth", "getServerInfo"] as const)(
      "%s on the signed-in server is cancelled when the session ends",
      async (name) => {
        mockFetch.mockReturnValue(new Promise<Response>(() => {}));
        const pending = api[name]().catch((e: unknown) => e);
        await vi.waitFor(() => expect(mockFetch).toHaveBeenCalled());
        api.endSession();
        await expect(pending).resolves.toMatchObject({ name: "AbortError" });
        expect((callInit().signal as AbortSignal).aborted).toBe(true);
      },
    );

    it.each(["getHealth", "getServerInfo"] as const)(
      "%s on an explicit host outlives the signed-in session",
      async (name) => {
        let release: (r: Response) => void = () => {};
        mockFetch.mockReturnValue(new Promise<Response>((resolve) => (release = resolve)));
        const pending = api[name]("other.test:9000");
        await vi.waitFor(() => expect(mockFetch).toHaveBeenCalled());
        api.endSession();
        expect((callInit().signal as AbortSignal).aborted).toBe(false);
        release(okResponse({ ok: true }));
        await expect(pending).resolves.toEqual({ ok: true });
      },
    );

    it.each(["getHealth", "getServerInfo"] as const)(
      "%s on an explicit host is cancelled by the caller's signal",
      async (name) => {
        mockFetch.mockReturnValue(new Promise<Response>(() => {}));
        const ac = new AbortController();
        const pending = api[name]("other.test:9000", 3000, ac.signal).catch((e: unknown) => e);
        await vi.waitFor(() => expect(mockFetch).toHaveBeenCalled());
        ac.abort();
        await expect(pending).resolves.toMatchObject({ name: "AbortError" });
      },
    );

    it.each(["getHealth", "getServerInfo"] as const)(
      "%s times out after the given milliseconds and defaults to three seconds",
      async (name) => {
        vi.useFakeTimers();
        mockFetch.mockReturnValue(new Promise<Response>(() => {}));
        const first = api[name]().catch((e: unknown) => e);
        await vi.advanceTimersByTimeAsync(2_900);
        expect((callInit().signal as AbortSignal).aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(200);
        await expect(first).resolves.toMatchObject({ name: "AbortError" });

        mockFetch.mockClear();
        mockFetch.mockReturnValue(new Promise<Response>(() => {}));
        const second = api[name](undefined, 500).catch((e: unknown) => e);
        await vi.advanceTimersByTimeAsync(600);
        await expect(second).resolves.toMatchObject({ name: "AbortError" });
      },
    );
  });

  describe("a session that ends while a call is completing", () => {
    // `then` settles the awaited value and ends the session in the same turn,
    // before the awaiting code resumes, so the work finished while the session
    // was still current and is only found stale afterwards.
    function endsAfterSettling<T>(
      settle: "resolve" | "reject",
      value: T,
      end: () => void,
    ): PromiseLike<T> {
      return {
        // oxlint-disable-next-line unicorn/no-thenable -- the test double is deliberately thenable
        then(onFulfilled: (v: T) => void, onRejected: (e: unknown) => void): void {
          if (settle === "resolve") onFulfilled(value);
          else onRejected(value);
          end();
        },
      } as unknown as PromiseLike<T>;
    }

    it("sends no request when the session ended as the proxy came up", async () => {
      proxy.impl = () =>
        endsAfterSettling("resolve", "https://host.test:8443", () => api.endSession());
      await expect(api.getMe()).rejects.toMatchObject({ name: "AbortError" });
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("does not read the body when the session ended as the response arrived", async () => {
      const json = vi.fn(() => Promise.resolve({ id: 1 }));
      mockFetch.mockReturnValue(
        endsAfterSettling("resolve", { ...okResponse(), json }, () => api.endSession()),
      );
      await expect(api.getMe()).rejects.toMatchObject({ name: "AbortError" });
      expect(json).not.toHaveBeenCalled();
    });

    it("does not return data that arrived as the session ended", async () => {
      const res = okResponse();
      (res as { json: unknown }).json = () =>
        endsAfterSettling("resolve", { id: 1 }, () => api.endSession());
      mockFetch.mockResolvedValue(res);
      await expect(api.getMe()).rejects.toMatchObject({ name: "AbortError" });
    });

    it("reports the cancellation, not a parse error, when the body failed as the session ended", async () => {
      const res = okResponse();
      (res as { json: unknown }).json = () =>
        endsAfterSettling("reject", new SyntaxError("Unexpected token <"), () => api.endSession());
      mockFetch.mockResolvedValue(res);
      await expect(api.getMe()).rejects.toMatchObject({ name: "AbortError" });
    });

    it("does not report a server error that arrived as the session ended", async () => {
      // The request releases its transport hook just after its error body is
      // read; ending the session at that point lands between the two steps.
      let armed = false;
      const res = failResponse(500, { error: "X", message: "m" });
      (res as { json: unknown }).json = () => {
        armed = true;
        return Promise.resolve({ error: "X", message: "m" });
      };
      mockFetch.mockResolvedValue(res);
      const realDelete = Set.prototype.delete;
      Set.prototype.delete = function (this: Set<unknown>, value: unknown): boolean {
        if (armed) {
          armed = false;
          api.endSession();
        }
        return realDelete.call(this, value);
      };
      try {
        await expect(api.getMe()).rejects.toMatchObject({ name: "AbortError" });
      } finally {
        Set.prototype.delete = realDelete;
      }
    });

    it("does not hand back sessions listed as the session ended", async () => {
      mockFetch.mockResolvedValue(okResponse({ sessions: [{ id: 1 }] }));
      // The request's own cleanup is the last thing to run before its result
      // reaches getSessions, so ending the session there lands in between.
      const clear = globalThis.clearTimeout;
      const spy = vi.spyOn(globalThis, "clearTimeout").mockImplementation((id) => {
        spy.mockRestore();
        api.endSession();
        clear(id);
      });
      const outcome = await api.getSessions().then(
        (v) => ({ value: v }),
        (e: unknown) => ({ error: e }),
      );
      spy.mockRestore();
      expect(outcome).toMatchObject({ error: { name: "AbortError" } });
    });
  });
});
