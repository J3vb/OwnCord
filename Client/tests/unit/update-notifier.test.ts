import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const { mockCheckForUpdate, mockDownloadAndInstall } = vi.hoisted(() => ({
  mockCheckForUpdate: vi.fn(),
  mockDownloadAndInstall: vi.fn(),
}));

vi.mock("@lib/logger", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock("@lib/updater", () => ({
  checkForUpdate: mockCheckForUpdate,
  downloadAndInstallUpdate: mockDownloadAndInstall,
}));

import { createUpdateNotifier, formatDownloadProgress } from "../../src/components/UpdateNotifier";
import type { DownloadProgress } from "../../src/lib/updater";

// ---------------------------------------------------------------------------
// Pure formatter
// ---------------------------------------------------------------------------

describe("formatDownloadProgress", () => {
  it("shows a percentage when the total size is known", () => {
    expect(formatDownloadProgress({ received: 50, total: 100 })).toBe("Downloading update… 50%");
  });

  it("clamps the percentage to 0..100", () => {
    expect(formatDownloadProgress({ received: 250, total: 100 })).toBe("Downloading update… 100%");
  });

  it("falls back to bytes (MB) when the total is unknown", () => {
    expect(formatDownloadProgress({ received: 5 * 1024 * 1024, total: null })).toBe(
      "Downloading update… 5.0 MB",
    );
  });
});

// ---------------------------------------------------------------------------
// Banner rendering
// ---------------------------------------------------------------------------

describe("createUpdateNotifier download progress", () => {
  let host: HTMLElement;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    host = document.createElement("div");
    document.body.appendChild(host);
  });

  afterEach(() => {
    vi.useRealTimers();
    host.remove();
  });

  async function mountWithAvailableUpdate(): Promise<ReturnType<typeof createUpdateNotifier>> {
    mockCheckForUpdate.mockResolvedValue({ available: true, version: "1.2.0", body: "" });
    const notifier = createUpdateNotifier({ serverUrl: "https://s.example" });
    notifier.mount(host);
    await vi.advanceTimersByTimeAsync(3000); // fire the delayed check + resolve
    return notifier;
  }

  function bannerText(): string | null | undefined {
    return host.querySelector(".update-banner-text")?.textContent;
  }

  it("updates the banner from the updater progress callback", async () => {
    let onProgress: ((p: DownloadProgress) => void) | undefined;
    mockDownloadAndInstall.mockImplementation((_url: string, cb: (p: DownloadProgress) => void) => {
      onProgress = cb;
      return new Promise<void>(() => {}); // never resolves — stays "downloading"
    });

    await mountWithAvailableUpdate();
    (host.querySelector(".update-banner-install") as HTMLButtonElement).click();

    // Initial state before any progress event.
    expect(bannerText()).toBe("Downloading update…");
    expect(mockDownloadAndInstall).toHaveBeenCalledWith("https://s.example", expect.any(Function));

    onProgress!({ received: 25, total: 100 });
    expect(bannerText()).toBe("Downloading update… 25%");

    onProgress!({ received: 2 * 1024 * 1024, total: null });
    expect(bannerText()).toBe("Downloading update… 2.0 MB");
  });

  it("shows a failure message when the download rejects", async () => {
    mockDownloadAndInstall.mockRejectedValue(new Error("boom"));

    await mountWithAvailableUpdate();
    (host.querySelector(".update-banner-install") as HTMLButtonElement).click();

    // Let the rejected install promise settle and the catch run.
    await Promise.resolve();
    await Promise.resolve();

    expect(bannerText()).toBe("Update failed. Please try again later.");
  });

  it("does not throw (unhandled rejection) when destroyed mid-download and the download later fails", async () => {
    let rejectDownload: (err: Error) => void = () => {};
    mockDownloadAndInstall.mockImplementation(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectDownload = reject;
        }),
    );

    const notifier = await mountWithAvailableUpdate();
    (host.querySelector(".update-banner-install") as HTMLButtonElement).click();

    // Page swap / logout tears the component down while the download is
    // still in flight -- the banner element is now null.
    notifier.destroy?.();

    // Real timers so the unhandledRejection check (a macrotask under Node)
    // can actually run before the assertion. No @types/node in this project
    // (tsconfig has no "node" lib), so reach the global the same untyped way
    // other suites reach a browser-only global jsdom doesn't type either
    // (see audio-pipeline-vad-worklet.test.ts's globalThis casts).
    vi.useRealTimers();
    const unhandled = vi.fn();
    (globalThis as any).process.once("unhandledRejection", unhandled);
    rejectDownload(new Error("boom"));
    await new Promise((r) => setTimeout(r, 0));

    expect(unhandled).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Deferred check timer lifecycle
// ---------------------------------------------------------------------------

describe("createUpdateNotifier deferred check timer", () => {
  let host: HTMLElement;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockCheckForUpdate.mockResolvedValue({ available: false, version: null, body: null });
    host = document.createElement("div");
    document.body.appendChild(host);
  });

  afterEach(() => {
    vi.useRealTimers();
    host.remove();
  });

  it("does not check for updates when destroyed before the delayed check fires", async () => {
    const notifier = createUpdateNotifier({ serverUrl: "https://s.example" });
    notifier.mount(host);

    // Page swap / logout tears the component down inside the 3s window.
    notifier.destroy?.();
    await vi.advanceTimersByTimeAsync(3000);

    expect(mockCheckForUpdate).not.toHaveBeenCalled();
  });

  it("still checks for updates when the component stays mounted", async () => {
    const notifier = createUpdateNotifier({ serverUrl: "https://s.example" });
    notifier.mount(host);

    await vi.advanceTimersByTimeAsync(3000);

    expect(mockCheckForUpdate).toHaveBeenCalledWith("https://s.example");
    notifier.destroy?.();
  });
});
