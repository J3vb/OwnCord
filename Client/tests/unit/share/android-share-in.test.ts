import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectConsole } from "../../helpers/console";

const native = vi.hoisted(() => ({
  shares: [] as unknown[],
  copying: 0,
  fail: false,
}));

const invoke = vi.hoisted(() =>
  vi.fn(async (command: string, args?: Record<string, unknown>) => {
    if (command === "take_shared") {
      if (native.fail) throw new Error("host refused");
      if (native.copying > 0) {
        native.copying -= 1;
        return { share: null, copying: true };
      }
      return { share: native.shares.shift() ?? null, copying: false };
    }
    if (command === "read_staged_file") return new Uint8Array([104, 105]).buffer;
    throw new Error(`unexpected ${command} ${JSON.stringify(args)}`);
  }),
);

vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const { COPY_POLL_MS, listenForShares, parseShare } =
  await import("../../../src/platform/desktop/androidShareIn");

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

beforeEach(() => {
  native.shares = [];
  native.copying = 0;
  native.fail = false;
  invoke.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
});

describe("parseShare", () => {
  it("turns staged files and refused ones into page files", async () => {
    const share = parseShare({
      text: "look",
      files: [{ token: 4, name: "a.png", size: 2 }],
      oversized: [{ name: "huge.mp4", size: 5_000_000_000 }],
    });
    expect(share?.text).toBe("look");
    expect(share?.files.map((f) => [f.name, f.size])).toEqual([
      ["a.png", 2],
      ["huge.mp4", 5_000_000_000],
    ]);
    const read = await share!.files[0]!.read();
    expect(read.type).toBe("image/png");
    expect(await read.text()).toBe("hi");
    expect(invoke).toHaveBeenCalledWith("read_staged_file", { token: 4 });
    await expect(share!.files[1]!.read()).rejects.toThrow();
  });

  it("is null for no share or an empty one", () => {
    expect(parseShare(null)).toBeNull();
    expect(parseShare({ text: "", files: [], oversized: [] })).toBeNull();
    expect(parseShare({ files: [{ token: "x" }] })).toBeNull();
  });
});

describe("listenForShares", () => {
  it("takes a share that arrived before it listened", async () => {
    native.shares.push({ text: "early", files: [], oversized: [] });
    const handler = vi.fn();
    const stop = listenForShares(handler);
    await flush();
    expect(handler).toHaveBeenCalledWith({ files: [], text: "early" });
    stop();
  });

  it("takes a share on each return to the app", async () => {
    const handler = vi.fn();
    const stop = listenForShares(handler);
    await flush();
    expect(handler).not.toHaveBeenCalled();
    native.shares.push({ text: "one", files: [], oversized: [] });
    document.dispatchEvent(new Event("visibilitychange"));
    await flush();
    native.shares.push({ text: "two", files: [], oversized: [] });
    document.dispatchEvent(new Event("visibilitychange"));
    await flush();
    expect(handler.mock.calls.map((c) => (c[0] as { text: string }).text)).toEqual(["one", "two"]);
    stop();
  });

  it("asks again while the host is still copying the files", async () => {
    vi.useFakeTimers();
    native.copying = 2;
    native.shares.push({ text: "big video", files: [], oversized: [] });
    const handler = vi.fn();
    const stop = listenForShares(handler);
    await flush();
    expect(handler).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(COPY_POLL_MS);
    expect(handler).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(COPY_POLL_MS);
    expect(handler).toHaveBeenCalledWith({ files: [], text: "big video" });
    stop();
  });

  it("stops asking once stopped", async () => {
    vi.useFakeTimers();
    native.copying = 5;
    const handler = vi.fn();
    const stop = listenForShares(handler);
    await flush();
    stop();
    const calls = invoke.mock.calls.length;
    native.shares.push({ text: "late", files: [], oversized: [] });
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(COPY_POLL_MS * 10);
    expect(invoke.mock.calls.length).toBe(calls);
    expect(handler).not.toHaveBeenCalled();
  });

  it("survives a host that refuses", async () => {
    native.fail = true;
    const handler = vi.fn();
    const stop = listenForShares(handler);
    await flush();
    expectConsole("warn", /Shared content not taken/);
    expect(handler).not.toHaveBeenCalled();
    stop();
  });
});
