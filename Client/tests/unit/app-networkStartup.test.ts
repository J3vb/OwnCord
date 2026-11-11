import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const start = vi.hoisted(() => vi.fn<(signal: AbortSignal) => Promise<void>>());
vi.mock("../../src/platform/desktop", () => ({
  desktop: { meteredNetwork: { start, isMetered: () => false } },
}));

import { NETWORK_STARTUP_WAIT_MS, startNetworkMonitoring } from "../../src/app/networkStartup";

describe("startNetworkMonitoring", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    start.mockReset();
  });
  afterEach(() => {
    window.dispatchEvent(new Event("beforeunload"));
    vi.useRealTimers();
  });

  it("settles when the first reading arrives", async () => {
    start.mockResolvedValue(undefined);
    let settled = false;
    void startNetworkMonitoring().then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(true);
  });

  it("stops waiting when the host never answers", async () => {
    start.mockReturnValue(new Promise<void>(() => {}));
    let settled = false;
    void startNetworkMonitoring().then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(NETWORK_STARTUP_WAIT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
  });

  it("settles when the reading fails", async () => {
    start.mockRejectedValue(new Error("host gone"));
    let settled = false;
    void startNetworkMonitoring().then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(true);
  });
});
