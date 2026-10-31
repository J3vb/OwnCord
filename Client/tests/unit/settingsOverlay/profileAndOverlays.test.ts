import { describe, it, expect, vi, afterEach } from "vitest";
import * as mocks from "../../helpers/settingsOverlayMocks";
import { createSettingsOverlay } from "../../../src/features/settings/SettingsOverlay";
import { makeOverlayOptions } from "../../helpers/settingsOverlayOptions";
import {
  APP_LIFETIME_MODULES,
  clickEl,
  getTab,
  defaultOptions,
  openOverlay,
  acButton,
  useSettingsOverlayHarness,
} from "../../helpers/settingsOverlayHarness";

vi.mock("../../../src/features/whats-new/appVersion", () => mocks.newAppVersionMock());
vi.mock("@lib/logger", () => mocks.loggerMock());
vi.mock("@stores/ui.store", () => mocks.uiStoreMock());
vi.mock("@lib/voice/livekitSession", () => mocks.voiceLivekitSessionMock());
vi.mock("@stores/auth.store", () => mocks.authStoreMock());

const { mockUiState, uiSubscriptions, mockAuthState } = mocks;

describe("SettingsOverlay", () => {
  let container: HTMLDivElement;
  useSettingsOverlayHarness((el) => {
    container = el;
  });

  // --- Username validation ---

  it("rejects single-character username (min 2)", () => {
    const overlay = openOverlay(container);

    // Click "Edit" to open username edit form
    const editBtn = container.querySelector(".account-field-edit") as HTMLElement;
    editBtn.click();

    // Type a single character
    const editInput = container.querySelector(
      '[data-testid="username-edit-input"]',
    ) as HTMLInputElement;
    editInput.value = "A";

    // Click Save
    const saveBtn = acButton(container, "Save");
    saveBtn.click();

    // Should NOT call onUpdateProfile
    expect(defaultOptions.onUpdateProfile).not.toHaveBeenCalled();

    overlay.destroy?.();
  });

  it("accepts two-character username (min 2)", () => {
    const overlay = openOverlay(container);

    const editBtn = container.querySelector(".account-field-edit") as HTMLElement;
    editBtn.click();

    const editInput = container.querySelector(
      '[data-testid="username-edit-input"]',
    ) as HTMLInputElement;
    editInput.value = "AB";

    const saveBtn = acButton(container, "Save");
    saveBtn.click();

    expect(defaultOptions.onUpdateProfile).toHaveBeenCalledWith({ username: "AB" });

    overlay.destroy?.();
  });

  // OC-0188: renaming the username must not stomp the profile card's
  // header with the raw username when a display name is set — the header
  // is a resolveDisplayName() slot, not a mirror of whichever field was
  // last saved.
  it("keeps the display name in the header after a username rename", async () => {
    mockAuthState.user = {
      id: 1,
      username: "testuser",
      totp_enabled: false,
      display_name: "Alice Smith",
    };

    const overlay = openOverlay(container);

    // Header starts out showing the display name, not the username.
    const acName = container.querySelector(".account-header-name");
    expect(acName?.textContent).toBe("Alice Smith");

    const editBtn = container.querySelector(".account-field-edit") as HTMLElement;
    editBtn.click();

    const editInput = container.querySelector(
      '[data-testid="username-edit-input"]',
    ) as HTMLInputElement;
    editInput.value = "alice2";

    const saveBtn = acButton(container, "Save");
    saveBtn.click();

    await vi.waitFor(() => {
      expect(defaultOptions.onUpdateProfile).toHaveBeenCalledWith({ username: "alice2" });
    });

    // The server merge leaves display_name untouched; the header must keep
    // showing it rather than the raw username that was just saved.
    await vi.waitFor(() => {
      expect(acName?.textContent).toBe("Alice Smith");
    });

    overlay.destroy?.();
  });

  // --- Status selector ---

  // Phase 6 flipped this: "invisible" is a real, settable status now (the
  // server stores it and shows everyone else offline), so the option says what
  // it does instead of borrowing "offline"'s name.
  it("offers Invisible as a status, not Offline", () => {
    const overlay = openOverlay(container);

    const select = container.querySelector<HTMLSelectElement>("[data-testid='status-select']")!;
    const labels = Array.from(select.options).map((o) => o.textContent);
    expect(labels).toContain("Invisible");
    expect(labels).not.toContain("Offline");

    overlay.destroy?.();
  });

  // The status is a native <select> with a <label>: the browser owns its
  // keyboard handling, so the test drives its change event.
  it("status select is labelled and reports the chosen status", () => {
    const overlay = openOverlay(container);

    const select = container.querySelector<HTMLSelectElement>("[data-testid='status-select']")!;
    expect(select.tagName).toBe("SELECT");
    expect(select.labels?.[0]?.textContent).toBe("Show me as");
    select.value = "idle";
    select.dispatchEvent(new Event("change"));
    expect(defaultOptions.onStatusChange).toHaveBeenCalledWith("idle");

    overlay.destroy?.();
  });

  // --- Connect page: Account tab gating ---

  it("hides Account tab when isAuthenticated is false", () => {
    const overlay = createSettingsOverlay({ ...defaultOptions, isAuthenticated: false });
    overlay.mount(container);

    const tabs = container.querySelectorAll(".settings-sidebar > button.settings-nav-item");
    const tabNames = Array.from(tabs).map((t) => t.textContent);
    expect(tabNames).not.toContain("Account");
    // Should start on Appearance instead
    const activeTab = container.querySelector(
      ".settings-sidebar > button.settings-nav-item.active",
    );
    expect(activeTab?.textContent).toBe("Appearance");

    overlay.destroy?.();
  });

  it("hides 'Edit Profile' link when isAuthenticated is false", () => {
    const overlay = createSettingsOverlay({ ...defaultOptions, isAuthenticated: false });
    overlay.mount(container);

    const editLink = container.querySelector(".settings-sidebar-edit") as HTMLElement;
    expect(editLink.style.display).toBe("none");

    overlay.destroy?.();
  });

  it("hides the logout action when isAuthenticated is false", () => {
    const overlay = createSettingsOverlay({ ...defaultOptions, isAuthenticated: false });
    overlay.mount(container);

    expect(container.querySelector(".settings-sidebar-logout")).toBeNull();
    expect(container.querySelector(".settings-nav-item.danger")).toBeNull();

    overlay.destroy?.();
  });

  it("shows Account tab by default (isAuthenticated not set)", () => {
    const overlay = createSettingsOverlay(defaultOptions);
    overlay.mount(container);

    const tabs = container.querySelectorAll(".settings-sidebar > button.settings-nav-item");
    const tabNames = Array.from(tabs).map((t) => t.textContent);
    expect(tabNames).toContain("Account");

    overlay.destroy?.();
  });

  // --- Reopen rebuilds live content ---

  it("rebuilds the active tab when the panel is reopened", () => {
    const overlay = createSettingsOverlay(defaultOptions);
    overlay.mount(container);

    overlay.open();
    const firstPane = container.querySelector(".settings-content .settings-pane");
    expect(firstPane).not.toBeNull();

    // Closing tears down the live parts of the tab (mic meter, camera preview,
    // log listener) — reopening must build a fresh pane, not show the corpse.
    overlay.close();
    overlay.open();

    const secondPane = container.querySelector(".settings-content .settings-pane");
    expect(secondPane).not.toBeNull();
    expect(secondPane).not.toBe(firstPane);
    // Exactly one pane — the old one was replaced, not appended to.
    expect(container.querySelectorAll(".settings-content .settings-pane").length).toBe(1);

    overlay.destroy?.();
  });

  // A hidden pane must not keep its DOM — least of all the Account tab's
  // session rows, which load asynchronously. Retaining the closed pane made the
  // long-session soak's node count depend on whether that fetch had resolved
  // before the tab was closed, so one sample read ~30 nodes fewer than the next
  // (the two session rows), and the nodes bar failed on a first attempt.
  it("drops the Account tab's session rows when the overlay closes", async () => {
    const overlay = createSettingsOverlay({
      ...defaultOptions,
      onListSessions: vi.fn().mockResolvedValue([
        {
          id: 1,
          device: "desktop",
          ip: "127.0.0.1",
          last_used: "2026-01-01T00:00:00Z",
          is_current: true,
        },
        {
          id: 2,
          device: "phone",
          ip: "127.0.0.2",
          last_used: "2026-01-01T00:00:00Z",
          is_current: false,
        },
      ]),
    });
    overlay.mount(container);

    overlay.open();
    await vi.waitFor(() => {
      expect(container.querySelectorAll(".session-row").length).toBe(2);
    });

    overlay.close();
    expect(container.querySelector(".settings-content .settings-pane")).toBeNull();
    expect(container.querySelectorAll(".session-row").length).toBe(0);

    overlay.destroy?.();
  });

  it("re-reads preferences when reopened", () => {
    const overlay = createSettingsOverlay(defaultOptions);
    overlay.mount(container);

    overlay.open();
    const appearanceTab = Array.from(
      container.querySelectorAll(".settings-sidebar > button.settings-nav-item"),
    ).find((b) => b.textContent === "Appearance") as HTMLElement;
    appearanceTab.click();

    let slider = container.querySelector(".settings-slider") as HTMLInputElement;
    expect(slider.value).toBe("16");

    overlay.close();
    localStorage.setItem("owncord:settings:fontSize", JSON.stringify(20));
    overlay.open();

    slider = container.querySelector(".settings-slider") as HTMLInputElement;
    expect(slider.value).toBe("20");

    overlay.destroy?.();
  });

  // --- No fetches while closed (DP-52) ---

  // The Account tab's three REST reads — sessions, TOTP status and recovery-kit
  // status — are wasted work while the overlay is hidden. Mount must not build
  // the tab (which issues them) until the panel is actually open.
  it("does not fetch account data while closed, then fetches once on open", () => {
    const overlay = createSettingsOverlay(defaultOptions);
    overlay.mount(container);

    expect(defaultOptions.onListSessions).not.toHaveBeenCalled();
    expect(defaultOptions.onRefreshTotpStatus).not.toHaveBeenCalled();
    expect(defaultOptions.onGetRecoveryKitStatus).not.toHaveBeenCalled();

    overlay.open();

    expect(defaultOptions.onListSessions).toHaveBeenCalledTimes(1);
    expect(defaultOptions.onRefreshTotpStatus).toHaveBeenCalledTimes(1);
    expect(defaultOptions.onGetRecoveryKitStatus).toHaveBeenCalledTimes(1);

    overlay.destroy?.();
  });

  // --- Listener retention across tab switches (OC-0268) ---
  //
  // Every TAB_BUILDERS entry registers its element listeners on the single
  // overlay-lifetime `ac.signal`. Switching away from a tab detaches its pane
  // via clearChildren() but never aborts that build's listener registrations,
  // so the discarded subtree stays reachable (and live) through the shared
  // AbortController for as long as the overlay itself is mounted.
  it("stops a discarded tab's listeners from firing once the tab is switched away", () => {
    const overlay = openOverlay(container);

    getTab(container, 1).click(); // Appearance
    const fontSlider = container.querySelector(".settings-slider") as HTMLInputElement;
    expect(fontSlider).not.toBeNull();

    getTab(container, 5).click(); // Notifications — discards the Appearance pane
    expect(container.contains(fontSlider)).toBe(false);

    document.documentElement.style.removeProperty("--font-size");
    localStorage.removeItem("owncord:settings:fontSize");

    // The pane is gone from the DOM, but nothing has told its listener to
    // stop — dispatching directly on the detached element still reaches it
    // if the registration was never aborted.
    fontSlider.value = "19";
    fontSlider.dispatchEvent(new Event("input"));

    expect(document.documentElement.style.getPropertyValue("--font-size")).toBe("");
    expect(localStorage.getItem("owncord:settings:fontSize")).toBeNull();

    overlay.destroy?.();
  });

  // --- Cleanup ---

  it("destroy removes root from DOM", () => {
    const overlay = createSettingsOverlay(defaultOptions);
    overlay.mount(container);

    expect(container.querySelector(".settings-overlay")).not.toBeNull();
    overlay.destroy?.();
    expect(container.querySelector(".settings-overlay")).toBeNull();
  });

  // B9-4 (Q2): the Safety tab is a seam. It shows only once a feature passes
  // its builder, and a Q4 notice can open Settings straight onto it.
  describe("Safety tab", () => {
    const safetyBody = (): HTMLDivElement => {
      const el = document.createElement("div");
      el.dataset["testid"] = "inert-safety";
      return el;
    };

    function tabNames(): (string | null)[] {
      return Array.from(
        container.querySelectorAll(".settings-sidebar > button.settings-nav-item[role='tab']"),
      ).map((t) => t.textContent);
    }

    it("is absent until its feature ships", () => {
      const overlay = createSettingsOverlay(defaultOptions);
      overlay.mount(container);
      expect(tabNames()).not.toContain("Safety");
      overlay.destroy?.();
    });

    it("sits under User Settings after Account and renders the feature's tab", () => {
      const signals: AbortSignal[] = [];
      const overlay = createSettingsOverlay({
        ...defaultOptions,
        safetyTab: (signal) => {
          signals.push(signal);
          return safetyBody();
        },
      });
      overlay.mount(container);
      expect(tabNames().slice(0, 3)).toEqual(["Account", "Privacy & Safety", "Appearance"]);

      const tab = container.querySelector<HTMLButtonElement>("#settings-tab-safety")!;
      tab.click();

      expect(tab.getAttribute("aria-selected")).toBe("true");
      expect(container.querySelector(".settings-content h1")?.textContent).toBe("Privacy & Safety");
      expect(container.querySelector("[data-testid='inert-safety']")).not.toBeNull();
      expect(container.querySelector(".settings-content")?.getAttribute("aria-labelledby")).toBe(
        "settings-tab-safety",
      );

      // Leaving the tab aborts the build that owned its listeners.
      getTab(container, 0).click();
      expect(signals.at(-1)?.aborted).toBe(true);
      overlay.destroy?.();
    });

    it("is reachable with the arrow keys like every other tab", () => {
      const overlay = createSettingsOverlay({ ...defaultOptions, safetyTab: safetyBody });
      overlay.mount(container);
      const account = container.querySelector<HTMLButtonElement>("#settings-tab-account")!;
      account.focus();
      account.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
      expect(document.activeElement?.id).toBe("settings-tab-safety");
      overlay.destroy?.();
    });

    it("is not offered on the connect page", () => {
      const overlay = createSettingsOverlay({
        ...defaultOptions,
        isAuthenticated: false,
        safetyTab: safetyBody,
      });
      overlay.mount(container);
      expect(tabNames()).not.toContain("Safety");
      overlay.destroy?.();
    });

    it("opens straight onto Safety when asked", () => {
      mockUiState.settingsOpen = true;
      mockUiState.settingsTab = "Safety";
      const overlay = createSettingsOverlay({ ...defaultOptions, safetyTab: safetyBody });
      overlay.mount(container);
      expect(container.querySelector(".settings-nav-item.active")?.id).toBe("settings-tab-safety");
      expect(container.querySelector("[data-testid='inert-safety']")).not.toBeNull();
      overlay.destroy?.();
    });

    describe("a tab requested while Settings is already open", () => {
      /** Fire the tab-request subscription: the one selecting `settingsTabSeq`. */
      function requestTab(tab: "Notifications" | "Safety"): void {
        mockUiState.settingsTab = tab;
        mockUiState.settingsTabSeq += 1;
        const sub = uiSubscriptions.all.find(
          ({ sel }) => sel({ settingsTabSeq: 7, settingsOpen: false, settingsTab: null }) === 7,
        );
        expect(sub).toBeDefined();
        sub!.listener();
      }
      const active = (): string | null =>
        container.querySelector(".settings-nav-item.active")?.id ?? null;

      it("switches to Notifications", () => {
        mockUiState.settingsOpen = true;
        const overlay = createSettingsOverlay(defaultOptions);
        overlay.mount(container);
        expect(active()).toBe("settings-tab-account");

        requestTab("Notifications");

        expect(active()).toBe("settings-tab-notifications");
        overlay.destroy?.();
      });

      it("switches again when the user has tabbed away since the same request", () => {
        mockUiState.settingsOpen = true;
        const overlay = createSettingsOverlay(defaultOptions);
        overlay.mount(container);
        requestTab("Notifications");
        clickEl(container.querySelector("#settings-tab-appearance"));
        expect(active()).toBe("settings-tab-appearance");

        requestTab("Notifications");

        expect(active()).toBe("settings-tab-notifications");
        overlay.destroy?.();
      });

      it("ignores a request while the panel is closed (show() reads it on open)", () => {
        const overlay = createSettingsOverlay(defaultOptions);
        overlay.mount(container);

        requestTab("Notifications");

        expect(active()).toBe("settings-tab-account");
        overlay.destroy?.();
      });
    });

    it("opens straight onto Notifications when asked", () => {
      mockUiState.settingsOpen = true;
      mockUiState.settingsTab = "Notifications";
      const overlay = createSettingsOverlay(defaultOptions);
      overlay.mount(container);
      expect(container.querySelector(".settings-nav-item.active")?.id).toBe(
        "settings-tab-notifications",
      );
      overlay.destroy?.();
    });

    it("ignores a request for a tab it does not show", () => {
      mockUiState.settingsOpen = true;
      mockUiState.settingsTab = "Safety";
      const overlay = createSettingsOverlay(defaultOptions);
      overlay.mount(container);
      expect(container.querySelector(".settings-nav-item.active")?.textContent).toBe("Account");
      overlay.destroy?.();
    });
  });
});

