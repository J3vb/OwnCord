import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as voiceSession from "../helpers/voiceSessionMock";
import { createSettingsOverlay } from "../../src/features/settings/SettingsOverlay";
import { buildMyUploadsTab } from "../../src/features/uploads/myUploadsTab";

const mockAppVersion = vi.hoisted(() => vi.fn());
vi.mock("../../src/features/whats-new/appVersion", () => ({
  readAppVersion: mockAppVersion,
}));

// Mock logger
vi.mock("@lib/logger", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
  getLogBuffer: () => [],
  clearLogBuffer: vi.fn(),
  addLogListener: () => () => {},
  setLogLevel: vi.fn(),
  getLogLevel: () => "debug",
}));

// Mock stores
const mockSetTheme = vi.fn();
const mockUiState = vi.hoisted(() => ({
  settingsOpen: false,
  settingsTab: null as "Safety" | null,
}));
vi.mock("@stores/ui.store", () => ({
  uiStore: {
    getState: () => mockUiState,
    subscribe: () => () => {},
    subscribeSelector: vi.fn((_sel: unknown, _listener: unknown) => () => {}),
  },
  setTheme: (...args: unknown[]) => mockSetTheme(...args),
}));

vi.mock("@lib/voice/livekitSession", () =>
  voiceSession.withOverrides({
    switchInputDevice: vi.fn().mockResolvedValue(undefined),
    switchOutputDevice: vi.fn().mockResolvedValue(undefined),
  }),
);

// Held in a mutable object (rather than baked into the factory literal) so
// individual tests can simulate the store having a display_name set — e.g.
// to reproduce the header/username desync in OC-0188.
const mockAuthState = vi.hoisted(() => ({
  user: {
    id: 1,
    username: "testuser",
    totp_enabled: false,
    display_name: null as string | null,
  },
}));

vi.mock("@stores/auth.store", () => ({
  authStore: {
    getState: () => mockAuthState,
    subscribeSelector: vi.fn(() => () => {}),
  },
  updateUser: vi.fn(),
}));

import {
  SETTINGS_SEARCH_INDEX,
  highlightMatches,
  clearHighlights,
} from "../../src/features/settings/settingsSearch";
import { settingsText } from "../../src/i18n/settings";
import { whatsNewText } from "../../src/i18n/whatsNew";
import { gameActivityText } from "../../src/i18n/gameActivity";
import { listeningDetailsText } from "../../src/i18n/listeningDetails";
import type { SearchableTab } from "../../src/features/settings/settingsSearch";
import { clearHost, hostAndroidApp, hostDesktopApp } from "../helpers/androidHost";
import { baseOptions } from "../helpers/settingsOverlayOptions";

const options = baseOptions();

const uploadsApi = {
  getUserStorage: vi.fn().mockResolvedValue({ used_bytes: 1, quota_bytes: 0 }),
  listUserUploads: vi.fn().mockResolvedValue({ items: [] }),
  removeUserUpload: vi.fn().mockResolvedValue(undefined),
};

const TAB_SELECTOR = ".settings-sidebar > button.settings-nav-item[role='tab']";

