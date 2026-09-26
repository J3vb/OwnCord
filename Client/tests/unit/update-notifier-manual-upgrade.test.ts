import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — the notifier reads the update check and the shared install
// subscription, so both are replaced; nothing here reaches Tauri.
// ---------------------------------------------------------------------------

const { mockCheckForUpdate, mockSubscribeToUpdateInstall } = vi.hoisted(() => ({
  mockCheckForUpdate: vi.fn(),
  mockSubscribeToUpdateInstall: vi.fn(),
}));

vi.mock("@lib/logger", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock("@lib/updater", () => ({
  checkForUpdate: mockCheckForUpdate,
  downloadAndInstallUpdate: vi.fn(),
  subscribeToUpdateInstall: mockSubscribeToUpdateInstall,
}));

import { createUpdateNotifier } from "../../src/components/UpdateNotifier";
import type { UpdateInstallState } from "../../src/lib/updater";

const unsubscribeInstall = vi.fn();
const MANUAL_TEXT =
  "This install cannot update itself. Ask your server administrator for the new version.";

beforeEach(() => {
  mockSubscribeToUpdateInstall.mockImplementation(
    (listener: (state: UpdateInstallState) => void) => {
      listener({ status: "idle" });
      return unsubscribeInstall;
    },
  );
});

// ---------------------------------------------------------------------------
// A package install (deb/rpm): the server serves no updater artifact for it,
// so the check answers `available: false` forever. That is not the same fact
// as "you are up to date", and the banner has to say so.
// ---------------------------------------------------------------------------

describe("createUpdateNotifier on an install that cannot update itself", () => {
  let host: HTMLElement;
  let notifier: ReturnType<typeof createUpdateNotifier> | null;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    host = document.createElement("div");
    document.body.appendChild(host);
    notifier = null;
  });

  afterEach(() => {
    notifier?.destroy?.();
    vi.useRealTimers();
    host.remove();
  });

  function bannerText(): string | null | undefined {
    return host.querySelector(".update-banner-text")?.textContent;
  }

  async function mount(): Promise<void> {
    notifier = createUpdateNotifier({ serverUrl: "https://s.example" });
    notifier.mount(host);
    await vi.advanceTimersByTimeAsync(3000); // fire the delayed check + resolve
  }

  it("explains the install cannot update itself instead of staying silent", async () => {
    mockCheckForUpdate.mockResolvedValue({
      available: false,
      version: null,
      body: null,
      manual_upgrade: true,
    });

    await mount();

    expect(bannerText()).toBe(MANUAL_TEXT);
    // There is nothing to install here, so the banner must not offer to.
    expect(host.querySelector(".update-banner-install")).toBeNull();
  });

  it("is dismissible", async () => {
    mockCheckForUpdate.mockResolvedValue({
      available: false,
      version: null,
      body: null,
      manual_upgrade: true,
    });

    await mount();
    (host.querySelector(".update-banner-later") as HTMLButtonElement).click();

    expect(host.querySelector(".update-banner")).toBeNull();
  });

  it("stays silent when the install can update itself and there is no update", async () => {
    mockCheckForUpdate.mockResolvedValue({
      available: false,
      version: null,
      body: null,
      manual_upgrade: false,
    });

    await mount();

    // The warning is for installs that can never update, not for an ordinary
    // up-to-date client — otherwise it fires on every launch and means
    // nothing.
    expect(host.querySelector(".update-banner")).toBeNull();
  });

  it("shows the available update when the server offers one", async () => {
    mockCheckForUpdate.mockResolvedValue({
      available: true,
      version: "9.9.9",
      body: "",
      manual_upgrade: false,
    });

    await mount();

    expect(bannerText()).toBe("Update v9.9.9 available");
  });
});
