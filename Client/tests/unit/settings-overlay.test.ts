import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createSettingsOverlay } from "@components/SettingsOverlay";
import { ApiClientError } from "../../src/lib/api";
// The modules in SettingsOverlay's graph that install an app-lifetime window
// listener at load. The re-import below reuses these instances, so the
// vi.resetModules() does not install a second copy of each listener.
import * as attachments from "@components/message-list/attachments";
import * as formatting from "@lib/text/formatting";
import * as media from "@components/message-list/media";
import * as channelMutes from "@lib/prefs/channelMutes";
import { setAvailableUpdate } from "../../src/features/updates/availableUpdate";

const APP_LIFETIME_MODULES = [
  ["@components/message-list/attachments", attachments],
  ["@lib/text/formatting", formatting],
  ["@components/message-list/media", media],
  ["@lib/prefs/channelMutes", channelMutes],
] as const;

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
}));

// Mock stores
const mockSetTheme = vi.fn();
const mockUiState = vi.hoisted(() => ({
  settingsOpen: false,
  settingsTab: null as "Safety" | "Notifications" | null,
  settingsTabSeq: 0,
}));
const uiSubscriptions = vi.hoisted(() => ({
  all: [] as Array<{ sel: (s: Record<string, unknown>) => unknown; listener: () => void }>,
}));
vi.mock("@stores/ui.store", () => ({
  uiStore: {
    getState: () => mockUiState,
    subscribe: () => () => {},
    subscribeSelector: vi.fn(
      (sel: (s: Record<string, unknown>) => unknown, listener: () => void) => {
        uiSubscriptions.all.push({ sel, listener });
        return () => {};
      },
    ),
  },
  setTheme: (...args: unknown[]) => mockSetTheme(...args),
}));

vi.mock("@lib/voice/livekitSession", () => ({
  switchInputDevice: vi.fn().mockResolvedValue(undefined),
  switchOutputDevice: vi.fn().mockResolvedValue(undefined),
  setVoiceSensitivity: vi.fn(),
  setInputVolume: vi.fn(),
  setOutputVolume: vi.fn(),
  reapplyAudioProcessing: vi.fn().mockResolvedValue(undefined),
  getSessionDebugInfo: vi.fn().mockReturnValue({}),
}));

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

function clickEl(el: Element | null): void {
  expect(el).not.toBeNull();
  (el as HTMLElement).click();
}

function getTab(container: HTMLDivElement, index: number): HTMLElement {
  const tabs = container.querySelectorAll(".settings-sidebar > button.settings-nav-item");
  const tab = tabs[index];
  expect(tab).toBeDefined();
  return tab as HTMLElement;
}

