// 6.13d: a Settings control for a capability the platform lacks is not drawn,
// so the web build never offers a control that calls a refusing adapter. Each
// of the four `available` flags is driven both ways: with it false the control
// is absent and its adapter is never called; with it true the control is there
// (the positive control, so the absence above cannot be a broken query).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const platform = vi.hoisted(() => ({
  available: false,
  isEnabled: vi.fn(),
  enable: vi.fn(),
  disable: vi.fn(),
  loadPrefs: vi.fn(),
  setPref: vi.fn(),
  openDevTools: vi.fn(),
  checkForUpdate: vi.fn(),
  download: vi.fn(),
  subscribe: vi.fn(),
}));

vi.mock("../../src/platform/desktop", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/platform/desktop")>();
  return {
    desktop: {
      ...real.desktop,
      autostart: {
        get available() {
          return platform.available;
        },
        isEnabled: platform.isEnabled,
        enable: platform.enable,
        disable: platform.disable,
      },
      windowPrefs: { load: platform.loadPrefs, set: platform.setPref },
      window: {
        ...real.desktop.window,
        get available() {
          return platform.available;
        },
      },
      devTools: {
        get available() {
          return platform.available;
        },
        open: platform.openDevTools,
      },
      appMetadata: { getVersion: () => Promise.resolve("1.0.0") },
      updater: {
        get available() {
          return platform.available;
        },
        checkForUpdate: platform.checkForUpdate,
        downloadAndInstallUpdate: platform.download,
        subscribeToInstall: platform.subscribe,
      },
    },
  };
});
vi.mock("../../src/features/messaging/content/attachments", () => ({
  clearAttachmentCaches: vi.fn(),
  clearExternalImageCache: vi.fn(),
}));
vi.mock("../../src/features/messaging/content/embeds", () => ({ clearEmbedCaches: vi.fn() }));
vi.mock("../../src/features/messaging/content/media", () => ({ clearMediaCaches: vi.fn() }));
vi.mock("@lib/logPersistence", () => ({ clearPendingPersistedLogs: vi.fn() }));
vi.mock("../../src/features/whats-new/changelogSource", () => ({
  loadChangelog: () => Promise.resolve([]),
}));

import { buildAboutTab } from "../../src/features/settings/AboutTab";
import { buildAdvancedTab } from "../../src/features/settings/AdvancedTab";

const ADVANCED_LABELS = ["Launch on Login", "Close to Tray", "Start Minimized"];

let controller: AbortController;

beforeEach(() => {
  controller = new AbortController();
  platform.isEnabled.mockReset().mockResolvedValue(false);
  platform.enable.mockReset().mockResolvedValue(undefined);
  platform.disable.mockReset().mockResolvedValue(undefined);
  platform.loadPrefs.mockReset().mockResolvedValue({ minimizeToTray: true, startMinimized: false });
  platform.setPref.mockReset().mockResolvedValue(true);
  platform.openDevTools.mockReset().mockResolvedValue(undefined);
  platform.checkForUpdate.mockReset().mockRejectedValue(new Error("refused"));
  platform.download.mockReset().mockRejectedValue(new Error("refused"));
  platform.subscribe.mockReset().mockImplementation(() => () => undefined);
});

afterEach(() => {
  controller.abort();
});

function labels(root: HTMLElement): string[] {
  return Array.from(root.querySelectorAll(".setting-label"), (el) => el.textContent ?? "");
}

function hasButton(root: HTMLElement, text: string): boolean {
  return Array.from(root.querySelectorAll("button")).some((b) => b.textContent === text);
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("Advanced tab capabilities", () => {
  it("draws no autostart, window or DevTools control when the platform lacks them", async () => {
    platform.available = false;
    const tab = buildAdvancedTab(controller.signal);
    await settle();
    for (const label of ADVANCED_LABELS) expect(labels(tab)).not.toContain(label);
    expect(hasButton(tab, "Open DevTools")).toBe(false);
    expect(platform.isEnabled).not.toHaveBeenCalled();
    expect(platform.loadPrefs).not.toHaveBeenCalled();
    expect(platform.openDevTools).not.toHaveBeenCalled();
    // What every platform has stays.
    expect(labels(tab)).toContain("Developer Mode");
  });

  it("draws them when it has them, and reads each adapter once", async () => {
    platform.available = true;
    const tab = buildAdvancedTab(controller.signal);
    await settle();
    for (const label of ADVANCED_LABELS) expect(labels(tab)).toContain(label);
    expect(hasButton(tab, "Open DevTools")).toBe(true);
    expect(platform.isEnabled).toHaveBeenCalledOnce();
    expect(platform.loadPrefs).toHaveBeenCalledOnce();
  });
});

describe("About tab capabilities", () => {
  it("draws no update card or update check when the platform cannot update", async () => {
    platform.available = false;
    const tab = buildAboutTab(controller.signal);
    await settle();
    expect(tab.querySelector("[data-testid=about-update]")).toBeNull();
    expect(tab.querySelector("[data-testid=update-check-status]")).toBeNull();
    expect(hasButton(tab, "Check for updates")).toBe(false);
    expect(platform.subscribe).not.toHaveBeenCalled();
    expect(platform.checkForUpdate).not.toHaveBeenCalled();
    // The version and the notes are not the updater's.
    expect(tab.querySelector("[data-testid=about-version]")).not.toBeNull();
  });

  it("draws them when it can", async () => {
    platform.available = true;
    const tab = buildAboutTab(controller.signal);
    await settle();
    expect(tab.querySelector("[data-testid=about-update]")).not.toBeNull();
    expect(tab.querySelector("[data-testid=update-check-status]")).not.toBeNull();
    expect(hasButton(tab, "Check for updates")).toBe(true);
  });
});