describe("settings search", () => {
  let container: HTMLDivElement;
  let overlay: ReturnType<typeof createSettingsOverlay> | null = null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    localStorage.clear();
    vi.clearAllMocks();
    mockAppVersion.mockResolvedValue("1.2.3-test");
    mockAuthState.user = { id: 1, username: "testuser", totp_enabled: false, display_name: null };
    mockUiState.settingsOpen = true;
    mockUiState.settingsTab = null;
  });

  afterEach(() => {
    overlay?.destroy?.();
    overlay = null;
    container.remove();
  });

  function mountOverlay(extra: Partial<Parameters<typeof createSettingsOverlay>[0]> = {}): void {
    overlay = createSettingsOverlay(options_with(extra));
    overlay.mount(container);
  }
  function options_with(
    extra: Partial<Parameters<typeof createSettingsOverlay>[0]>,
  ): Parameters<typeof createSettingsOverlay>[0] {
    return { ...options, ...extra };
  }

  const box = (): HTMLInputElement =>
    container.querySelector<HTMLInputElement>("[data-testid='settings-search']")!;
  const tabs = (): HTMLButtonElement[] =>
    Array.from(container.querySelectorAll<HTMLButtonElement>(TAB_SELECTOR));
  const visibleNames = (): string[] =>
    tabs()
      .filter((t) => !t.hidden)
      .map((t) => t.textContent ?? "");
  function type(value: string): void {
    box().value = value;
    box().dispatchEvent(new Event("input", { bubbles: true }));
  }
  function press(target: Element | Document, init: KeyboardEventInit): KeyboardEvent {
    const ev = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(ev);
    return ev;
  }

  describe("index", () => {
    // Status, error and empty-state text that is not searchable copy: it
    // changes with state, so it is named here rather than indexed. Anything
    // else shown as a label or description must be in the index.
    const STATE_TEXT = new Set<string>([
      settingsText("notifications.permission.unavailable"),
      settingsText("notifications.blockedReason"),
      settingsText("notifications.muted.empty"),
      settingsText("notifications.channelLevels.empty"),
      settingsText("accessibility.syncOsMotion.asking"),
      settingsText("accessibility.syncOsMotion.notAsking"),
      settingsText("keybinds.pttModeOff"),
      settingsText("voiceAudio.videoCodecIntel"),
      gameActivityText("settings.serverOff"),
      listeningDetailsText("settings.serverOff"),
      whatsNewText("about.updateDescNoVersion"),
      whatsNewText("about.updateDesc", { current: "1.2.3-test" }),
    ]);
    const names = Object.keys(SETTINGS_SEARCH_INDEX) as SearchableTab[];

    // Drift guard. The index is static so no tab has to be rendered to search
    // it; this renders each one and checks both directions: every indexed
    // string is really on screen, and every row label / section heading on
    // screen is indexed (so a new row cannot be added without its text).
    // It runs on the desktop app and on the Android app, which leaves out the
    // Keybinds tab and the rows that only a desktop has.
    describe.each([
      ["desktop app", hostDesktopApp, names.filter((n) => n !== "Safety")],
      ["Android app", hostAndroidApp, names.filter((n) => n !== "Safety" && n !== "Keybinds")],
    ] as const)("on the %s", (_host, setHost, tabNames) => {
      beforeEach(setHost);
      afterEach(clearHost);

      it.each(tabNames)("matches what the %s tab renders", async (name) => {
        mountOverlay(
          name === "My uploads"
            ? {
                myUploadsTab: (signal) =>
                  buildMyUploadsTab(signal, uploadsApi, {
                    formatFileSize: (n: number) => `${n} B`,
                    isImage: (mime: string) => mime.startsWith("image/"),
                    thumbnail: () => Promise.resolve(null),
                  }),
              }
            : {},
        );
        const tab = tabs().find((t) => labelFor(t) === name)!;
        tab.click();
        if (name === "About") {
          await vi.waitFor(() => expect(container.querySelector(".about-tab")).not.toBeNull());
        }
        const pane = container.querySelector<HTMLElement>(".settings-content")!;
        const shown = (pane.textContent ?? "").replace(/\s+/g, " ");
        const indexed = SETTINGS_SEARCH_INDEX[name]();
        expect(indexed.length).toBeGreaterThan(0);
        const missingFromScreen = indexed.filter((text) => !shown.includes(text));
        expect(missingFromScreen).toEqual([]);

        const known = new Set(indexed.map((x) => x.trim()));
        const unindexed = Array.from(
          pane.querySelectorAll(
            ".setting-label, .setting-desc, .settings-section-title, .setting-group-title, .keybind-section-header, .settings-card-head h3",
          ),
        )
          .map((el) => (el.textContent ?? "").trim())
          .filter((text) => text !== "" && !known.has(text) && !STATE_TEXT.has(text));
        expect(unindexed).toEqual([]);
      });
    });

    it("lists no Keybinds tab and no keybind text in the Android app", () => {
      hostAndroidApp();
      try {
        mountOverlay({
          safetyTab: () => document.createElement("div"),
          myUploadsTab: () => document.createElement("div"),
        });
        expect(tabs().map((t) => labelFor(t))).not.toContain("Keybinds");
        expect(SETTINGS_SEARCH_INDEX.Keybinds()).toEqual([]);
        // The rows left out there are not searchable either.
        type("screen share quality");
        expect(visibleNames()).toEqual([]);
        type("flash taskbar");
        expect(visibleNames()).toEqual([]);
        type("launch on login");
        expect(visibleNames()).toEqual([]);
        type("zoom level");
        expect(visibleNames()).toEqual([]);
        type("noise suppression");
        expect(visibleNames()).toEqual(["Voice & Video"]);
      } finally {
        clearHost();
      }
    });

    it("lists every tab the overlay can show", () => {
      mountOverlay({
        safetyTab: () => document.createElement("div"),
        myUploadsTab: () => document.createElement("div"),
      });
      expect(
        tabs()
          .map((t) => labelFor(t))
          .sort(),
      ).toEqual([...names].sort());
    });
  });

  function labelFor(btn: HTMLElement): SearchableTab {
    const byId: Record<string, SearchableTab> = {
      "settings-tab-account": "Account",
      "settings-tab-safety": "Safety",
      "settings-tab-my-uploads": "My uploads",
      "settings-tab-appearance": "Appearance",
      "settings-tab-accessibility": "Accessibility",
      "settings-tab-voice-video": "Voice & Video",
      "settings-tab-text-images": "Text & Images",
      "settings-tab-notifications": "Notifications",
      "settings-tab-keybinds": "Keybinds",
      "settings-tab-advanced": "Advanced",
      "settings-tab-logs": "Logs",
      "settings-tab-about": "About",
    };
    return byId[btn.id]!;
  }

  describe("filter", () => {
    it("has a search box with the placeholder, above the tabs", () => {
      mountOverlay();
      expect(box().placeholder).toBe("Search");
      const sidebar = container.querySelector(".settings-sidebar")!;
      expect(sidebar.firstElementChild?.contains(box())).toBe(true);
    });

    it("hides tabs with no match, case-insensitively, by tab name or row text", () => {
      mountOverlay();
      type("NOISE SUPPRESSION");
      expect(visibleNames()).toEqual(["Voice & Video"]);
      type("zoom");
      expect(visibleNames()).toEqual(["Appearance"]);
      type("diagnostics");
      expect(visibleNames()).toContain("Diagnostics & logs");
    });

    it("hides a category heading with no visible tab and shows No results", () => {
      mountOverlay();
      const cats = (): HTMLElement[] =>
        Array.from(container.querySelectorAll<HTMLElement>(".settings-cat"));
      type("zoom");
      const [user, app] = cats();
      expect(user!.hidden).toBe(true);
      expect(app!.hidden).toBe(false);
      type("qqqq-nothing");
      expect(visibleNames()).toEqual([]);
      expect(cats().every((c) => c.hidden)).toBe(true);
      const empty = container.querySelector<HTMLElement>("[data-testid='settings-search-empty']")!;
      expect(empty.hidden).toBe(false);
      expect(empty.textContent).toBe("No results");
      type("");
      expect(empty.hidden).toBe(true);
      expect(visibleNames()).toHaveLength(10);
      expect(cats().every((c) => !c.hidden)).toBe(true);
    });

    it("searches only the tabs that are shown", () => {
      mountOverlay({ isAuthenticated: false });
      type("password");
      expect(visibleNames()).toEqual([]);
      type("zoom");
      expect(visibleNames()).toEqual(["Appearance"]);
    });

    it("treats surrounding spaces as nothing", () => {
      mountOverlay();
      type("   ");
      expect(visibleNames()).toHaveLength(10);
    });
  });

  describe("highlight", () => {
    it("marks matching labels in the opened tab and clears them with the query", () => {
      mountOverlay();
      type("sound");
      tabs()
        .find((t) => labelFor(t) === "Notifications")!
        .click();
      const marks = Array.from(container.querySelectorAll("mark.settings-search-hit"));
      expect(marks.length).toBeGreaterThan(0);
      expect(marks.every((m) => m.textContent?.toLowerCase() === "sound")).toBe(true);
      expect(marks[0]!.closest(".setting-label, .setting-desc")).not.toBeNull();
      // The label text is intact once the marks are read through.
      expect(
        Array.from(container.querySelectorAll(".setting-label")).some(
          (l) => l.textContent === "Notification Sounds",
        ),
      ).toBe(true);
      type("");
      expect(container.querySelectorAll("mark.settings-search-hit")).toHaveLength(0);
      expect(
        container.querySelector(".settings-content")!.querySelectorAll(".setting-label")[0]!
          .childNodes,
      ).toHaveLength(1);
    });

    it("highlights the already-open tab as the query changes and scrolls to the first hit", () => {
      const scroll = vi.fn();
      const original = Element.prototype.scrollIntoView;
      Element.prototype.scrollIntoView = scroll;
      try {
        mountOverlay();
        tabs()
          .find((t) => labelFor(t) === "Appearance")!
          .click();
        type("zoom");
        expect(container.querySelector("mark.settings-search-hit")).not.toBeNull();
        expect(scroll).toHaveBeenCalledTimes(1);
        expect(scroll.mock.contexts[0]).toBe(container.querySelector("mark.settings-search-hit"));
      } finally {
        Element.prototype.scrollIntoView = original;
      }
    });

    it("leaves elements with child elements alone and splits repeated hits", () => {
      const root = document.createElement("div");
      root.innerHTML =
        '<div class="setting-label">Aa aA</div><div class="setting-desc">x<b>a</b></div>';
      const first = highlightMatches(root, "a");
      expect(root.querySelectorAll("mark")).toHaveLength(4);
      expect(first).toBe(root.querySelector("mark"));
      expect(root.querySelector(".setting-desc")!.querySelector("mark")).toBeNull();
      clearHighlights(root);
      expect(root.querySelector(".setting-label")!.childNodes).toHaveLength(1);
      expect(root.querySelector(".setting-label")!.textContent).toBe("Aa aA");
    });

    it("drops the query when the panel closes", () => {
      mountOverlay();
      type("zoom");
      overlay!.close();
      expect(box().value).toBe("");
      expect(visibleNames()).toHaveLength(10);
    });
  });

  describe("overlay behaviour", () => {
    it("highlights the About tab after it loads asynchronously", async () => {
      mountOverlay();
      type("history");
      tabs()
        .find((t) => labelFor(t) === "About")!
        .click();
      await vi.waitFor(() => expect(container.querySelector(".about-tab")).not.toBeNull());
      const marks = container.querySelectorAll(".about-tab mark.settings-search-hit");
      expect(marks.length).toBeGreaterThan(0);
    });

    it("scrolls to the first visible hit, skipping hidden rows", () => {
      const scroll = vi.fn();
      const original = Element.prototype.scrollIntoView;
      Element.prototype.scrollIntoView = scroll;
      try {
        mountOverlay();
        tabs()
          .find((t) => labelFor(t) === "Appearance")!
          .click();
        type("a");
        const rows = Array.from(container.querySelectorAll("mark.settings-search-hit")).map((m) =>
          m.closest<HTMLElement>(".setting-label, .setting-desc, h3"),
        );
        expect(new Set(rows).size).toBeGreaterThan(1);
        rows[0]!.style.display = "none";
        scroll.mockClear();
        type("a");
        const target = scroll.mock.contexts[0] as HTMLElement;
        expect(scroll).toHaveBeenCalledTimes(1);
        expect(rows[0]!.contains(target)).toBe(false);
      } finally {
        Element.prototype.scrollIntoView = original;
      }
    });

    it("ignores keys that belong to an IME composition", () => {
      mountOverlay();
      type("zoom");
      const during = press(box(), { key: "Escape", isComposing: true });
      expect(during.defaultPrevented).toBe(false);
      expect(box().value).toBe("zoom");
      press(box(), { key: "Process", keyCode: 229 });
      press(box(), { key: "ArrowDown", isComposing: true });
      expect(document.activeElement).not.toBe(tabs().find((t) => !t.hidden));
      expect(options.onClose).not.toHaveBeenCalled();
    });

    it("Edit Profile clears a query that hid Account", () => {
      mountOverlay();
      tabs()
        .find((t) => labelFor(t) === "Appearance")!
        .click();
      type("zoom");
      expect(tabs().find((t) => labelFor(t) === "Account")!.hidden).toBe(true);
      container.querySelector<HTMLElement>(".settings-sidebar-edit")!.click();
      expect(box().value).toBe("");
      const account = tabs().find((t) => labelFor(t) === "Account")!;
      expect(account.hidden).toBe(false);
      expect(account.getAttribute("tabindex")).toBe("0");
      expect(visibleNames()).toHaveLength(10);
    });

    it("a requested tab that the query hid is reachable once settings reopens", () => {
      mountOverlay({ safetyTab: () => document.createElement("div") });
      type("zoom");
      mockUiState.settingsTab = "Safety";
      overlay!.open();
      expect(box().value).toBe("");
      const safety = tabs().find((t) => labelFor(t) === "Safety")!;
      expect(safety.hidden).toBe(false);
      expect(safety.getAttribute("tabindex")).toBe("0");
    });

    it("Down, Up and Enter from an empty box do not switch tabs", () => {
      mountOverlay();
      tabs()
        .find((t) => labelFor(t) === "Appearance")!
        .click();
      const active = (): string => container.querySelector(`${TAB_SELECTOR}.active`)!.textContent!;
      press(box(), { key: "ArrowUp" });
      expect(active()).toBe("Appearance");
      expect(document.activeElement?.textContent).toBe("Appearance");
      box().focus();
      press(box(), { key: "ArrowDown" });
      expect(active()).toBe("Appearance");
      box().focus();
      press(box(), { key: "Enter" });
      expect(document.activeElement).toBe(box());
      expect(active()).toBe("Appearance");
    });
  });

  describe("Escape and clear", () => {
    it("the first Escape clears the box and a second closes the panel", () => {
      mountOverlay();
      type("zoom");
      const first = press(box(), { key: "Escape" });
      expect(first.defaultPrevented).toBe(true);
      expect(box().value).toBe("");
      expect(visibleNames()).toHaveLength(10);
      expect(options.onClose).not.toHaveBeenCalled();
      press(box(), { key: "Escape" });
      expect(options.onClose).toHaveBeenCalledTimes(1);
    });

    it("the clear button shows only with text and empties the box", () => {
      mountOverlay();
      const clear = container.querySelector<HTMLButtonElement>(
        "[data-testid='settings-search-clear']",
      )!;
      expect(clear.hidden).toBe(true);
      type("zoom");
      expect(clear.hidden).toBe(false);
      clear.click();
      expect(box().value).toBe("");
      expect(clear.hidden).toBe(true);
      expect(document.activeElement).toBe(box());
    });
  });

  describe("keyboard", () => {
    it("Down and Up from the box land on the first and last visible tab", () => {
      mountOverlay();
      type("sound");
      const shown = visibleNames();
      expect(shown.length).toBeGreaterThan(1);
      press(box(), { key: "ArrowDown" });
      const active = (): string => container.querySelector(`${TAB_SELECTOR}.active`)!.textContent!;
      expect(active()).toBe(shown[0]);
      expect(document.activeElement?.textContent).toBe(shown[0]);
      box().focus();
      press(box(), { key: "ArrowUp" });
      expect(active()).toBe(shown[shown.length - 1]);
    });

    it("tablist arrows skip hidden tabs and wrap among the visible ones", () => {
      mountOverlay();
      type("sound");
      const shown = visibleNames();
      const buttons = tabs().filter((t) => !t.hidden);
      buttons[0]!.focus();
      buttons[0]!.click();
      press(buttons[0]!, { key: "ArrowDown" });
      expect(document.activeElement).toBe(buttons[1]);
      press(buttons[1]!, { key: "ArrowUp" });
      press(buttons[0]!, { key: "ArrowUp" });
      expect(document.activeElement?.textContent).toBe(shown[shown.length - 1]);
      press(document.activeElement!, { key: "Home" });
      expect(document.activeElement?.textContent).toBe(shown[0]);
      press(document.activeElement!, { key: "End" });
      expect(document.activeElement?.textContent).toBe(shown[shown.length - 1]);
    });

    it("keeps a visible tab in the Tab order when the open one is filtered out", () => {
      mountOverlay();
      type("zoom");
      const stops = tabs().filter((t) => t.getAttribute("tabindex") === "0");
      expect(stops).toHaveLength(1);
      expect(stops[0]!.hidden).toBe(false);
    });

    it("Ctrl+F focuses the box while the panel is open", () => {
      mountOverlay();
      const ev = press(document.body, { key: "f", ctrlKey: true });
      expect(ev.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(box());
    });

    it("Ctrl+F does nothing while the panel is closed", () => {
      mockUiState.settingsOpen = false;
      mountOverlay();
      const ev = press(document.body, { key: "f", ctrlKey: true });
      expect(ev.defaultPrevented).toBe(false);
    });
  });
});
