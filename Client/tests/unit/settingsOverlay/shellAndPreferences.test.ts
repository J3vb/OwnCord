import { describe, it, expect, vi, afterEach } from "vitest";
import * as mocks from "../../helpers/settingsOverlayMocks";
import { createSettingsOverlay } from "../../../src/features/settings/SettingsOverlay";
import { setAvailableUpdate } from "../../../src/features/updates/availableUpdate";
import {
  clickEl,
  getTab,
  defaultOptions,
  useSettingsOverlayHarness,
} from "../../helpers/settingsOverlayHarness";
import { clearHost, hostAndroidApp, hostDesktopApp } from "../../helpers/androidHost";

vi.mock("../../../src/features/whats-new/appVersion", () => mocks.newAppVersionMock());
vi.mock("@lib/logger", () => mocks.loggerMock());
vi.mock("@stores/ui.store", () => mocks.uiStoreMock());
vi.mock("@lib/voice/livekitSession", () => mocks.voiceLivekitSessionMock());
vi.mock("@stores/auth.store", () => mocks.authStoreMock());

const { mockUiState, mockAuthState } = mocks;

describe("SettingsOverlay", () => {
  let container: HTMLDivElement;
  useSettingsOverlayHarness((el) => {
    container = el;
  });

  it("marks the About tab while a newer version is on offer", () => {
    const overlay = createSettingsOverlay(defaultOptions);
    overlay.mount(container);
    const about = container.querySelector("#settings-tab-about")!;
    expect(about.querySelector(".settings-nav-dot")).toBeNull();
    setAvailableUpdate({ version: "9.9.9", body: "", serverUrl: "https://s.example" });
    expect(about.querySelector(".settings-nav-dot")?.textContent).toBe("Update available");
    setAvailableUpdate(null);
    expect(about.querySelector(".settings-nav-dot")).toBeNull();
    overlay.destroy?.();
  });

  it("mounts with all tabs", () => {
    const overlay = createSettingsOverlay(defaultOptions);
    overlay.mount(container);

    const tabs = container.querySelectorAll(".settings-sidebar > button.settings-nav-item");
    const tabNames = Array.from(tabs).map((t) => t.textContent);
    expect(tabNames).toEqual([
      "Account",
      "Appearance",
      "Accessibility",
      "Voice & Video",
      "Text & Images",
      "Notifications",
      "Keybinds",
      "Advanced",
      "Diagnostics & logs",
      "About",
    ]);

    overlay.destroy?.();
  });

  it("rebuilds the sidebar avatar when the signed-in user's profile changes", async () => {
    const { authStore } = await import("@stores/auth.store");
    const overlay = createSettingsOverlay(defaultOptions);
    overlay.mount(container);
    expect(container.querySelector(".settings-sidebar-avatar .avatar-initial")?.textContent).toBe(
      "T",
    );

    const marker = {};
    const call = vi
      .mocked(authStore.subscribeSelector)
      .mock.calls.find(
        ([select]) => (select as (s: unknown) => unknown)({ user: marker }) === marker,
      );
    expect(call).toBeDefined();
    (call![1] as (u: unknown) => void)({ ...mockAuthState.user, display_name: "Zed" });

    expect(container.querySelectorAll(".settings-sidebar-avatar")).toHaveLength(1);
    expect(container.querySelector(".settings-sidebar-avatar .avatar-initial")?.textContent).toBe(
      "Z",
    );
    expect(container.querySelector(".settings-sidebar-name")?.textContent).toBe("testuser");

    overlay.destroy?.();
  });

  it("starts on Account tab", () => {
    const overlay = createSettingsOverlay(defaultOptions);
    overlay.mount(container);

    const activeTab = container.querySelector(
      ".settings-sidebar > button.settings-nav-item.active",
    );
    expect(activeTab?.textContent).toBe("Account");

    overlay.destroy?.();
  });

  it("switches tabs on click", () => {
    const overlay = createSettingsOverlay(defaultOptions);
    overlay.mount(container);

    const appearanceTab = getTab(container, 1);
    appearanceTab.click();

    expect(appearanceTab.classList.contains("active")).toBe(true);
    const prevActive = getTab(container, 0);
    expect(prevActive.classList.contains("active")).toBe(false);

    overlay.destroy?.();
  });

  describe("on a phone, where the section list and a section take turns", () => {
    function stubPhone(matches: boolean): void {
      vi.stubGlobal(
        "matchMedia",
        vi.fn((query: string) => ({ matches, media: query }) as unknown as MediaQueryList),
      );
    }
    const panelOf = (c: HTMLElement): HTMLElement => c.querySelector(".settings-panel")!;
    const escape = (): boolean =>
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("opens on the list, and a tapped tab opens its section", () => {
      stubPhone(true);
      const overlay = createSettingsOverlay(defaultOptions);
      overlay.mount(container);
      overlay.open();
      expect(panelOf(container).classList.contains("settings-panel--section")).toBe(false);

      getTab(container, 1).click();
      expect(panelOf(container).classList.contains("settings-panel--section")).toBe(true);
      expect(container.querySelector(".settings-content h1")?.textContent).toBe("Appearance");

      overlay.destroy?.();
    });

    it("is laid out as pages on a phone turned sideways, past the 600 px width", () => {
      vi.stubGlobal(
        "matchMedia",
        vi.fn(
          (query: string) => ({ matches: query.includes("pointer: coarse") }) as MediaQueryList,
        ),
      );
      const overlay = createSettingsOverlay(defaultOptions);
      overlay.mount(container);
      overlay.open();
      getTab(container, 1).click();
      expect(panelOf(container).classList.contains("settings-panel--section")).toBe(true);
      expect(document.activeElement).toBe(container.querySelector("[data-testid='settings-back']"));
      overlay.destroy?.();
    });

    it("Back returns to the list with focus on the section it left, without closing", () => {
      stubPhone(true);
      const overlay = createSettingsOverlay(defaultOptions);
      overlay.mount(container);
      overlay.open();
      const appearance = getTab(container, 1);
      appearance.click();

      clickEl(container.querySelector("[data-testid='settings-back']"));
      expect(panelOf(container).classList.contains("settings-panel--section")).toBe(false);
      expect(document.activeElement).toBe(appearance);
      expect(defaultOptions.onClose).not.toHaveBeenCalled();

      overlay.destroy?.();
    });

    it("Escape leaves the open section first, then closes Settings", () => {
      stubPhone(true);
      const overlay = createSettingsOverlay(defaultOptions);
      overlay.mount(container);
      overlay.open();
      getTab(container, 1).click();

      escape();
      expect(panelOf(container).classList.contains("settings-panel--section")).toBe(false);
      expect(defaultOptions.onClose).not.toHaveBeenCalled();
      escape();
      expect(defaultOptions.onClose).toHaveBeenCalledTimes(1);

      overlay.destroy?.();
    });

    it("Enter in search opens the picked section with focus on Back, and nothing on no match", () => {
      stubPhone(true);
      const overlay = createSettingsOverlay(defaultOptions);
      overlay.mount(container);
      overlay.open();
      const box = container.querySelector<HTMLInputElement>("[data-testid='settings-search']")!;
      const enter = (): boolean =>
        box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

      box.value = "zzzz";
      box.dispatchEvent(new Event("input"));
      enter();
      expect(panelOf(container).classList.contains("settings-panel--section")).toBe(false);

      box.value = "appearance";
      box.dispatchEvent(new Event("input"));
      enter();
      expect(panelOf(container).classList.contains("settings-panel--section")).toBe(true);
      expect(container.querySelector(".settings-content h1")?.textContent).toBe("Appearance");
      expect(document.activeElement).toBe(container.querySelector("[data-testid='settings-back']"));

      overlay.destroy?.();
    });

    it("reopening starts on the list again", () => {
      stubPhone(true);
      const overlay = createSettingsOverlay(defaultOptions);
      overlay.mount(container);
      overlay.open();
      getTab(container, 1).click();
      overlay.close();
      overlay.open();
      expect(panelOf(container).classList.contains("settings-panel--section")).toBe(false);

      overlay.destroy?.();
    });

    it("a tab another surface asks for opens straight on its section", () => {
      stubPhone(true);
      mockUiState.settingsTab = "Notifications";
      const overlay = createSettingsOverlay(defaultOptions);
      overlay.mount(container);
      overlay.open();
      expect(panelOf(container).classList.contains("settings-panel--section")).toBe(true);
      expect(container.querySelector(".settings-content h1")?.textContent).toBe("Notifications");

      overlay.destroy?.();
    });

    it("a tapped My uploads opens its section, as every other tab does", () => {
      stubPhone(true);
      const overlay = createSettingsOverlay({
        ...defaultOptions,
        myUploadsTab: () => {
          const pane = document.createElement("div");
          pane.textContent = "uploads pane";
          return pane;
        },
      });
      overlay.mount(container);
      overlay.open();
      expect(panelOf(container).classList.contains("settings-panel--section")).toBe(false);

      container.querySelector<HTMLElement>("#settings-tab-my-uploads")!.click();
      expect(panelOf(container).classList.contains("settings-panel--section")).toBe(true);
      expect(container.querySelector(".settings-content h1")?.textContent).toBe("My uploads");
      expect(container.querySelector(".settings-content")?.textContent).toContain("uploads pane");
      expect(document.activeElement).toBe(container.querySelector("[data-testid='settings-back']"));

      overlay.destroy?.();
    });

    it("on a wide window Escape still closes Settings with a section picked", () => {
      stubPhone(false);
      const overlay = createSettingsOverlay(defaultOptions);
      overlay.mount(container);
      overlay.open();
      getTab(container, 1).click();

      escape();
      expect(defaultOptions.onClose).toHaveBeenCalledTimes(1);

      overlay.destroy?.();
    });
  });

  describe("the Keybinds tab", () => {
    const navNames = (): string[] =>
      [...container.querySelectorAll(".settings-sidebar > button.settings-nav-item")].map(
        (t) => t.textContent ?? "",
      );
    const searchFor = (text: string): void => {
      const box = container.querySelector<HTMLInputElement>("[data-testid='settings-search']")!;
      box.value = text;
      box.dispatchEvent(new Event("input"));
    };
    const visibleNav = (): string[] =>
      [...container.querySelectorAll<HTMLElement>(".settings-sidebar > button.settings-nav-item")]
        .filter((t) => !t.hidden)
        .map((t) => t.textContent ?? "");

    afterEach(() => {
      clearHost();
    });

    it("is in the desktop app, and found by a search for a key", () => {
      hostDesktopApp();
      const overlay = createSettingsOverlay(defaultOptions);
      overlay.mount(container);
      expect(navNames()).toContain("Keybinds");
      searchFor("push to talk");
      expect(visibleNav()).toContain("Keybinds");
      overlay.destroy?.();
    });

    it("is not in the Android app, and a search never offers it", () => {
      hostAndroidApp();
      const overlay = createSettingsOverlay(defaultOptions);
      overlay.mount(container);
      expect(navNames()).not.toContain("Keybinds");
      expect(navNames()).toHaveLength(9);
      // Push to Talk there is the talk button, chosen under Voice & Video.
      searchFor("push to talk");
      expect(visibleNav()).toEqual(["Voice & Video"]);
      searchFor("shortcut");
      expect(visibleNav()).not.toContain("Keybinds");
      overlay.destroy?.();
    });

    it("is ignored when another surface asks for it on Android", () => {
      hostAndroidApp();
      mockUiState.settingsTab = "Keybinds";
      const overlay = createSettingsOverlay(defaultOptions);
      overlay.mount(container);
      overlay.open();
      expect(container.querySelector(".settings-nav-item.active")?.textContent).not.toBe(
        "Keybinds",
      );
      expect(container.querySelector(".settings-content h1")?.textContent).not.toBe("Keybinds");
      overlay.destroy?.();
    });
  });

  describe("while a one-time recovery secret request is in flight", () => {
    function deferred<T>(): { promise: Promise<T>; resolve(v: T): void } {
      let resolve!: (v: T) => void;
      const promise = new Promise<T>((r) => {
        resolve = r;
      });
      return { promise, resolve };
    }
    const byId = (id: string): HTMLElement =>
      container.querySelector<HTMLElement>(`[data-testid='${id}']`)!;
    function submit(prefix: string): void {
      byId(`${prefix}-btn`).click();
      (byId(`${prefix}-password`) as HTMLInputElement).value = "pw";
      byId(`${prefix}-submit`).click();
    }
    function tryToLeave(): void {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      clickEl(container.querySelector(".settings-close-btn"));
      clickEl(container.querySelector(".settings-overlay"));
      getTab(container, 1).click();
    }

    it.each([
      [
        "recovery kit enrolment",
        "recovery-kit",
        "onEnrolRecoveryKit",
        { kit_secret: "KIT-SECRET" },
      ],
      ["recovery code regeneration", "totp-regenerate", "onRegenerateRecoveryCodes", ["CODE-ONE"]],
    ])("stays open on %s until the secret is shown", async (_n, prefix, method, result) => {
      mockAuthState.user = { ...mockAuthState.user, totp_enabled: true };
      mockUiState.settingsOpen = true;
      const pending = deferred<unknown>();
      const overlay = createSettingsOverlay({
        ...defaultOptions,
        [method]: vi.fn().mockReturnValue(pending.promise),
      });
      overlay.mount(container);
      submit(prefix);

      tryToLeave();
      const accountTab = getTab(container, 0);
      accountTab.focus();
      accountTab.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
      expect(document.activeElement).toBe(accountTab);
      expect(defaultOptions.onClose).not.toHaveBeenCalled();
      expect(getTab(container, 0).classList.contains("active")).toBe(true);

      pending.resolve(result);
      await vi.waitFor(() => expect(container.textContent).toMatch(/KIT-SECRET|CODE-ONE/));

      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      expect(defaultOptions.onClose).toHaveBeenCalled();
      overlay.destroy?.();
    });
  });

  it("renders close button that calls onClose", () => {
    const overlay = createSettingsOverlay(defaultOptions);
    overlay.mount(container);

    clickEl(container.querySelector(".settings-close-btn"));
    expect(defaultOptions.onClose).toHaveBeenCalled();

    overlay.destroy?.();
  });

  it("closes on Escape key", () => {
    const overlay = createSettingsOverlay(defaultOptions);
    overlay.mount(container);
    overlay.open();

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(defaultOptions.onClose).toHaveBeenCalled();

    overlay.destroy?.();
  });

  it("stays open when a drag-select ends on the backdrop, and a backdrop click still closes", () => {
    const overlay = createSettingsOverlay(defaultOptions);
    overlay.mount(container);
    overlay.open();
    defaultOptions.onClose.mockClear();
    const root = container.querySelector<HTMLElement>(".settings-overlay")!;
    root
      .querySelector(".settings-panel")!
      .dispatchEvent(new Event("pointerdown", { bubbles: true }));
    root.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(defaultOptions.onClose).not.toHaveBeenCalled();
    root.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    root.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(defaultOptions.onClose).toHaveBeenCalledOnce();

    overlay.destroy?.();
  });

  // --- Appearance tab tests ---

  it("applies theme on click", () => {
    const overlay = createSettingsOverlay(defaultOptions);
    overlay.mount(container);

    getTab(container, 1).click();

    const themeOptions = container.querySelectorAll(".theme-opt");
    // Four palettes plus Sync with computer.
    expect(themeOptions.length).toBe(5);

    const midnight = themeOptions[2] as HTMLElement;
    midnight.click();

    expect(midnight.classList.contains("active")).toBe(true);
    expect(document.documentElement.style.getPropertyValue("--bg-primary")).toBe("#1a1a2e");
    // Theme persists only via themes.ts (owncord:theme:active), not via savePref
    expect(localStorage.getItem("owncord:theme:active")).toBe("midnight");
    expect(localStorage.getItem("owncord:settings:theme")).toBeNull();

    overlay.destroy?.();
  });

  it("persists and restores font size", () => {
    localStorage.setItem("owncord:settings:fontSize", "18");

    const overlay = createSettingsOverlay(defaultOptions);
    overlay.mount(container);
    getTab(container, 1).click();

    const slider = container.querySelector(".settings-slider") as HTMLInputElement;
    expect(slider.value).toBe("18");
    expect(document.documentElement.style.getPropertyValue("--font-size")).toBe("18px");

    overlay.destroy?.();
  });

  it("changes font size via slider", () => {
    const overlay = createSettingsOverlay(defaultOptions);
    overlay.mount(container);
    getTab(container, 1).click();

    const slider = container.querySelector(".settings-slider") as HTMLInputElement;
    slider.value = "14";
    slider.dispatchEvent(new Event("input"));

    expect(document.documentElement.style.getPropertyValue("--font-size")).toBe("14px");
    expect(localStorage.getItem("owncord:settings:fontSize")).toBe("14");

    overlay.destroy?.();
  });

  it("toggles compact mode", () => {
    const overlay = createSettingsOverlay(defaultOptions);
    overlay.mount(container);
    getTab(container, 1).click();

    const toggle = container.querySelector(".toggle") as HTMLElement;
    expect(toggle).not.toBeNull();
    toggle.click();

    expect(toggle.classList.contains("on")).toBe(true);
    expect(document.documentElement.classList.contains("compact-mode")).toBe(true);
    expect(localStorage.getItem("owncord:settings:compactMode")).toBe("true");

    overlay.destroy?.();
  });

  // --- Notifications tab tests ---

  it("renders notification toggles", () => {
    const overlay = createSettingsOverlay(defaultOptions);
    overlay.mount(container);
    getTab(container, 5).click();

    // Desktop, flash, @everyone, the unread badge, message sounds, the call sound (D2) and the
    // voice UI sounds (DP-40), plus the seven per-sound switches (WP M-8).
    const toggles = container.querySelectorAll(".toggle");
    expect(toggles.length).toBe(14);

    overlay.destroy?.();
  });

  it("persists notification toggle state", () => {
    const overlay = createSettingsOverlay(defaultOptions);
    overlay.mount(container);
    getTab(container, 5).click();

    const toggles = container.querySelectorAll(".toggle");
    const suppressToggle = toggles[2] as HTMLElement;
    suppressToggle.click();

    expect(suppressToggle.classList.contains("on")).toBe(true);
    expect(localStorage.getItem("owncord:settings:suppressEveryone")).toBe("true");

    overlay.destroy?.();
  });

  // --- Voice & Video tab tests ---

  it("renders Voice & Video tab with device selectors", () => {
    const overlay = createSettingsOverlay(defaultOptions);
    overlay.mount(container);
    getTab(container, 3).click();

    const selects = container.querySelectorAll("select.form-input");
    // input device, output device, camera quality, screen share quality,
    // screen share fps, video codec, video device = 7
    expect(selects.length).toBe(7);

    const sliders = container.querySelectorAll(".settings-slider");
    expect(sliders.length).toBeGreaterThanOrEqual(1);

    const toggles = container.querySelectorAll(".toggle");
    // 6 toggles: automatic input sensitivity, automatically play cameras,
    // echo cancellation, noise suppression, auto gain control, enhanced noise
    // suppression (RNNoise)
    expect(toggles.length).toBe(6);

    overlay.destroy?.();
  });

  it("renders voice sensitivity meter bar", () => {
    const overlay = createSettingsOverlay(defaultOptions);
    overlay.mount(container);
    getTab(container, 3).click();

    // Sensitivity is now a draggable meter bar, not a slider.
    const meterBar = container.querySelector(".mic-meter-bar") as HTMLElement;
    expect(meterBar).not.toBeNull();
    const threshold = container.querySelector(".mic-meter-threshold") as HTMLElement;
    expect(threshold).not.toBeNull();

    overlay.destroy?.();
  });

  it("persists audio device selection on change", () => {
    const overlay = createSettingsOverlay(defaultOptions);
    overlay.mount(container);
    getTab(container, 3).click();

    const selects = container.querySelectorAll("select.form-input");
    const inputSelect = selects[0] as HTMLSelectElement;
    inputSelect.dispatchEvent(new Event("change"));

    expect(localStorage.getItem("owncord:settings:audioInputDevice")).toBe('""');

    overlay.destroy?.();
  });

  it("toggles echo cancellation", () => {
    const overlay = createSettingsOverlay(defaultOptions);
    overlay.mount(container);
    getTab(container, 3).click();

    const echoToggle = container.querySelector(
      ".toggle[aria-label='Echo Cancellation']",
    ) as HTMLElement;

    // Default is on
    expect(echoToggle.classList.contains("on")).toBe(true);
    echoToggle.click();
    expect(echoToggle.classList.contains("on")).toBe(false);
    expect(localStorage.getItem("owncord:settings:echoCancellation")).toBe("false");

    overlay.destroy?.();
  });

  // --- Open/Close ---

  it("open() adds .open class, close() removes it", () => {
    const overlay = createSettingsOverlay(defaultOptions);
    overlay.mount(container);

    const root = container.querySelector(".settings-overlay");
    expect(root?.classList.contains("open")).toBe(false);

    overlay.open();
    expect(root?.classList.contains("open")).toBe(true);

    overlay.close();
    expect(root?.classList.contains("open")).toBe(false);

    overlay.destroy?.();
  });

  // --- Dialog & tablist semantics (DC-13) ---

  it("stamps dialog semantics on the settings panel", () => {
    const overlay = createSettingsOverlay(defaultOptions);
    overlay.mount(container);

    const panel = container.querySelector(".settings-panel") as HTMLElement;
    expect(panel.getAttribute("role")).toBe("dialog");
    expect(panel.getAttribute("aria-modal")).toBe("true");
    expect(panel.getAttribute("aria-label")).toBe("Settings");

    overlay.destroy?.();
  });

  it("marks the sidebar as a vertical tablist", () => {
    const overlay = createSettingsOverlay(defaultOptions);
    overlay.mount(container);

    const sidebar = container.querySelector(".settings-sidebar") as HTMLElement;
    expect(sidebar.getAttribute("role")).toBe("tablist");
    expect(sidebar.getAttribute("aria-orientation")).toBe("vertical");
    expect(sidebar.getAttribute("aria-label")).toBe("Settings sections");

    overlay.destroy?.();
  });

  it("moves the roving tabindex to the tab activated by setActiveTab", () => {
    const overlay = createSettingsOverlay(defaultOptions);
    overlay.mount(container);

    const accountTab = getTab(container, 0);
    const appearanceTab = getTab(container, 1);
    expect(accountTab.getAttribute("tabindex")).toBe("0");
    expect(appearanceTab.getAttribute("tabindex")).toBe("-1");

    appearanceTab.click();

    expect(accountTab.getAttribute("tabindex")).toBe("-1");
    expect(appearanceTab.getAttribute("tabindex")).toBe("0");

    overlay.destroy?.();
  });

  it("ArrowDown moves focus and activation to the next tab", () => {
    const overlay = createSettingsOverlay(defaultOptions);
    overlay.mount(container);

    const accountTab = getTab(container, 0);
    const appearanceTab = getTab(container, 1);
    accountTab.focus();
    accountTab.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));

    expect(document.activeElement).toBe(appearanceTab);
    expect(appearanceTab.classList.contains("active")).toBe(true);
    expect(appearanceTab.getAttribute("aria-selected")).toBe("true");
    expect(accountTab.classList.contains("active")).toBe(false);

    overlay.destroy?.();
  });

  it("labels the content tabpanel with the active tab", () => {
    const overlay = createSettingsOverlay(defaultOptions);
    overlay.mount(container);

    const content = container.querySelector(".settings-content") as HTMLElement;
    expect(content.getAttribute("role")).toBe("tabpanel");
    expect(getTab(container, 0).id).toBe("settings-tab-account");
    expect(content.getAttribute("aria-labelledby")).toBe("settings-tab-account");

    // "Text & Images" — the slugged id drops the ampersand
    getTab(container, 4).click();
    expect(content.getAttribute("aria-labelledby")).toBe("settings-tab-text-images");

    overlay.destroy?.();
  });

  it("restores focus to the opener when the overlay closes", () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();

    const overlay = createSettingsOverlay(defaultOptions);
    overlay.mount(container);
    overlay.open();

    const panel = container.querySelector(".settings-panel") as HTMLElement;
    expect(panel.contains(document.activeElement)).toBe(true);

    overlay.close();
    expect(document.activeElement).toBe(opener);

    overlay.destroy?.();
    opener.remove();
  });
});
