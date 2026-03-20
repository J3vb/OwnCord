import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createSettingsOverlay } from "@components/SettingsOverlay";

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
vi.mock("@stores/ui.store", () => ({
  uiStore: {
    getState: () => ({ settingsOpen: false }),
    subscribe: () => () => {},
    subscribeSelector: vi.fn((_sel: unknown, _listener: unknown) => () => {}),
  },
  setTheme: (...args: unknown[]) => mockSetTheme(...args),
}));

vi.mock("@lib/livekitSession", () => ({
  switchInputDevice: vi.fn().mockResolvedValue(undefined),
  switchOutputDevice: vi.fn().mockResolvedValue(undefined),
  setVoiceSensitivity: vi.fn(),
}));

vi.mock("@stores/auth.store", () => ({
  authStore: {
    getState: () => ({
      user: { id: 1, username: "testuser" },
    }),
  },
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
    onLogout: vi.fn(),
  };

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    localStorage.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    container.remove();
  });

  it("mounts with all tabs", () => {
    const overlay = createSettingsOverlay(defaultOptions);
    overlay.mount(container);

    const tabs = container.querySelectorAll(".settings-sidebar > button.settings-nav-item");
    const tabNames = Array.from(tabs).map((t) => t.textContent);
    expect(tabNames).toEqual([
      "Account",
      "Appearance",
      "Notifications",
      "Voice & Audio",
      "Keybinds",
      "Logs",
    ]);

    overlay.destroy?.();
  });

  it("starts on Account tab", () => {
    const overlay = createSettingsOverlay(defaultOptions);
    overlay.mount(container);

    const activeTab = container.querySelector(".settings-sidebar > button.settings-nav-item.active");
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

  // --- Appearance tab tests ---

  it("applies theme on click", () => {
    const overlay = createSettingsOverlay(defaultOptions);
    overlay.mount(container);

    getTab(container, 1).click();

    const themeOptions = container.querySelectorAll(".theme-opt");
    expect(themeOptions.length).toBe(3);

    const midnight = themeOptions[1] as HTMLElement;
    midnight.click();

    expect(midnight.classList.contains("active")).toBe(true);
    expect(document.documentElement.style.getPropertyValue("--bg-primary")).toBe("#1a1a2e");
    expect(localStorage.getItem("owncord:settings:theme")).toBe('"midnight"');
    expect(mockSetTheme).toHaveBeenCalledWith("midnight");

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
    getTab(container, 2).click();

    const toggles = container.querySelectorAll(".toggle");
    expect(toggles.length).toBe(4);

    overlay.destroy?.();
  });

  it("persists notification toggle state", () => {
    const overlay = createSettingsOverlay(defaultOptions);
    overlay.mount(container);
    getTab(container, 2).click();

    const toggles = container.querySelectorAll(".toggle");
    const suppressToggle = toggles[2] as HTMLElement;
    suppressToggle.click();

    expect(suppressToggle.classList.contains("on")).toBe(true);
    expect(localStorage.getItem("owncord:settings:suppressEveryone")).toBe("true");

    overlay.destroy?.();
  });

  // --- Voice & Audio tab tests ---

  it("renders Voice & Audio tab with device selectors", () => {
    const overlay = createSettingsOverlay(defaultOptions);
    overlay.mount(container);
    getTab(container, 3).click();

    const selects = container.querySelectorAll("select.form-input");
    expect(selects.length).toBe(3);

    const sliders = container.querySelectorAll(".settings-slider");
    expect(sliders.length).toBeGreaterThanOrEqual(1);

    const toggles = container.querySelectorAll(".toggle");
    // 4 toggles: echo cancellation, noise suppression, auto gain control,
    // enhanced noise suppression (RNNoise)
    expect(toggles.length).toBe(4);

    overlay.destroy?.();
  });

  it("persists voice sensitivity setting", () => {
    const overlay = createSettingsOverlay(defaultOptions);
    overlay.mount(container);
    getTab(container, 3).click();

    const slider = container.querySelector(".settings-slider") as HTMLInputElement;
    slider.value = "75";
    slider.dispatchEvent(new Event("input"));

    expect(localStorage.getItem("owncord:settings:voiceSensitivity")).toBe("75");

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

    const toggles = container.querySelectorAll(".toggle");
    const echoToggle = toggles[0] as HTMLElement;

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

    const acName = container.querySelector(".ac-name");
    expect(acName?.textContent).toBe("testuser");

    overlay.destroy?.();
  });

  it("calls onLogout when logout button clicked", () => {
    const overlay = createSettingsOverlay(defaultOptions);
    overlay.mount(container);

    clickEl(container.querySelector(".settings-nav-item.danger"));
    expect(defaultOptions.onLogout).toHaveBeenCalled();

    overlay.destroy?.();
  });

  it("validates password change requires minimum length", () => {
    const overlay = createSettingsOverlay(defaultOptions);
    overlay.mount(container);

    const inputs = container.querySelectorAll("input[type='password']");
    (inputs[0] as HTMLInputElement).value = "oldpass123";
    (inputs[1] as HTMLInputElement).value = "short";
    (inputs[2] as HTMLInputElement).value = "short";

    const changePwBtn = Array.from(container.querySelectorAll(".ac-btn"))
      .find((b) => b.textContent === "Change Password") as HTMLElement;
    changePwBtn.click();

    expect(defaultOptions.onChangePassword).not.toHaveBeenCalled();

    overlay.destroy?.();
  });

  it("validates password confirmation matches", () => {
    const overlay = createSettingsOverlay(defaultOptions);
    overlay.mount(container);

    const inputs = container.querySelectorAll("input[type='password']");
    (inputs[0] as HTMLInputElement).value = "oldpass123";
    (inputs[1] as HTMLInputElement).value = "newpassword123";
    (inputs[2] as HTMLInputElement).value = "differentpassword";

    const changePwBtn = Array.from(container.querySelectorAll(".ac-btn"))
      .find((b) => b.textContent === "Change Password") as HTMLElement;
    changePwBtn.click();

    expect(defaultOptions.onChangePassword).not.toHaveBeenCalled();

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

  // --- Cleanup ---

  it("destroy removes root from DOM", () => {
    const overlay = createSettingsOverlay(defaultOptions);
    overlay.mount(container);

    expect(container.querySelector(".settings-overlay")).not.toBeNull();
    overlay.destroy?.();
    expect(container.querySelector(".settings-overlay")).toBeNull();
  });
});
