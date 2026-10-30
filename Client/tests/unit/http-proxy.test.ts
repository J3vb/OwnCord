import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@lib/logger", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { ensureHttpProxy } from "../../src/lib/net/httpProxy";

describe("ensureHttpProxy", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("starts a tunnel and returns the loopback origin", async () => {
    invokeMock.mockResolvedValue({ port: 51234, token: "t1" });
    const origin = await ensureHttpProxy("host-a.example:8443");
    expect(origin).toBe("http://127.0.0.1:51234/t1");
    expect(invokeMock).toHaveBeenCalledWith("start_http_proxy", {
      remoteHost: "host-a.example:8443",
    });
  });

  // B4_conn_ipc-11: the origin must NOT be cached in JS. Only Rust knows
  // whether its listener is still alive (it deregisters itself after 5
  // consecutive accept errors), so a JS-side cache would keep pointing every
  // REST call at a dead tunnel forever. Every call re-invokes start_http_proxy;
  // the Rust reuse branch dedups an unchanged, still-live host cheaply.
  it("does not cache the origin — every call re-invokes so a self-terminated tunnel can be rebound", async () => {
    invokeMock.mockResolvedValue({ port: 40000, token: "t1" });
    const a = await ensureHttpProxy("host-b.example:8443");
    // Simulates the Rust side rebinding a fresh port after the old tunnel's
    // accept loop gave up (fd exhaustion, etc.) and deregistered itself.
    invokeMock.mockResolvedValue({ port: 40001, token: "t2" });
    const b = await ensureHttpProxy("host-b.example:8443");
    expect(a).toBe("http://127.0.0.1:40000/t1");
    expect(b).toBe("http://127.0.0.1:40001/t2");
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });

  it("de-duplicates concurrent starts for the same host", async () => {
    let resolvePort: (p: { port: number; token: string }) => void = () => {};
    invokeMock.mockReturnValue(
      new Promise<{ port: number; token: string }>((r) => (resolvePort = r)),
    );
    const p1 = ensureHttpProxy("host-c.example:8443");
    const p2 = ensureHttpProxy("host-c.example:8443");
    resolvePort({ port: 45000, token: "t3" });
    const [o1, o2] = await Promise.all([p1, p2]);
    expect(o1).toBe("http://127.0.0.1:45000/t3");
    expect(o2).toBe("http://127.0.0.1:45000/t3");
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a tunnel reply without a port and a token", async () => {
    for (const reply of [51234, { port: 51234 }, { port: 51234, token: "" }, null]) {
      invokeMock.mockResolvedValue(reply);
      await expect(ensureHttpProxy("host-d.example:8443")).rejects.toThrow(
        "start_http_proxy returned no tunnel endpoint",
      );
    }
  });

  it("rejects with the native error when the tunnel cannot start", async () => {
    invokeMock.mockRejectedValue(new Error("bind failed"));
    await expect(ensureHttpProxy("host-e.example:8443")).rejects.toThrow(
      "start_http_proxy failed: bind failed",
    );
  });
});
