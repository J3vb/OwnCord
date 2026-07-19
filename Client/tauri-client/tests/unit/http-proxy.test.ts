import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@lib/logger", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { ensureHttpProxy, stopHttpProxy } from "../../src/lib/httpProxy";

describe("ensureHttpProxy", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    // Clear per-host cache between tests by stopping any previously started host.
    return stopHttpProxy("cache.example:8443").then(() => invokeMock.mockReset());
  });

  it("starts a tunnel and returns the loopback origin", async () => {
    invokeMock.mockResolvedValue(51234);
    const origin = await ensureHttpProxy("host-a.example:8443");
    expect(origin).toBe("http://127.0.0.1:51234");
    expect(invokeMock).toHaveBeenCalledWith("start_http_proxy", {
      remoteHost: "host-a.example:8443",
    });
  });

  it("caches the origin per host (one start per host)", async () => {
    invokeMock.mockResolvedValue(40000);
    const a = await ensureHttpProxy("host-b.example:8443");
    const b = await ensureHttpProxy("host-b.example:8443");
    expect(a).toBe(b);
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it("de-duplicates concurrent starts for the same host", async () => {
    let resolvePort: (p: number) => void = () => {};
    invokeMock.mockReturnValue(new Promise<number>((r) => (resolvePort = r)));
    const p1 = ensureHttpProxy("host-c.example:8443");
    const p2 = ensureHttpProxy("host-c.example:8443");
    resolvePort(45000);
    const [o1, o2] = await Promise.all([p1, p2]);
    expect(o1).toBe("http://127.0.0.1:45000");
    expect(o2).toBe("http://127.0.0.1:45000");
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it("stopHttpProxy invokes stop and drops the cache so a restart re-invokes", async () => {
    invokeMock.mockResolvedValue(46000);
    await ensureHttpProxy("host-d.example:8443");
    await stopHttpProxy("host-d.example:8443");
    expect(invokeMock).toHaveBeenCalledWith("stop_http_proxy", {
      remoteHost: "host-d.example:8443",
    });

    invokeMock.mockReset();
    invokeMock.mockResolvedValue(46001);
    const origin = await ensureHttpProxy("host-d.example:8443");
    expect(origin).toBe("http://127.0.0.1:46001");
    expect(invokeMock).toHaveBeenCalledWith("start_http_proxy", {
      remoteHost: "host-d.example:8443",
    });
  });
});
