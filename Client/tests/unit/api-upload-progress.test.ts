// `uploadFile` upload-progress plumbing (B11b): the API client tags each
// upload with a correlation id, subscribes to the native `upload-progress`
// event, forwards only this request's ticks to the caller, and unsubscribes
// once the request settles.
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockFetch, handlers } = vi.hoisted(() => ({
  mockFetch: vi.fn(),
  handlers: new Map<string, Set<(e: { payload: unknown }) => void>>(),
}));

vi.mock("@tauri-apps/plugin-http", () => ({ fetch: mockFetch }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (event: string, handler: (e: { payload: unknown }) => void) => {
    const set = handlers.get(event) ?? new Set();
    set.add(handler);
    handlers.set(event, set);
    return Promise.resolve(() => set.delete(handler));
  },
}));
vi.mock("../../src/lib/httpProxy", () => ({
  ensureHttpProxy: (host: string) => Promise.resolve(`https://${host}`),
}));

import { createApiClient } from "../../src/lib/api";

function emit(payload: unknown): void {
  for (const handler of handlers.get("upload-progress") ?? []) handler({ payload });
}

function jsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "OK",
    json: () => Promise.resolve(data),
    headers: new Headers(),
  } as unknown as Response;
}

describe("uploadFile progress", () => {
  let api: ReturnType<typeof createApiClient>;

  beforeEach(() => {
    mockFetch.mockReset();
    handlers.clear();
    api = createApiClient({ host: "localhost:8443", token: "tok" });
  });

  it("tags the upload with an id and forwards that id's ticks", async () => {
    const progress: number[] = [];
    let settle: (r: Response) => void = () => {};
    mockFetch.mockReturnValue(
      new Promise<Response>((resolve) => {
        settle = resolve;
      }),
    );

    const file = new File(["x"], "a.png", { type: "image/png" });
    const upload = api.uploadFile(file, undefined, (p) => progress.push(p));

    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    const headers = mockFetch.mock.calls[0]![1].headers as Record<string, string>;
    const id = headers["X-Upload-Id"];
    expect(id).toBeTruthy();

    // A tick for a different upload must not reach this caller.
    emit({ id: "someone-else", sent: 5, total: 100 });
    emit({ id, sent: 50, total: 100 });
    expect(progress).toEqual([0.5]);

    settle(jsonResponse({ id: "srv", url: "/f", filename: "a.png", size: 1, mime: "image/png" }));
    await upload;
    expect(mockFetch.mock.calls[0]![0]).toBe("https://localhost:8443/api/v1/uploads");
  });

  it("unsubscribes once the upload settles", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ id: "srv", url: "/f", filename: "a.png" }));
    const file = new File(["x"], "a.png", { type: "image/png" });
    await api.uploadFile(file, undefined, () => {});
    expect(handlers.get("upload-progress")?.size ?? 0).toBe(0);
  });

  it("sends no correlation header when no progress callback is given", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ id: "srv", url: "/f", filename: "a.png" }));
    const file = new File(["x"], "a.png", { type: "image/png" });
    await api.uploadFile(file);
    const headers = mockFetch.mock.calls[0]![1].headers as Record<string, string>;
    expect(headers["X-Upload-Id"]).toBeUndefined();
  });
});
