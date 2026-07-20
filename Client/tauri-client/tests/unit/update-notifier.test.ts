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

  async function mountWithAvailableUpdate(): Promise<void> {
    mockCheckForUpdate.mockResolvedValue({ available: true, version: "1.2.0", body: "" });
    const notifier = createUpdateNotifier({ serverUrl: "https://s.example" });
    notifier.mount(host);
    await vi.advanceTimersByTimeAsync(3000); // fire the delayed check + resolve
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
});