// ---------------------------------------------------------------------------
// OC-0181: mount() when the store already reports settingsOpen === true
// ---------------------------------------------------------------------------
//
// ConnectPage creates the overlay lazily: it only calls mount() once
// uiStore.settingsOpen is already true (the settings gear flips the store
// first, and only then does ensureSettingsOverlay() run). So on the very
// first open from the connect page, mount() runs its "sync initial state"
// show() call synchronously inside mount() itself — before the caller has
// had a chance to see `root` come back and attach it anywhere.
//
// The module-level mock above pins settingsOpen to a permanent `false`, so
// every other test in this file mounts into a closed overlay and only calls
// open() afterward (root already attached by then). This block re-imports
// the component fresh with settingsOpen already true at mount time, the one
// path that exercises the bug.
describe("SettingsOverlay - mount() with settingsOpen already true", () => {
  afterEach(() => {
    vi.doUnmock("@stores/ui.store");
    for (const [id] of APP_LIFETIME_MODULES) vi.doUnmock(id);
    vi.resetModules();
  });

  it("moves focus into the dialog when the store is already open at mount time", async () => {
    vi.resetModules();
    for (const [id, mod] of APP_LIFETIME_MODULES) vi.doMock(id, () => mod);
    vi.doMock("@stores/ui.store", () => ({
      uiStore: {
        getState: () => ({ settingsOpen: true }),
        subscribe: () => () => {},
        subscribeSelector: vi.fn((_sel: unknown, _listener: unknown) => () => {}),
      },
      setTheme: vi.fn(),
    }));

    const { createSettingsOverlay: createReopenedOverlay } =
      await import("../../../src/features/settings/SettingsOverlay");

    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    expect(document.activeElement).toBe(opener);

    const localContainer = document.createElement("div");
    document.body.appendChild(localContainer);

    const overlay = createReopenedOverlay(makeOverlayOptions());

    overlay.mount(localContainer);

    // The overlay must actually be in the document by the time mount()
    // returns, or nothing below it can matter.
    expect(document.body.contains(localContainer.querySelector(".settings-overlay"))).toBe(true);

    const panel = localContainer.querySelector(".settings-panel") as HTMLElement;
    expect(panel).not.toBeNull();
    // focusDialog() only succeeds once root is attached to the document;
    // called against a detached subtree, .focus() is a silent no-op and
    // activeElement never leaves the opener button.
    expect(panel.contains(document.activeElement)).toBe(true);

    overlay.destroy?.();
    localContainer.remove();
    opener.remove();
  });
});
