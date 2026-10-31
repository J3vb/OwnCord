import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const claims = vi.hoisted(() => ({
  onBack: [] as Array<() => void>,
  released: 0,
}));
vi.mock("../../lib/ui/backHistory", () => ({
  claimBack: (onBack: () => void) => {
    claims.onBack.push(onBack);
    return {
      release: () => {
        claims.released += 1;
      },
    };
  },
}));

import { beginPhoneFullscreen } from "./phoneFullscreen";

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("beginPhoneFullscreen", () => {
  beforeEach(() => {
    claims.onBack.length = 0;
    claims.released = 0;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("asks for landscape, and end() gives Back and the rotation up once", async () => {
    const lock = vi.fn().mockResolvedValue(undefined);
    const unlock = vi.fn();
    vi.stubGlobal("screen", { orientation: { lock, unlock } });

    const held = beginPhoneFullscreen(vi.fn());
    expect(lock).toHaveBeenCalledWith("landscape");
    await flush();
    held.end();
    held.end();
    expect(claims.released).toBe(1);
    expect(unlock).toHaveBeenCalledTimes(1);
  });

  it("a Back frees the rotation before it calls the owner", async () => {
    const order: string[] = [];
    const unlock = vi.fn(() => order.push("unlock"));
    vi.stubGlobal("screen", {
      orientation: { lock: vi.fn().mockResolvedValue(undefined), unlock },
    });
    beginPhoneFullscreen(() => order.push("back"));
    await flush();

    claims.onBack[0]!();
    expect(order).toEqual(["unlock", "back"]);
  });

  it("a lock that is granted after end() is given straight back", async () => {
    let grant!: () => void;
    const lock = vi.fn(() => new Promise<void>((resolve) => (grant = resolve)));
    const unlock = vi.fn();
    vi.stubGlobal("screen", { orientation: { lock, unlock } });

    beginPhoneFullscreen(vi.fn()).end();
    expect(unlock).not.toHaveBeenCalled();
    grant();
    await vi.waitFor(() => expect(unlock).toHaveBeenCalledTimes(1));
  });

  it.each([
    [
      "a refused lock",
      () => ({ lock: vi.fn().mockRejectedValue(new Error("refused")), unlock: vi.fn() }),
    ],
    [
      "a throwing lock",
      () => ({
        lock: vi.fn(() => {
          throw new Error("sync");
        }),
        unlock: vi.fn(),
      }),
    ],
    ["no orientation", () => undefined],
    ["no lock method", () => ({})],
  ])("%s leaves the screen alone", async (_name, make) => {
    const orientation: { unlock?: ReturnType<typeof vi.fn> } | undefined = make();
    vi.stubGlobal("screen", { orientation });
    const held = beginPhoneFullscreen(vi.fn());
    await flush();
    expect(() => held.end()).not.toThrow();
    expect(orientation?.unlock?.mock.calls.length ?? 0).toBe(0);
  });

  it("survives an unlock that throws", async () => {
    vi.stubGlobal("screen", {
      orientation: {
        lock: vi.fn().mockResolvedValue(undefined),
        unlock: vi.fn(() => {
          throw new Error("no");
        }),
      },
    });
    const held = beginPhoneFullscreen(vi.fn());
    await flush();
    expect(() => held.end()).not.toThrow();
  });
});
