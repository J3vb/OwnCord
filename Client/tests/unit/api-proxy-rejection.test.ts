import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockEnsureHttpProxy, mockFetch } = vi.hoisted(() => ({
  mockEnsureHttpProxy: vi.fn(),
  mockFetch: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-http", () => ({ fetch: mockFetch }));
vi.mock("../../src/lib/net/httpProxy", () => ({
  ensureHttpProxy: mockEnsureHttpProxy,
  stopHttpProxy: () => Promise.resolve(),
}));

import { createApiClient, TransportError } from "../../src/lib/api";
import { expectConsole } from "../helpers/console";

function client() {
  return createApiClient({ host: "localhost:8443", token: "t" }, vi.fn());
}

// The Rust `start_http_proxy` command rejects with a bare string (bind failure,
// unreachable host). A REST call must surface that as the same typed
// TransportError a failed fetch gets, not as the raw rejection.
describe("api: start_http_proxy rejection", () => {
  beforeEach(() => {
    mockEnsureHttpProxy.mockReset();
    mockFetch.mockReset();
  });

  it("maps a string rejection to a TransportError that keeps the cause", async () => {
    mockEnsureHttpProxy.mockRejectedValue("failed to bind loopback port");
    const err = await client()
      .getMe()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransportError);
    expect((err as TransportError).cause).toBe("failed to bind loopback port");
    expect(mockFetch).not.toHaveBeenCalled();
    expectConsole("error", /\[api\] API proxy start failed/);
  });

  it("maps an Error rejection to a TransportError carrying its message", async () => {
    const boom = new Error("tunnel refused");
    mockEnsureHttpProxy.mockRejectedValue(boom);
    const err = await client()
      .getMe()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransportError);
    expect((err as TransportError).message).toBe("tunnel refused");
    expect((err as TransportError).cause).toBe(boom);
    expectConsole("error", /\[api\] API proxy start failed/);
  });
});
