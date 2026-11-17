// The door to the host modules only the Android app has: one load, the calls
// in the order they were made, and nothing outside the Android app.
import { beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ android: true, warn: vi.fn(), names: [] as string[] }));
vi.mock("@lib/hostPlatform", () => ({ isAndroidHost: () => native.android }));
vi.mock("@lib/logger", () => ({
  createLogger: (name: string) => {
    native.names.push(name);
    return { warn: native.warn };
  },
}));

import { androidHost } from "../../../../src/platform/desktop/androidHost";

interface Host {
  say(word: string): void;
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  vi.clearAllMocks();
  native.android = true;
  native.names.length = 0;
});

describe("the Android host door", () => {
  it("loads the host side once and runs the calls in the order they were made", async () => {
    const said: string[] = [];
    const load = vi.fn(() => Promise.resolve<Host>({ say: (word) => said.push(word) }));
    const withHost = androidHost("door", load);
    expect(load).not.toHaveBeenCalled();
    withHost((host) => host.say("one"));
    withHost((host) => host.say("two"));
    await tick();
    withHost((host) => host.say("three"));
    await tick();
    expect(load).toHaveBeenCalledOnce();
    expect(said).toEqual(["one", "two", "three"]);
  });

  it("does nothing outside the Android app", async () => {
    native.android = false;
    const load = vi.fn(() => Promise.resolve<Host>({ say: vi.fn() }));
    const use = vi.fn();
    androidHost("door", load)(use);
    await tick();
    expect(load).not.toHaveBeenCalled();
    expect(use).not.toHaveBeenCalled();
  });

  it("logs a host side that cannot load under its name, and tries again at the next call", async () => {
    const said: string[] = [];
    const failure = new Error("chunk missing");
    const load = vi
      .fn<() => Promise<Host>>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValue({ say: (word) => said.push(word) });
    const withHost = androidHost("door", load);
    expect(() => withHost((host) => host.say("lost"))).not.toThrow();
    await tick();
    expect(native.names).toEqual(["door"]);
    expect(native.warn).toHaveBeenCalledWith("Android host side unavailable", failure);
    withHost((host) => host.say("kept"));
    await tick();
    expect(load).toHaveBeenCalledTimes(2);
    expect(said).toEqual(["kept"]);
  });
});
