import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockFetch, mockProxy } = vi.hoisted(() => ({ mockFetch: vi.fn(), mockProxy: vi.fn() }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: mockFetch }));
vi.mock("../../src/lib/httpProxy", () => ({ ensureHttpProxy: mockProxy }));
import { createApiClient, type ApiClient } from "../../src/lib/api";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function response(data: unknown = {}, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "Error",
    headers: new Headers(),
    json: () => Promise.resolve(data),
  } as Response;
}

const requests: Array<[string, (api: ApiClient, signal?: AbortSignal) => Promise<unknown>]> = [
  ["JSON", (api, signal) => api.getMe(signal)],
  ["admin", (api, signal) => api.adminUpdateChannel(1, { name: "renamed" }, signal)],
  ["avatar", (api, signal) => api.uploadAvatar(new File(["x"], "avatar.png"), signal)],
  ["attachment", (api, signal) => api.uploadFile(new File(["x"], "file.txt"), signal)],
  ["emoji", (api, signal) => api.uploadEmoji("wave", new File(["x"], "wave.png"), signal)],
  ["TOTP", (api, signal) => api.verifyTotp("123456", "partial-token", signal)],
];

beforeEach(() => {
  mockFetch.mockReset().mockResolvedValue(response());
  mockProxy.mockReset().mockImplementation((host: string) => Promise.resolve(`https://${host}`));
});

describe("API session ownership", () => {
  it.each(requests)(
    "%s cancels deferred proxy setup without sending another account's credentials",
    async (_label, send) => {
      const proxy = deferred<string>();
      mockProxy.mockReturnValueOnce(proxy.promise);
      const api = createApiClient({ host: "old.example", token: "old-token" });
      const result = send(api);
      const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
      api.setConfig({ host: "new.example", token: "new-token" });
      await rejected;
      proxy.resolve("https://old.example");
      await Promise.resolve();
      await Promise.resolve();
      expect(mockFetch).not.toHaveBeenCalled();
      await api.getMe();
      expect(mockFetch).toHaveBeenCalledWith(
        "https://new.example/api/v1/auth/me",
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: "Bearer new-token" }),
        }),
      );
    },
  );

  it.each(requests)(
    "%s rejects late success and aborts transport on same-host token replacement",
    async (_label, send) => {
      const fetch = deferred<Response>();
      mockFetch.mockReturnValueOnce(fetch.promise);
      const api = createApiClient({ host: "same.example", token: "alice" });
      const result = send(api);
      const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
      await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledOnce());
      const signal = (mockFetch.mock.calls[0]?.[1] as RequestInit).signal!;
      api.setConfig({ token: "bob" });
      expect(signal.aborted).toBe(true);
      await rejected;
      fetch.resolve(response({ user: "alice" }));
    },
  );

  it.each(requests)("%s guards deferred unauthorized response bodies", async (_label, send) => {
    const body = deferred<unknown>();
    const started = deferred<void>();
    const unauthorized = vi.fn();
    mockFetch.mockResolvedValue({
      ...response(undefined, 401),
      json: () => {
        started.resolve();
        return body.promise;
      },
    });
    const api = createApiClient({ host: "same.example", token: "alice" }, unauthorized);
    const result = send(api);
    const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
    await started.promise;
    api.setConfig({ token: "bob" });
    body.resolve({ error: "UNAUTHORIZED", message: "Alice expired" });
    await rejected;
    expect(unauthorized).not.toHaveBeenCalled();
  });

  it("rejects old JSON success after fetch already completed", async () => {
    const body = deferred<unknown>();
    const started = deferred<void>();
    mockFetch.mockResolvedValue({
      ...response(),
      json: () => {
        started.resolve();
        return body.promise;
      },
    });
    const api = createApiClient({ host: "same.example", token: "alice" });
    const result = api.getMe();
    const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
    await started.promise;
    api.endSession();
    body.resolve({ id: 1 });
    await rejected;
  });

  it("does not log out the new session when the old fetch returns a 401", async () => {
    const fetch = deferred<Response>();
    mockFetch.mockReturnValueOnce(fetch.promise);
    const unauthorized = vi.fn();
    const api = createApiClient({ host: "first.example", token: "alice" }, unauthorized);
    const result = api.getMe();
    const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledOnce());
    api.setConfig({ host: "second.example", token: "bob" });
    fetch.resolve(response({ error: "UNAUTHORIZED" }, 401));
    await rejected;
    expect(unauthorized).not.toHaveBeenCalled();
  });

  it.each(requests)("%s preserves caller cancellation", async (_label, send) => {
    const api = createApiClient({ host: "same.example", token: "alice" });
    mockFetch.mockReturnValue(new Promise(() => {}));
    const caller = new AbortController();
    const result = send(api, caller.signal);
    const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledOnce());
    caller.abort();
    await rejected;
    expect((mockFetch.mock.calls[0]?.[1] as RequestInit).signal?.aborted).toBe(true);
    expect(api.getSession().isCurrent()).toBe(true);
  });

  it("preserves identical config ownership but ends anonymous same-host attempts explicitly", () => {
    const api = createApiClient({ host: "same.example" });
    const original = api.getSession();
    const cleanup = vi.fn();
    original.addCleanup(cleanup);
    api.setConfig({ host: "same.example" });
    expect(api.getSession()).toBe(original);
    api.endSession();
    api.endSession();
    expect(original.isCurrent()).toBe(false);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(api.getSession().identity.generation).toBeGreaterThan(original.identity.generation);
    expect(api.getConfig().token).toBeUndefined();
  });

  it("health timeout covers proxy setup and never fetches after timing out", async () => {
    vi.useFakeTimers();
    try {
      const proxy = deferred<string>();
      mockProxy.mockReturnValue(proxy.promise);
      const api = createApiClient({ host: "same.example" });
      const result = api.getHealth(undefined, 50);
      const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
      await vi.advanceTimersByTimeAsync(50);
      await rejected;
      proxy.resolve("https://same.example");
      await Promise.resolve();
      expect(mockFetch).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
