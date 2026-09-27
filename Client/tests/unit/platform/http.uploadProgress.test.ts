// The upload-progress subscription on the HttpClient contract
// (`platform/desktop/http.ts`): the native `upload-progress` event the Rust
// HTTP proxy emits while a request body crosses the loopback tunnel. The
// desktop binding forwards every event verbatim; the caller correlates by id.
import { vi } from "vitest";
import { describe, expect, it } from "vitest";

const handlers = vi.hoisted(() => new Map<string, Set<(e: { payload: unknown }) => void>>());

vi.mock("@tauri-apps/api/event", () => ({
  listen: (event: string, handler: (e: { payload: unknown }) => void) => {
    const set = handlers.get(event) ?? new Set();
    set.add(handler);
    handlers.set(event, set);
    return Promise.resolve(() => set.delete(handler));
  },
}));

import { http } from "../../../src/platform/desktop/http";

function emit(payload: unknown): void {
  for (const handler of handlers.get("upload-progress") ?? []) handler({ payload });
}

describe("HttpClient.onUploadProgress (desktop binding)", () => {
  it("hands each upload-progress event to the subscriber verbatim", async () => {
    handlers.clear();
    const seen: unknown[] = [];
    http.onUploadProgress((p) => seen.push(p));
    // Let the async listen() registration settle before delivering.
    await vi.waitFor(() => expect(handlers.get("upload-progress")?.size ?? 0).toBeGreaterThan(0));
    emit({ id: "u-1", sent: 512, total: 2048 });
    expect(seen).toEqual([{ id: "u-1", sent: 512, total: 2048 }]);
  });

  it("stops delivering once unsubscribed", async () => {
    handlers.clear();
    const seen: unknown[] = [];
    const unsubscribe = http.onUploadProgress((p) => seen.push(p));
    await vi.waitFor(() => expect(handlers.get("upload-progress")?.size ?? 0).toBeGreaterThan(0));
    emit({ id: "u-1", sent: 1, total: 2 });
    unsubscribe();
    emit({ id: "u-1", sent: 2, total: 2 });
    expect(seen).toEqual([{ id: "u-1", sent: 1, total: 2 }]);
  });
});
