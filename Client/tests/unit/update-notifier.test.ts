import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const { mockCheckForUpdate, mockDownloadAndInstall, mockSubscribeToUpdateInstall } = vi.hoisted(
  () => ({
    mockCheckForUpdate: vi.fn(),
    mockDownloadAndInstall: vi.fn(),
    mockSubscribeToUpdateInstall: vi.fn(),
  }),
);

vi.mock("@lib/logger", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock("@lib/updater", () => ({
  checkForUpdate: mockCheckForUpdate,
  downloadAndInstallUpdate: mockDownloadAndInstall,
  subscribeToUpdateInstall: mockSubscribeToUpdateInstall,
}));

import { createUpdateNotifier, formatDownloadProgress } from "../../src/components/UpdateNotifier";
import type { UpdateInstallState } from "../../src/lib/updater";

let onInstallState: (state: UpdateInstallState) => void;
const unsubscribeInstall = vi.fn();

beforeEach(() => {
  mockSubscribeToUpdateInstall.mockImplementation(
    (listener: (state: UpdateInstallState) => void) => {
      onInstallState = listener;
      listener({ status: "idle" });
      return unsubscribeInstall;
    },
  );
});

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

  it("updates the banner from the shared install subscription", async () => {
    mockDownloadAndInstall.mockImplementation(() => {
      onInstallState({ status: "downloading", progress: null });
      return new Promise<void>(() => {}); // never resolves — stays "downloading"
    });

    const notifier = await mountWithAvailableUpdate();
    (host.querySelector(".update-banner-install") as HTMLButtonElement).click();

    // Initial state before any progress event.
    expect(bannerText()).toBe("Downloading update…");
    expect(mockDownloadAndInstall).toHaveBeenCalledWith("https://s.example");

    onInstallState({ status: "downloading", progress: { received: 25, total: 100 } });
    expect(bannerText()).toBe("Downloading update… 25%");

    onInstallState({ status: "downloading", progress: { received: 2 * 1024 * 1024, total: null } });
    expect(bannerText()).toBe("Downloading update… 2.0 MB");
    notifier.destroy?.();
    expect(unsubscribeInstall).toHaveBeenCalledTimes(1);
  });

  it("shows a failure message when the download rejects", async () => {
    mockDownloadAndInstall.mockImplementation(() => {
      onInstallState({ status: "failed", restartRequired: false });
      return Promise.reject(new Error("boom"));
    });

    await mountWithAvailableUpdate();
    (host.querySelector(".update-banner-install") as HTMLButtonElement).click();

    // Let the rejected install promise settle and the catch run.
    await Promise.resolve();
    await Promise.resolve();

    expect(bannerText()).toBe("Update failed. Please try again later.");
    expect(host.querySelector(".update-banner-install")?.textContent).toBe("Retry");
  });

  it("shows an existing install immediately without offering another update", async () => {
    mockSubscribeToUpdateInstall.mockImplementation(
      (listener: (state: UpdateInstallState) => void) => {
        listener({ status: "downloading", progress: { received: 60, total: 100 } });
        return unsubscribeInstall;
      },
    );
    const notifier = createUpdateNotifier({ serverUrl: "https://s.example" });
    notifier.mount(host);
    expect(bannerText()).toBe("Downloading update… 60%");
    expect(host.querySelector(".update-banner-install")).toBeNull();
    await vi.advanceTimersByTimeAsync(3000);
    expect(mockCheckForUpdate).not.toHaveBeenCalled();
    notifier.destroy?.();
  });

  it("asks for a manual restart after installation succeeds but relaunch fails", async () => {
    const notifier = await mountWithAvailableUpdate();
    onInstallState({ status: "restarting" });
    expect(bannerText()).toBe("Update installed. Restarting…");
    onInstallState({ status: "failed", restartRequired: true });
    expect(bannerText()).toBe("Update installed. Please restart OwnCord to finish.");
    expect(host.querySelector(".update-banner-install")).toBeNull();
    notifier.destroy?.();
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
