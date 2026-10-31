// The Android app leaves out the settings that only a desktop has and words the
// rest without "desktop", "taskbar" or a keyboard shortcut. Each case checks the
// desktop app still shows what the Android app hides.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as voiceSession from "../helpers/voiceSessionMock";

const { mockGetVersion, mockLoad } = vi.hoisted(() => ({
  mockGetVersion: vi.fn<() => Promise<string | null>>(),
  mockLoad: vi.fn<() => Promise<{ version: string; body: string }[]>>(),
}));
vi.mock("../../src/platform/desktop", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/platform/desktop")>();
  return {
    desktop: {
      ...real.desktop,
      appMetadata: { getVersion: mockGetVersion },
      autostart: { ...real.desktop.autostart, available: true },
      window: { ...real.desktop.window, available: true },
    },
  };
});
vi.mock("../../src/features/whats-new/changelogSource", () => ({ loadChangelog: mockLoad }));
vi.mock("@lib/voice/livekitSession", () => voiceSession.defaults());
vi.mock("@stores/ui.store", () => ({ setTheme: vi.fn() }));

import { buildAboutTab } from "@components/settings/AboutTab";
import { buildAdvancedTab } from "@components/settings/AdvancedTab";
import { buildAppearanceTab } from "@components/settings/AppearanceTab";
import { buildNotificationsTab } from "@components/settings/NotificationsTab";
import { buildTextImagesTab } from "@components/settings/TextImagesTab";
import { createLogsTab } from "@components/settings/LogsTab";
import { buildCustomThemeSection } from "../../src/features/custom-themes/customThemeSection";
import { gameDetector } from "../../src/platform/desktop/gameDetector";
import { mediaDetector } from "../../src/platform/desktop/mediaDetector";
import { systemIdle } from "../../src/platform/desktop/systemIdle";
import { startAutoIdle } from "@lib/presence/autoIdle";
import { clearHost, hostAndroidApp, hostDesktopApp } from "../helpers/androidHost";
import { gameActivityText } from "../../src/i18n/gameActivity";
import type { TabName } from "@components/SettingsOverlay";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/plugin-autostart", () => ({
  isEnabled: vi.fn().mockResolvedValue(false),
  enable: vi.fn().mockResolvedValue(undefined),
  disable: vi.fn().mockResolvedValue(undefined),
}));

let ac: AbortController;
let container: HTMLDivElement;

