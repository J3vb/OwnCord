import { describe, it, expect, vi, beforeEach } from "vitest";

const showToast = vi.fn();
vi.mock("@lib/ui/toast", () => ({ showToast: (...a: unknown[]) => showToast(...a) }));

import { expectConsole } from "../helpers/console";
import { createLazyScreen } from "../../src/components/lazyScreen";
import { shellText } from "../../src/i18n/shell";

describe("createLazyScreen", () => {
  beforeEach(() => {
    showToast.mockClear();
  });

  it("imports once for two triggers while the first is loading", async () => {
    let resolve!: (m: { n: number }) => void;
    const importer = vi.fn(
      () =>
        new Promise<{ n: number }>((r) => {
          resolve = r;
        }),
    );
    const screen = createLazyScreen("test-screen", importer);
    const a = screen.load();
    const b = screen.load();
    resolve({ n: 1 });
    expect(await a).toEqual({ n: 1 });
    expect(await b).toEqual({ n: 1 });
    expect(importer).toHaveBeenCalledTimes(1);
    await screen.load();
    expect(importer).toHaveBeenCalledTimes(1);
  });

  it("shows the generic error toast on a failed import and loads again on the next try", async () => {
    const importer = vi
      .fn<() => Promise<{ n: number }>>()
      .mockRejectedValueOnce(new Error("chunk 404"))
      .mockResolvedValueOnce({ n: 2 });
    const screen = createLazyScreen("test-screen", importer);
    expect(await screen.load()).toBeNull();
    expectConsole("error", /Failed to load test-screen/);
    expect(showToast).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledWith(shellText("common.openFailed"), "error");
    expect(await screen.load()).toEqual({ n: 2 });
    expect(importer).toHaveBeenCalledTimes(2);
    expect(showToast).toHaveBeenCalledTimes(1);
  });

  it("loadOrThrow rejects without a toast and does not cache the failure", async () => {
    const importer = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce("ok");
    const screen = createLazyScreen("test-screen", importer);
    await expect(screen.loadOrThrow()).rejects.toThrow("offline");
    expect(showToast).not.toHaveBeenCalled();
    await expect(screen.loadOrThrow()).resolves.toBe("ok");
  });

  it("toasts once when two callers share one failed attempt", async () => {
    const importer = vi.fn<() => Promise<string>>().mockRejectedValue(new Error("chunk 404"));
    const screen = createLazyScreen("test-screen", importer);
    const [a, b] = await Promise.all([screen.load(), screen.load()]);
    expect(a).toBeNull();
    expect(b).toBeNull();
    expect(importer).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledTimes(1);
    expectConsole("error", /Failed to load test-screen/);
  });

  it("does not toast for a caller that already cancelled", async () => {
    const importer = vi.fn<() => Promise<string>>().mockRejectedValue(new Error("chunk 404"));
    const screen = createLazyScreen("test-screen", importer);
    let wanted = true;
    const pending = screen.load(() => wanted);
    wanted = false;
    expect(await pending).toBeNull();
    expect(showToast).not.toHaveBeenCalled();
  });
});