describe("SettingsOverlay", () => {
  let container: HTMLDivElement;

  const defaultOptions = {
    onClose: vi.fn(),
    onChangePassword: vi.fn().mockResolvedValue(undefined),
    onUpdateProfile: vi.fn().mockResolvedValue(undefined),
    onUploadAvatar: vi.fn().mockResolvedValue("/api/v1/files/test"),
    onRemoveAvatar: vi.fn().mockResolvedValue(undefined),
    onLogout: vi.fn(),
    onDeleteAccount: vi.fn().mockResolvedValue(undefined),
    onStatusChange: vi.fn(),
    onEnableTotp: vi.fn().mockResolvedValue({ qr_uri: "otpauth://test", backup_codes: [] }),
    onConfirmTotp: vi.fn().mockResolvedValue(undefined),
    onDisableTotp: vi.fn().mockResolvedValue(undefined),
    onRefreshTotpStatus: vi.fn().mockResolvedValue(undefined),
    onRegenerateRecoveryCodes: vi.fn().mockResolvedValue([]),
    onEnrolRecoveryKit: vi.fn().mockResolvedValue({ created_at: "" }),
    onGetRecoveryKitStatus: vi.fn().mockResolvedValue({ enrolled: false, used_at: null }),
    onListSessions: vi.fn().mockResolvedValue([]),
    onRevokeSession: vi.fn().mockResolvedValue(undefined),
    onRevokeAllSessions: vi
      .fn()
      .mockResolvedValue({ sessions_revoked: 0, current_session_revoked: false }),
  };

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    localStorage.clear();
    vi.clearAllMocks();
    mockAppVersion.mockResolvedValue("1.2.3-test");
    mockAuthState.user = { id: 1, username: "testuser", totp_enabled: false, display_name: null };
    mockUiState.settingsOpen = false;
    mockUiState.settingsTab = null;
    mockUiState.settingsTabSeq = 0;
    uiSubscriptions.all.length = 0;
  });

  afterEach(() => {
    container.remove();
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

  // --- Account tab tests ---

  it("shows current username", () => {
    const overlay = createSettingsOverlay(defaultOptions);
    overlay.mount(container);
    overlay.open();

    const acName = container.querySelector(".account-header-name");
    expect(acName?.textContent).toBe("testuser");

    overlay.destroy?.();
  });

  it("asks before logging out: one click only opens the prompt, confirming logs out", () => {
    const overlay = createSettingsOverlay(defaultOptions);
    overlay.mount(container);

    clickEl(container.querySelector(".settings-nav-item.danger"));
    expect(defaultOptions.onLogout).not.toHaveBeenCalled();
    const dialog = document.querySelector("[data-testid='logout-confirm-dialog']");
    expect(dialog?.textContent).toContain("Are you sure you want to log out?");

    clickEl(document.querySelector("[data-testid='logout-confirm']"));
    expect(defaultOptions.onLogout).toHaveBeenCalledTimes(1);
    expect(document.querySelector("[data-testid='logout-confirm-dialog']")).toBeNull();

    overlay.destroy?.();
  });

  it("mounts the Log Out prompt inside the settings overlay so it stacks above it", () => {
    const overlay = createSettingsOverlay(defaultOptions);
    overlay.mount(container);
    overlay.open();

    clickEl(container.querySelector(".settings-nav-item.danger"));
    const dialog = document.querySelector("[data-testid='logout-confirm-dialog']");
    expect(dialog?.closest(".settings-overlay")).not.toBeNull();

    overlay.destroy?.();
  });

  it("Escape with the Log Out prompt open closes only the prompt", () => {
    const overlay = createSettingsOverlay(defaultOptions);
    overlay.mount(container);
    overlay.open();

    clickEl(container.querySelector(".settings-nav-item.danger"));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(document.querySelector("[data-testid='logout-confirm-dialog']")).toBeNull();
    expect(defaultOptions.onClose).not.toHaveBeenCalled();
    expect(defaultOptions.onLogout).not.toHaveBeenCalled();

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(defaultOptions.onClose).toHaveBeenCalled();

    overlay.destroy?.();
  });

  it("cancelling the Log Out prompt does not log out", () => {
    const overlay = createSettingsOverlay(defaultOptions);
    overlay.mount(container);

    clickEl(container.querySelector(".settings-nav-item.danger"));
    clickEl(document.querySelector("[data-testid='logout-cancel']"));
    expect(defaultOptions.onLogout).not.toHaveBeenCalled();
    expect(document.querySelector("[data-testid='logout-confirm-dialog']")).toBeNull();

    overlay.destroy?.();
  });

  it("destroying the overlay with the Log Out prompt open removes it and does not log out", () => {
    const overlay = createSettingsOverlay(defaultOptions);
    overlay.mount(container);

    clickEl(container.querySelector(".settings-nav-item.danger"));
    expect(document.querySelector("[data-testid='logout-confirm-dialog']")).not.toBeNull();
    overlay.destroy?.();

    expect(document.querySelector("[data-testid='logout-confirm-dialog']")).toBeNull();
    expect(defaultOptions.onLogout).not.toHaveBeenCalled();
    // Nothing left to answer: a later Escape or click has no handler to run.
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(defaultOptions.onLogout).not.toHaveBeenCalled();
  });

  it("shows the app version in small text under Log Out", async () => {
    const overlay = createSettingsOverlay(defaultOptions);
    overlay.mount(container);
    await vi.waitFor(() => {
      expect(container.querySelector(".settings-sidebar-version")?.textContent).toBe(
        "Version 1.2.3-test",
      );
    });
    const sidebar = container.querySelector(".settings-sidebar")!;
    const logout = sidebar.querySelector(".settings-sidebar-logout")!;
    expect(logout.nextElementSibling?.className).toContain("settings-sidebar-version");
    overlay.destroy?.();
  });

  it("leaves the nav without a version when the host reports none", async () => {
    mockAppVersion.mockResolvedValueOnce(null);
    const overlay = createSettingsOverlay(defaultOptions);
    overlay.mount(container);
    await Promise.resolve();
    await Promise.resolve();
    expect(container.querySelector(".settings-sidebar-version")).toBeNull();
    overlay.destroy?.();
  });

  it("validates password change requires minimum length", () => {
    const overlay = createSettingsOverlay(defaultOptions);
    overlay.mount(container);
    overlay.open();

    const inputs = container.querySelectorAll("#pw-old, #pw-new, #pw-confirm");
    (inputs[0] as HTMLInputElement).value = "oldpass123";
    (inputs[1] as HTMLInputElement).value = "short";
    (inputs[2] as HTMLInputElement).value = "short";

    const changePwBtn = Array.from(container.querySelectorAll(".ac-btn")).find(
      (b) => b.textContent === "Change Password",
    ) as HTMLElement;
    changePwBtn.click();

    expect(defaultOptions.onChangePassword).not.toHaveBeenCalled();

    overlay.destroy?.();
  });

  it("validates password confirmation matches", () => {
    const overlay = createSettingsOverlay(defaultOptions);
    overlay.mount(container);
    overlay.open();

    const inputs = container.querySelectorAll("#pw-old, #pw-new, #pw-confirm");
    (inputs[0] as HTMLInputElement).value = "oldpass123";
    (inputs[1] as HTMLInputElement).value = "newpassword123";
    (inputs[2] as HTMLInputElement).value = "differentpassword";

    const changePwBtn = Array.from(container.querySelectorAll(".ac-btn")).find(
      (b) => b.textContent === "Change Password",
    ) as HTMLElement;
    changePwBtn.click();

    expect(defaultOptions.onChangePassword).not.toHaveBeenCalled();

    overlay.destroy?.();
  });

  it("requires the current password before calling the server", () => {
    const overlay = createSettingsOverlay(defaultOptions);
    overlay.mount(container);
    overlay.open();

    const inputs = container.querySelectorAll("#pw-old, #pw-new, #pw-confirm");
    (inputs[0] as HTMLInputElement).value = "";
    (inputs[1] as HTMLInputElement).value = "newpassword123";
    (inputs[2] as HTMLInputElement).value = "newpassword123";

    const changePwBtn = Array.from(container.querySelectorAll(".ac-btn")).find(
      (b) => b.textContent === "Change Password",
    ) as HTMLElement;
    changePwBtn.click();

    // An empty current password is a guaranteed 403 — and each one counts
    // against the server's lockout counter.
    expect(defaultOptions.onChangePassword).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Enter your current password.");

    overlay.destroy?.();
  });

  it("blocks a double submit while the password change is in flight", async () => {
    let resolveChange: (() => void) | null = null;
    const onChangePassword = vi.fn(
      () =>
        new Promise<undefined>((resolve) => {
          resolveChange = () => resolve(undefined);
        }),
    );
    const overlay = createSettingsOverlay({ ...defaultOptions, onChangePassword });
    overlay.mount(container);
    overlay.open();

    const inputs = container.querySelectorAll("#pw-old, #pw-new, #pw-confirm");
    (inputs[0] as HTMLInputElement).value = "oldpass123";
    (inputs[1] as HTMLInputElement).value = "newpassword123";
    (inputs[2] as HTMLInputElement).value = "newpassword123";

    const changePwBtn = Array.from(container.querySelectorAll(".ac-btn")).find(
      (b) => b.textContent === "Change Password",
    ) as HTMLButtonElement;
    changePwBtn.click();
    expect(changePwBtn.disabled).toBe(true);
    expect(changePwBtn.textContent).toBe("Changing...");

    changePwBtn.click();
    expect(onChangePassword).toHaveBeenCalledTimes(1);

    resolveChange!();
    await vi.waitFor(() => {
      expect(changePwBtn.disabled).toBe(false);
      expect(changePwBtn.textContent).toBe("Change Password");
    });

    overlay.destroy?.();
  });

  it("calls onChangePassword and clears inputs on success", async () => {
    const onChangePassword = vi.fn().mockResolvedValue(undefined);
    const overlay = createSettingsOverlay({ ...defaultOptions, onChangePassword });
    overlay.mount(container);
    overlay.open();

    const inputs = container.querySelectorAll("#pw-old, #pw-new, #pw-confirm");
    (inputs[0] as HTMLInputElement).value = "oldpass123";
    (inputs[1] as HTMLInputElement).value = "newpassword123";
    (inputs[2] as HTMLInputElement).value = "newpassword123";

    const changePwBtn = Array.from(container.querySelectorAll(".ac-btn")).find(
      (b) => b.textContent === "Change Password",
    ) as HTMLElement;
    changePwBtn.click();

    await vi.waitFor(() => {
      expect(onChangePassword).toHaveBeenCalledWith("oldpass123", "newpassword123");
    });

    // Inputs should be cleared after success
    await vi.waitFor(() => {
      expect((inputs[0] as HTMLInputElement).value).toBe("");
      expect((inputs[1] as HTMLInputElement).value).toBe("");
      expect((inputs[2] as HTMLInputElement).value).toBe("");
    });

    overlay.destroy?.();
  });

  it("keeps a partial-success warning in the form instead of the green success", async () => {
    // The server answers 200 + warning when the password changed but the
    // other sessions could not be revoked; the form must carry that
    // instruction, not clear the fields under an unqualified green
    // "changed successfully" beside the warning toast.
    const warning =
      "password changed, but other sessions could not be revoked; revoke them from the sessions list";
    const onChangePassword = vi.fn().mockResolvedValue({ warning, sessions_revoked: 0 });
    const overlay = createSettingsOverlay({ ...defaultOptions, onChangePassword });
    overlay.mount(container);
    overlay.open();

    const inputs = container.querySelectorAll("#pw-old, #pw-new, #pw-confirm");
    (inputs[0] as HTMLInputElement).value = "oldpass123";
    (inputs[1] as HTMLInputElement).value = "newpassword123";
    (inputs[2] as HTMLInputElement).value = "newpassword123";
    const changePwBtn = Array.from(container.querySelectorAll(".ac-btn")).find(
      (b) => b.textContent === "Change Password",
    ) as HTMLElement;
    changePwBtn.click();

    const status = container.querySelector<HTMLElement>('[data-testid="pw-change-status"]');
    expect(status).not.toBeNull();
    await vi.waitFor(() => {
      expect(onChangePassword).toHaveBeenCalledWith("oldpass123", "newpassword123");
      expect(status!.textContent).toBe(warning);
    });
    // B9-23: the warning is the qualified .form-warning class, not an inline
    // --yellow (which reads 1.89:1 on light), and keeps the live role it was
    // created with so the swap to the warning text is announced.
    expect(status!.classList.contains("form-warning")).toBe(true);
    expect(status!.getAttribute("role")).toBe("alert");
    // The password did change, so the fields are cleared like any success.
    expect((inputs[0] as HTMLInputElement).value).toBe("");
    expect((inputs[1] as HTMLInputElement).value).toBe("");
    expect(container.textContent).not.toContain("Password changed successfully.");

    overlay.destroy?.();
  });

  it("shows error when password change fails", async () => {
    const onChangePassword = vi.fn().mockRejectedValue(new Error("Incorrect old password"));
    const overlay = createSettingsOverlay({ ...defaultOptions, onChangePassword });
    overlay.mount(container);
    overlay.open();

    const inputs = container.querySelectorAll("#pw-old, #pw-new, #pw-confirm");
    (inputs[0] as HTMLInputElement).value = "wrongold";
    (inputs[1] as HTMLInputElement).value = "newpassword123";
    (inputs[2] as HTMLInputElement).value = "newpassword123";

    const changePwBtn = Array.from(container.querySelectorAll(".ac-btn")).find(
      (b) => b.textContent === "Change Password",
    ) as HTMLElement;
    changePwBtn.click();

    await vi.waitFor(() => {
      // B9-23: the error is the shared .form-error class with role=alert.
      const pwError = container.querySelector('[data-testid="pw-change-status"]');
      expect(pwError?.textContent).toBe("Incorrect old password");
      expect(pwError?.classList.contains("form-error")).toBe(true);
      expect(pwError?.getAttribute("role")).toBe("alert");
    });

    overlay.destroy?.();
  });

  it("shows error when username update fails", async () => {
    const onUpdateProfile = vi.fn().mockRejectedValue(new Error("Username taken"));
    const overlay = createSettingsOverlay({ ...defaultOptions, onUpdateProfile });
    overlay.mount(container);
    overlay.open();

    const editBtn = container.querySelector(".account-field-edit") as HTMLElement;
    editBtn.click();

    const editInput = container.querySelector(
      '[data-testid="username-edit-input"]',
    ) as HTMLInputElement;
    editInput.value = "taken-name";

    const saveBtn = Array.from(container.querySelectorAll(".ac-btn")).find(
      (b) => b.textContent === "Save",
    ) as HTMLElement;
    saveBtn.click();

    await vi.waitFor(() => {
      const nameError = container.querySelector<HTMLElement>("#username-edit-error");
      expect(nameError?.textContent).toBe("Username taken");
      expect(nameError?.getAttribute("role")).toBe("alert");
    });

    overlay.destroy?.();
  });

  // WP 3C-9: the rename and display-name inputs carry the new limits.
  function openUsernameEditor(onUpdateProfile = defaultOptions.onUpdateProfile) {
    const overlay = createSettingsOverlay({ ...defaultOptions, onUpdateProfile });
    overlay.mount(container);
    overlay.open();
    (container.querySelector(".account-field-edit") as HTMLElement).click();
    const editInput = container.querySelector<HTMLInputElement>(
      '[data-testid="username-edit-input"]',
    )!;
    const saveBtn = Array.from(container.querySelectorAll(".ac-btn")).find(
      (b) => b.textContent === "Save",
    ) as HTMLElement;
    const error = container.querySelector<HTMLElement>("#username-edit-error")!;
    return { overlay, editInput, saveBtn, error };
  }

  it("bounds the rename input and shows the rule", () => {
    const { overlay, editInput } = openUsernameEditor();
    expect(editInput.maxLength).toBe(64); // 2 units per character; the 32-character cap is by count
    const hintId = editInput.getAttribute("aria-describedby")!.split(" ").at(-1)!;
    const hint = container.querySelector<HTMLElement>(`#${hintId}`)!;
    expect(hint.textContent).toContain("2–32 characters");
    overlay.destroy?.();
  });

  it("fits and sends a 32-letter rename outside the BMP", async () => {
    const onUpdateProfile = vi.fn().mockResolvedValue(undefined);
    const { overlay, editInput, saveBtn } = openUsernameEditor(onUpdateProfile);
    const bold = "\u{1D400}".repeat(32); // 2 UTF-16 units per letter
    expect(bold.length).toBeLessThanOrEqual(editInput.maxLength);
    editInput.value = bold;
    saveBtn.click();
    await vi.waitFor(() => expect(onUpdateProfile).toHaveBeenCalledWith({ username: bold }));
    overlay.destroy?.();
  });

  it("does not send a rename the server's rules refuse (over the limit, reserved, bad character)", () => {
    const onUpdateProfile = vi.fn().mockResolvedValue(undefined);
    const { overlay, editInput, saveBtn, error } = openUsernameEditor(onUpdateProfile);
    for (const [typed, message] of [
      ["x".repeat(40), "Username must be 2–32 characters."],
      ["Here", "Username is reserved."],
      ["has space", "Username may only contain letters, digits, '_', '.' and '-'."],
    ] as const) {
      editInput.value = typed;
      saveBtn.click();
      expect(error.textContent).toBe(message);
      expect(editInput.value).toBe(typed);
    }
    expect(onUpdateProfile).not.toHaveBeenCalled();
    overlay.destroy?.();
  });

  it("shows the server's refusal of a rename inline and keeps the typed name", async () => {
    const onUpdateProfile = vi
      .fn()
      .mockRejectedValue(new ApiClientError(400, "INVALID_INPUT", "username is reserved"));
    const { overlay, editInput, saveBtn, error } = openUsernameEditor(onUpdateProfile);
    editInput.value = "passes-client";
    saveBtn.click();
    await vi.waitFor(() => expect(error.textContent).toBe("Username is reserved"));
    expect(editInput.value).toBe("passes-client");
    expect(editInput.getAttribute("aria-invalid")).toBe("true");
    overlay.destroy?.();
  });

  it("bounds the display name and does not send one over the limit", async () => {
    const onUpdateProfile = vi.fn().mockResolvedValue(undefined);
    const overlay = createSettingsOverlay({ ...defaultOptions, onUpdateProfile });
    overlay.mount(container);
    overlay.open();
    const nameInput = container.querySelector<HTMLInputElement>(
      '[data-testid="display-name-input"]',
    )!;
    expect(nameInput.maxLength).toBe(64); // 2 units per character; the 32-character cap is by count
    const hint = nameInput.nextElementSibling as HTMLElement;
    expect(hint.textContent).toBe("Up to 32 characters, on one line.");

    const over = "n".repeat(50);
    nameInput.value = over;
    container.querySelector<HTMLElement>('[data-testid="profile-save-btn"]')!.click();
    expect(onUpdateProfile).not.toHaveBeenCalled();
    expect(hint.textContent).toBe("Display name must be at most 32 characters.");
    expect(container.querySelector('[data-testid="profile-error"]')?.textContent).toBe(
      "Check the highlighted field.",
    );
    expect(nameInput.value).toBe(over);
    overlay.destroy?.();
  });

  it("sends the display name with runs of spaces collapsed, as the server stores it", async () => {
    const onUpdateProfile = vi.fn().mockResolvedValue(undefined);
    const overlay = createSettingsOverlay({ ...defaultOptions, onUpdateProfile });
    overlay.mount(container);
    overlay.open();
    container.querySelector<HTMLInputElement>('[data-testid="display-name-input"]')!.value =
      "  Ada    Lovelace ";
    container.querySelector<HTMLElement>('[data-testid="profile-save-btn"]')!.click();
    await vi.waitFor(() => expect(onUpdateProfile).toHaveBeenCalled());
    expect(onUpdateProfile.mock.calls[0]![0].display_name).toBe("Ada Lovelace");
    overlay.destroy?.();
  });

  it("shows the server's display-name refusal under the field and keeps the typed name", async () => {
    const onUpdateProfile = vi
      .fn()
      .mockRejectedValue(
        new ApiClientError(
          400,
          "INVALID_INPUT",
          "display_name must not contain control characters or line breaks",
        ),
      );
    const overlay = createSettingsOverlay({ ...defaultOptions, onUpdateProfile });
    overlay.mount(container);
    overlay.open();
    const nameInput = container.querySelector<HTMLInputElement>(
      '[data-testid="display-name-input"]',
    )!;
    const hint = nameInput.nextElementSibling as HTMLElement;
    nameInput.value = "Ada";
    container.querySelector<HTMLElement>('[data-testid="profile-save-btn"]')!.click();
    await vi.waitFor(() =>
      expect(hint.textContent).toBe(
        "Display_name must not contain control characters or line breaks",
      ),
    );
    // Said once, under the field; the status line points at it.
    expect(container.querySelector('[data-testid="profile-error"]')?.textContent).toBe(
      "Check the highlighted field.",
    );
    expect(nameInput.value).toBe("Ada");
    overlay.destroy?.();
  });

  it("Cancel button hides the username edit form", () => {
    const overlay = createSettingsOverlay(defaultOptions);
    overlay.mount(container);
    overlay.open();

    // Open edit form
    const editBtn = container.querySelector(".account-field-edit") as HTMLElement;
    editBtn.click();

    // Click cancel
    const cancelBtn = Array.from(container.querySelectorAll(".ac-btn")).find(
      (b) => b.textContent === "Cancel",
    ) as HTMLElement;
    cancelBtn.click();

    // Edit form should be hidden
    const editInput = container.querySelector(
      '[data-testid="username-edit-input"]',
    ) as HTMLInputElement;
    const editForm = editInput.closest(".setting-row") as HTMLElement;
    expect(editForm.style.display).toBe("none");

    overlay.destroy?.();
  });

  // --- Delete account tests ---

  it("shows confirmation area when Delete Account is clicked", () => {
    const overlay = createSettingsOverlay(defaultOptions);
    overlay.mount(container);
    overlay.open();

    const triggerBtn = container.querySelector(
      "[data-testid='delete-account-trigger']",
    ) as HTMLElement;
    expect(triggerBtn).not.toBeNull();

    const confirmArea = container.querySelector(
      "[data-testid='delete-account-confirm-area']",
    ) as HTMLElement;
    expect(confirmArea.style.display).toBe("none");

    triggerBtn.click();

    expect(confirmArea.style.display).toBe("block");
    expect(triggerBtn.style.display).toBe("none");

    overlay.destroy?.();
  });

  it("hides confirmation area when Cancel is clicked", () => {
    const overlay = createSettingsOverlay(defaultOptions);
    overlay.mount(container);
    overlay.open();

    const triggerBtn = container.querySelector(
      "[data-testid='delete-account-trigger']",
    ) as HTMLElement;
    triggerBtn.click();

    const confirmArea = container.querySelector(
      "[data-testid='delete-account-confirm-area']",
    ) as HTMLElement;
    expect(confirmArea.style.display).toBe("block");

    const cancelBtn = confirmArea.querySelector("button:not(.account-delete-btn)") as HTMLElement;
    cancelBtn.click();

    expect(confirmArea.style.display).toBe("none");
    expect(triggerBtn.style.display).toBe("");

    overlay.destroy?.();
  });

  // B7-15c owner decision: the dialog states immediacy, backups and cached
  // images, and never a retention window — erasure hard-deletes at once.
  it("delete warning discloses immediacy, backups and cached images, and no retention window", () => {
    const overlay = createSettingsOverlay({
      ...defaultOptions,
      getRetentionNotice: () => "By default this server deletes messages after 30 days.",
    });
    overlay.mount(container);
    overlay.open();
    (container.querySelector("[data-testid='delete-account-trigger']") as HTMLElement).click();

    const warning = container.querySelector(
      "[data-testid='delete-account-confirm-area']",
    )!.textContent!;
    expect(warning).toContain("immediate and permanent");
    expect(warning).toContain("backups made before you delete keep a copy until they rotate out");
    expect(warning).toContain("your deletion is applied again");
    expect(warning).toContain("cached on other people's devices");
    expect(warning).not.toMatch(/\bdays?\b/);
    expect(warning).not.toContain("By default this server");

    overlay.destroy?.();
  });

  it("shows the retention window in its own Account section when the server reported one", () => {
    const notice = "By default this server deletes messages after 30 days.";
    const overlay = createSettingsOverlay({ ...defaultOptions, getRetentionNotice: () => notice });
    overlay.mount(container);
    overlay.open();

    const section = container.querySelector("[data-testid='account-retention']")!;
    expect(section.textContent).toContain(notice);
    expect(
      section.contains(container.querySelector("[data-testid='delete-account-confirm-area']")),
    ).toBe(false);

    overlay.destroy?.();
  });

  it("omits the retention section when the server did not report one", () => {
    const overlay = createSettingsOverlay({ ...defaultOptions, getRetentionNotice: () => null });
    overlay.mount(container);
    expect(container.querySelector("[data-testid='account-retention']")).toBeNull();
    overlay.destroy?.();
  });

  it("shows error when confirming delete without password", () => {
    const overlay = createSettingsOverlay(defaultOptions);
    overlay.mount(container);
    overlay.open();

    const triggerBtn = container.querySelector(
      "[data-testid='delete-account-trigger']",
    ) as HTMLElement;
    triggerBtn.click();

    const confirmBtn = container.querySelector(
      "[data-testid='delete-account-confirm']",
    ) as HTMLElement;
    confirmBtn.click();

    const errorEl = container.querySelector("[data-testid='delete-account-error']") as HTMLElement;
    expect(errorEl.textContent).toBe("Password is required.");
    expect(defaultOptions.onDeleteAccount).not.toHaveBeenCalled();

    overlay.destroy?.();
  });

  it("calls onDeleteAccount with password on confirm", () => {
    const overlay = createSettingsOverlay(defaultOptions);
    overlay.mount(container);
    overlay.open();

    const triggerBtn = container.querySelector(
      "[data-testid='delete-account-trigger']",
    ) as HTMLElement;
    triggerBtn.click();

    const passwordInput = container.querySelector(
      "[data-testid='delete-account-password']",
    ) as HTMLInputElement;
    passwordInput.value = "mypassword123";

    const confirmBtn = container.querySelector(
      "[data-testid='delete-account-confirm']",
    ) as HTMLButtonElement;
    confirmBtn.click();

    expect(defaultOptions.onDeleteAccount).toHaveBeenCalledWith("mypassword123");

    overlay.destroy?.();
  });

  it("disables confirm button and shows 'Deleting...' during delete", () => {
    const overlay = createSettingsOverlay(defaultOptions);
    overlay.mount(container);
    overlay.open();

    const triggerBtn = container.querySelector(
      "[data-testid='delete-account-trigger']",
    ) as HTMLElement;
    triggerBtn.click();

    const passwordInput = container.querySelector(
      "[data-testid='delete-account-password']",
    ) as HTMLInputElement;
    passwordInput.value = "mypassword123";

    const confirmBtn = container.querySelector(
      "[data-testid='delete-account-confirm']",
    ) as HTMLButtonElement;
    confirmBtn.click();

    expect(confirmBtn.disabled).toBe(true);
    expect(confirmBtn.textContent).toBe("Deleting...");

    overlay.destroy?.();
  });

  it("shows error and re-enables button on delete failure", async () => {
    const failOptions = {
      ...defaultOptions,
      onDeleteAccount: vi.fn().mockRejectedValue(new Error("Wrong password")),
    };

    const overlay = createSettingsOverlay(failOptions);
    overlay.mount(container);
    overlay.open();

    const triggerBtn = container.querySelector(
      "[data-testid='delete-account-trigger']",
    ) as HTMLElement;
    triggerBtn.click();

    const passwordInput = container.querySelector(
      "[data-testid='delete-account-password']",
    ) as HTMLInputElement;
    passwordInput.value = "wrongpassword";

    const confirmBtn = container.querySelector(
      "[data-testid='delete-account-confirm']",
    ) as HTMLButtonElement;
    confirmBtn.click();

    // Wait for the rejected promise to settle
    await vi.waitFor(() => {
      expect(confirmBtn.disabled).toBe(false);
    });

    const errorEl = container.querySelector("[data-testid='delete-account-error']") as HTMLElement;
    expect(errorEl.textContent).toBe("Wrong password");
    expect(confirmBtn.textContent).toBe("Confirm Delete");

    overlay.destroy?.();
  });

  it("clears password input when reopening confirmation area", () => {
    const overlay = createSettingsOverlay(defaultOptions);
    overlay.mount(container);
    overlay.open();

    const triggerBtn = container.querySelector(
      "[data-testid='delete-account-trigger']",
    ) as HTMLElement;
    triggerBtn.click();

    const passwordInput = container.querySelector(
      "[data-testid='delete-account-password']",
    ) as HTMLInputElement;
    passwordInput.value = "typed-something";

    // Cancel and reopen
    const confirmArea = container.querySelector(
      "[data-testid='delete-account-confirm-area']",
    ) as HTMLElement;
    const cancelBtn = confirmArea.querySelector("button:not(.account-delete-btn)") as HTMLElement;
    cancelBtn.click();
    triggerBtn.click();

    expect(passwordInput.value).toBe("");

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

  // --- Username validation ---

  it("rejects single-character username (min 2)", () => {
    const overlay = createSettingsOverlay(defaultOptions);
    overlay.mount(container);
    overlay.open();

    // Click "Edit" to open username edit form
    const editBtn = container.querySelector(".account-field-edit") as HTMLElement;
    editBtn.click();

    // Type a single character
    const editInput = container.querySelector(
      '[data-testid="username-edit-input"]',
    ) as HTMLInputElement;
    editInput.value = "A";

    // Click Save
    const saveBtn = Array.from(container.querySelectorAll(".ac-btn")).find(
      (b) => b.textContent === "Save",
    ) as HTMLElement;
    saveBtn.click();

    // Should NOT call onUpdateProfile
    expect(defaultOptions.onUpdateProfile).not.toHaveBeenCalled();

    overlay.destroy?.();
  });

  it("accepts two-character username (min 2)", () => {
    const overlay = createSettingsOverlay(defaultOptions);
    overlay.mount(container);
    overlay.open();

    const editBtn = container.querySelector(".account-field-edit") as HTMLElement;
    editBtn.click();

    const editInput = container.querySelector(
      '[data-testid="username-edit-input"]',
    ) as HTMLInputElement;
    editInput.value = "AB";

    const saveBtn = Array.from(container.querySelectorAll(".ac-btn")).find(
      (b) => b.textContent === "Save",
    ) as HTMLElement;
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

    const overlay = createSettingsOverlay(defaultOptions);
    overlay.mount(container);
    overlay.open();

    // Header starts out showing the display name, not the username.
    const acName = container.querySelector(".account-header-name");
    expect(acName?.textContent).toBe("Alice Smith");

    const editBtn = container.querySelector(".account-field-edit") as HTMLElement;
    editBtn.click();

    const editInput = container.querySelector(
      '[data-testid="username-edit-input"]',
    ) as HTMLInputElement;
    editInput.value = "alice2";

    const saveBtn = Array.from(container.querySelectorAll(".ac-btn")).find(
      (b) => b.textContent === "Save",
    ) as HTMLElement;
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
    const overlay = createSettingsOverlay(defaultOptions);
    overlay.mount(container);
    overlay.open();

    const select = container.querySelector<HTMLSelectElement>("[data-testid='status-select']")!;
    const labels = Array.from(select.options).map((o) => o.textContent);
    expect(labels).toContain("Invisible");
    expect(labels).not.toContain("Offline");

    overlay.destroy?.();
  });

  // The status is a native <select> with a <label>: the browser owns its
  // keyboard handling, so the test drives its change event.
  it("status select is labelled and reports the chosen status", () => {
    const overlay = createSettingsOverlay(defaultOptions);
    overlay.mount(container);
    overlay.open();

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
    const overlay = createSettingsOverlay(defaultOptions);
    overlay.mount(container);
    overlay.open();

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
      await import("@components/SettingsOverlay");

    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    expect(document.activeElement).toBe(opener);

    const localContainer = document.createElement("div");
    document.body.appendChild(localContainer);

    const overlay = createReopenedOverlay({
      onClose: vi.fn(),
      onChangePassword: vi.fn().mockResolvedValue(undefined),
      onUpdateProfile: vi.fn().mockResolvedValue(undefined),
      onUploadAvatar: vi.fn().mockResolvedValue("/api/v1/files/test"),
      onRemoveAvatar: vi.fn().mockResolvedValue(undefined),
      onLogout: vi.fn(),
      onDeleteAccount: vi.fn().mockResolvedValue(undefined),
      onStatusChange: vi.fn(),
      onEnableTotp: vi.fn().mockResolvedValue({ qr_uri: "otpauth://test", backup_codes: [] }),
      onConfirmTotp: vi.fn().mockResolvedValue(undefined),
      onDisableTotp: vi.fn().mockResolvedValue(undefined),
      onRefreshTotpStatus: vi.fn().mockResolvedValue(undefined),
      onRegenerateRecoveryCodes: vi.fn().mockResolvedValue([]),
      onEnrolRecoveryKit: vi.fn().mockResolvedValue({ created_at: "" }),
      onGetRecoveryKitStatus: vi.fn().mockResolvedValue({ enrolled: false, used_at: null }),
      onListSessions: vi.fn().mockResolvedValue([]),
      onRevokeSession: vi.fn().mockResolvedValue(undefined),
      onRevokeAllSessions: vi
        .fn()
        .mockResolvedValue({ sessions_revoked: 0, current_session_revoked: false }),
    });

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