beforeEach(() => {
  localStorage.clear();
  invokeMock.mockReset().mockResolvedValue(undefined);
  mockGetVersion.mockResolvedValue("1.0.0");
  mockLoad.mockResolvedValue([]);
  ac = new AbortController();
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(() => {
  ac.abort();
  container.remove();
  clearHost();
});

/** Every row label and description text in the pane. */
function rowTexts(el: HTMLElement): string[] {
  return [...el.querySelectorAll(".setting-label, .setting-desc")].map((n) => n.textContent ?? "");
}
const hasText = (el: HTMLElement, text: string): boolean => rowTexts(el).includes(text);

async function mounted(build: () => HTMLElement): Promise<HTMLElement> {
  const el = build();
  container.appendChild(el);
  // Let the rows that read the host settle (and remove themselves on failure).
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
  return el;
}

describe("Notifications", () => {
  it("has the taskbar flash, unread badge and desktop wording on the desktop app", async () => {
    hostDesktopApp();
    const el = await mounted(() => buildNotificationsTab(ac.signal));
    expect(hasText(el, "Flash Taskbar")).toBe(true);
    expect(hasText(el, "Unread message badge")).toBe(true);
    expect(hasText(el, "Desktop Notifications")).toBe(true);
    expect(hasText(el, "Show desktop notifications for messages")).toBe(true);
  });

  it("leaves out the taskbar flash and unread badge, and drops 'desktop', on Android", async () => {
    hostAndroidApp();
    const el = await mounted(() => buildNotificationsTab(ac.signal));
    expect(hasText(el, "Flash Taskbar")).toBe(false);
    expect(hasText(el, "Unread message badge")).toBe(false);
    expect(hasText(el, "Desktop Notifications")).toBe(false);
    expect(hasText(el, "Notifications")).toBe(true);
    expect(hasText(el, "Show notifications for messages")).toBe(true);
    // The rest of the rows are still there, and the first toggle still saves its pref.
    expect(hasText(el, "Suppress @everyone")).toBe(true);
    const toggle = el.querySelector<HTMLElement>('.toggle[aria-label="Notifications"]')!;
    toggle.click();
    expect(localStorage.getItem("owncord:settings:desktopNotifications")).toBe("false");
  });
});

describe("Advanced", () => {
  const desktopRows = ["Launch on Login", "Close to Tray", "Start Minimized"];
  const gameRow = gameActivityText("settings.share.label");

  it("has the login, tray and activity rows on the desktop app", async () => {
    hostDesktopApp();
    invokeMock.mockImplementation(async (cmd: string) =>
      cmd === "get_window_prefs" ? { minimizeToTray: true, startMinimized: false } : undefined,
    );
    const el = await mounted(() => buildAdvancedTab(ac.signal));
    for (const label of desktopRows) expect(hasText(el, label), label).toBe(true);
    expect(hasText(el, gameRow)).toBe(true);
    expect(el.querySelector("[data-testid='music-activity-row']")).not.toBeNull();
  });

  it("builds no login, tray, game or music rows on Android, even if the host answers", async () => {
    hostAndroidApp();
    invokeMock.mockImplementation(async (cmd: string) =>
      cmd === "get_window_prefs" ? { minimizeToTray: true, startMinimized: false } : undefined,
    );
    const el = await mounted(() => buildAdvancedTab(ac.signal));
    for (const label of desktopRows) expect(hasText(el, label), label).toBe(false);
    expect(hasText(el, gameRow)).toBe(false);
    expect(el.querySelector("[data-testid='music-activity-row']")).toBeNull();
    expect(invokeMock).not.toHaveBeenCalledWith("get_window_prefs");
    // What every build has stays.
    expect(hasText(el, "Developer Mode")).toBe(true);
  });
});

describe("game and music detection", () => {
  it("is available on the desktop app and not on Android", () => {
    hostDesktopApp();
    expect(gameDetector.available).toBe(true);
    expect(mediaDetector.available).toBe(true);
    hostAndroidApp();
    expect(gameDetector.available).toBe(false);
    expect(mediaDetector.available).toBe(false);
  });
});

describe("system idle", () => {
  it("asks the host on the desktop app", async () => {
    hostDesktopApp();
    invokeMock.mockResolvedValue(1234);
    await expect(systemIdle.idleMs()).resolves.toBe(1234);
    expect(invokeMock).toHaveBeenCalledWith("system_idle_ms");
  });

  it("answers 'unknown' on Android without asking the host, so the in-app timer rules", async () => {
    hostAndroidApp();
    await expect(systemIdle.idleMs()).resolves.toBeNull();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("an unknown answer leaves auto-idle on its own activity timer", async () => {
    vi.useFakeTimers();
    try {
      hostAndroidApp();
      const onStatusChange = vi.fn();
      const idle = startAutoIdle({
        onStatusChange,
        systemIdleMs: () => systemIdle.idleMs(),
      });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(invokeMock).not.toHaveBeenCalled();
      idle.destroy();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Appearance", () => {
  it("has the zoom level and member list position on the desktop app", () => {
    hostDesktopApp();
    const el = buildAppearanceTab(ac.signal);
    container.appendChild(el);
    expect(el.querySelector("h3")).not.toBeNull();
    expect(el.textContent).toContain("Zoom Level");
    expect(el.querySelector("[data-testid='member-layout']")).not.toBeNull();
    expect(el.textContent).toContain("Sync with computer");
    expect(el.textContent).toContain("Ctrl+Shift+Backspace");
  });

  it("leaves out both on Android, and says 'system' and no shortcut", () => {
    hostAndroidApp();
    const el = buildAppearanceTab(ac.signal);
    container.appendChild(el);
    expect(el.textContent).not.toContain("Zoom Level");
    expect(el.querySelector(".slider-row [aria-label='Zoom Level']")).toBeNull();
    expect(el.querySelector("[data-testid='member-layout']")).toBeNull();
    expect(el.textContent).not.toContain("Member list position");
    expect(el.textContent).toContain("Sync with system");
    expect(el.textContent).not.toContain("Sync with computer");
  });

  it("describes custom themes without the shortcut on Android", () => {
    hostDesktopApp();
    expect(buildCustomThemeSection(ac.signal).textContent).toContain("Ctrl+Shift+Backspace");
    hostAndroidApp();
    const section = buildCustomThemeSection(ac.signal);
    expect(section.textContent).not.toContain("Ctrl");
    expect(section.textContent).toContain("Links to outside files");
  });
});

describe("Text & Images", () => {
  it("mentions Ctrl+E and Ctrl+G on the desktop app only", () => {
    hostDesktopApp();
    expect(buildTextImagesTab(ac.signal).textContent).toContain("Ctrl+E");
    expect(buildTextImagesTab(ac.signal).textContent).toContain("Ctrl+G");
    hostAndroidApp();
    const el = buildTextImagesTab(ac.signal);
    expect(el.textContent).not.toContain("Ctrl");
    expect(hasText(el, "Show the emoji button in the chat bar")).toBe(true);
    expect(hasText(el, "Show the GIF button in the chat bar")).toBe(true);
  });
});

describe("Diagnostics & logs", () => {
  const build = (): HTMLElement => createLogsTab(() => "Logs" as TabName, ac.signal).build();
  const openFolder = (el: HTMLElement): Element | null =>
    el.querySelector("[data-testid='open-log-folder']");
  const shareTesting = (el: HTMLElement): Element | null =>
    el.querySelector("[data-testid='share-testing']");

  it("has Open Log Folder and Screen share testing on the desktop app", () => {
    hostDesktopApp();
    const el = build();
    expect(openFolder(el)).not.toBeNull();
    expect(shareTesting(el)).not.toBeNull();
  });

  it("has neither on Android, and still offers the support bundle", () => {
    hostAndroidApp();
    const el = build();
    expect(openFolder(el)).toBeNull();
    expect(shareTesting(el)).toBeNull();
    expect(el.querySelector("[data-testid='export-support-bundle']")).not.toBeNull();
  });
});

describe("About", () => {
  it("says Desktop app on the desktop app and Android app on Android", () => {
    hostDesktopApp();
    expect(buildAboutTab(ac.signal).textContent).toContain("Desktop app");
    hostAndroidApp();
    const el = buildAboutTab(ac.signal);
    expect(el.textContent).toContain("Android app");
    expect(el.textContent).not.toContain("Desktop app");
  });
});
