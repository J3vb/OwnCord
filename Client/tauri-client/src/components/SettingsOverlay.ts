/**
 * SettingsOverlay component — full-screen overlay with tabbed settings panels.
 * Tabs: Account, Appearance, Notifications, Keybinds.
 * Subscribes to uiStore for settingsOpen state.
 */

import { createElement, appendChildren, clearChildren, setText } from "@lib/dom";
import type { MountableComponent } from "@lib/safe-render";
import { uiStore } from "@stores/ui.store";
import { authStore } from "@stores/auth.store";
import { getLogBuffer, clearLogBuffer, addLogListener, setLogLevel } from "@lib/logger";
import type { LogEntry, LogLevel } from "@lib/logger";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SettingsOverlayOptions {
  onClose(): void;
  onChangePassword(oldPassword: string, newPassword: string): Promise<void>;
  onUpdateProfile(username: string): Promise<void>;
  onLogout(): void;
}

type TabName = "Account" | "Appearance" | "Notifications" | "Voice & Audio" | "Keybinds" | "Logs";

const TAB_NAMES: readonly TabName[] = [
  "Account",
  "Appearance",
  "Notifications",
  "Voice & Audio",
  "Keybinds",
  "Logs",
] as const;

// ---------------------------------------------------------------------------
// Theme definitions
// ---------------------------------------------------------------------------

const THEMES = {
  dark: { "--bg-primary": "#313338", "--bg-secondary": "#2b2d31", "--bg-tertiary": "#1e1f22", "--text-normal": "#dbdee1" },
  midnight: { "--bg-primary": "#1a1a2e", "--bg-secondary": "#16213e", "--bg-tertiary": "#0f3460", "--text-normal": "#e0e0e0" },
  light: { "--bg-primary": "#ffffff", "--bg-secondary": "#f2f3f5", "--bg-tertiary": "#e3e5e8", "--text-normal": "#313338" },
} as const;

type ThemeName = keyof typeof THEMES;

const STORAGE_PREFIX = "owncord:settings:";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadPref<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + key);
    return raw !== null ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function savePref(key: string, value: unknown): void {
  localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(value));
}

function applyTheme(name: ThemeName): void {
  const vars = THEMES[name];
  const root = document.documentElement;
  for (const [prop, val] of Object.entries(vars)) {
    root.style.setProperty(prop, val);
  }
}

/**
 * Apply stored appearance preferences (theme, font size, compact mode).
 * Call at app startup so the UI doesn't flash default styles.
 */
export function applyStoredAppearance(): void {
  applyTheme(loadPref<ThemeName>("theme", "dark"));
  document.documentElement.style.setProperty(
    "--font-size",
    `${loadPref<number>("fontSize", 16)}px`,
  );
  document.documentElement.classList.toggle(
    "compact-mode",
    loadPref<boolean>("compactMode", false),
  );
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createSettingsOverlay(
  options: SettingsOverlayOptions,
): MountableComponent & { open(): void; close(): void } {
  const ac = new AbortController();
  let root: HTMLDivElement | null = null;
  let contentArea: HTMLDivElement | null = null;
  let activeTab: TabName = "Account";
  const tabButtons = new Map<TabName, HTMLButtonElement>();
  let unsubUi: (() => void) | null = null;

  // ---- Tab content builders -------------------------------------------------

  function buildAccountTab(): HTMLDivElement {
    const section = createElement("div", { class: "settings-pane active" });
    const user = authStore.getState().user;

    // Account card
    const accountCard = createElement("div", { class: "account-card" });
    const acAvatar = createElement("div", {
      class: "ac-avatar",
      style: "background: var(--accent)",
    }, (user?.username ?? "U").charAt(0).toUpperCase());
    const acInfo = createElement("div", {});
    const acName = createElement("div", { class: "ac-name" }, user?.username ?? "Unknown");
    const acId = createElement("div", { class: "ac-id" }, `ID: ${user?.id ?? "?"}`);
    appendChildren(acInfo, acName, acId);
    const editBtn = createElement("button", { class: "ac-btn" }, "Edit Profile");
    appendChildren(accountCard, acAvatar, acInfo, editBtn);
    section.appendChild(accountCard);

    const editForm = createElement("div", { class: "setting-row", style: "display:none" });
    const editInput = createElement("input", { class: "form-input", type: "text", placeholder: "New username" });
    const saveBtn = createElement("button", { class: "ac-btn" }, "Save");
    const cancelBtn = createElement("button", { class: "ac-btn", style: "background:var(--bg-active)" }, "Cancel");
    const usernameValue = acName;
    appendChildren(editForm, editInput, saveBtn, cancelBtn);

    editBtn.addEventListener("click", () => {
      editForm.style.display = "flex";
      editInput.value = user?.username ?? "";
      editInput.focus();
    }, { signal: ac.signal });

    cancelBtn.addEventListener("click", () => {
      editForm.style.display = "none";
    }, { signal: ac.signal });

    saveBtn.addEventListener("click", () => {
      const newName = editInput.value.trim();
      if (newName.length > 0) {
        void options.onUpdateProfile(newName).then(() => {
          setText(usernameValue, newName);
          editForm.style.display = "none";
        });
      }
    }, { signal: ac.signal });

    section.appendChild(editForm);

    // Change password
    const pwHeader = createElement("h3", {}, "Change Password");
    const oldPw = createElement("input", { class: "form-input", type: "password", placeholder: "Old password", style: "margin-bottom:8px" });
    const newPw = createElement("input", { class: "form-input", type: "password", placeholder: "New password", style: "margin-bottom:8px" });
    const confirmPw = createElement("input", { class: "form-input", type: "password", placeholder: "Confirm new password", style: "margin-bottom:8px" });
    const pwError = createElement("div", { style: "color:var(--red);font-size:13px;margin-bottom:8px" });
    const pwBtn = createElement("button", { class: "ac-btn" }, "Change Password");

    pwBtn.addEventListener("click", () => {
      const oldVal = oldPw.value;
      const newVal = newPw.value;
      const confirmVal = confirmPw.value;

      if (newVal.length < 8) {
        setText(pwError, "New password must be at least 8 characters.");
        return;
      }
      if (newVal !== confirmVal) {
        setText(pwError, "Passwords do not match.");
        return;
      }
      setText(pwError, "");
      void options.onChangePassword(oldVal, newVal).then(() => {
        oldPw.value = "";
        newPw.value = "";
        confirmPw.value = "";
      });
    }, { signal: ac.signal });

    appendChildren(section, pwHeader, oldPw, newPw, confirmPw, pwError, pwBtn);

    // Logout
    const logoutBtn = createElement("button", {
      class: "settings-nav-item danger",
      style: "margin-top:16px;width:auto;padding:8px 16px",
    }, "Log Out");
    logoutBtn.addEventListener("click", () => options.onLogout(), { signal: ac.signal });
    section.appendChild(logoutBtn);

    return section;
  }

  function buildAppearanceTab(): HTMLDivElement {
    const section = createElement("div", { class: "settings-pane active" });
    const currentTheme = loadPref<ThemeName>("theme", "dark");
    const currentFontSize = loadPref<number>("fontSize", 16);
    const currentCompact = loadPref<boolean>("compactMode", false);

    // Theme selector
    const themeHeader = createElement("h3", {}, "Theme");
    const themeRow = createElement("div", { class: "theme-options" });
    for (const name of Object.keys(THEMES) as ThemeName[]) {
      const btn = createElement("div", {
        class: `theme-opt ${name}${name === currentTheme ? " active" : ""}`,
      }, name.charAt(0).toUpperCase() + name.slice(1));

      btn.addEventListener("click", () => {
        applyTheme(name);
        savePref("theme", name);
        const prev = themeRow.querySelector(".theme-opt.active");
        if (prev) prev.classList.remove("active");
        btn.classList.add("active");
      }, { signal: ac.signal });

      themeRow.appendChild(btn);
    }
    appendChildren(section, themeHeader, themeRow);

    // Font size slider
    const fontHeader = createElement("h3", {}, "Font Size");
    const fontRow = createElement("div", { class: "slider-row" });
    const fontSlider = createElement("input", {
      class: "settings-slider",
      type: "range",
      min: "12",
      max: "20",
      value: String(currentFontSize),
    });
    const fontLabel = createElement("span", { class: "slider-val" }, `${currentFontSize}px`);
    fontSlider.addEventListener("input", () => {
      const size = Number(fontSlider.value);
      setText(fontLabel, `${size}px`);
      document.documentElement.style.setProperty("--font-size", `${size}px`);
      savePref("fontSize", size);
    }, { signal: ac.signal });
    appendChildren(fontRow, fontSlider, fontLabel);
    appendChildren(section, fontHeader, fontRow);

    // Compact mode toggle
    const compactRow = createElement("div", { class: "setting-row" });
    const compactLabel = createElement("span", { class: "setting-label" }, "Compact Mode");
    const compactToggle = createElement("div", {
      class: currentCompact ? "toggle on" : "toggle",
    });
    compactToggle.addEventListener("click", () => {
      const isNowCompact = !compactToggle.classList.contains("on");
      compactToggle.classList.toggle("on", isNowCompact);
      savePref("compactMode", isNowCompact);
      document.documentElement.classList.toggle("compact-mode", isNowCompact);
    }, { signal: ac.signal });
    appendChildren(compactRow, compactLabel, compactToggle);
    section.appendChild(compactRow);

    // Apply stored preferences on render
    applyTheme(currentTheme);
    document.documentElement.style.setProperty("--font-size", `${currentFontSize}px`);
    document.documentElement.classList.toggle("compact-mode", currentCompact);

    return section;
  }

  function buildNotificationsTab(): HTMLDivElement {
    const section = createElement("div", { class: "settings-pane active" });
    const header = createElement("h1", {}, "Notifications");
    section.appendChild(header);

    const toggles: ReadonlyArray<{ key: string; label: string; desc: string; fallback: boolean }> = [
      { key: "desktopNotifications", label: "Desktop Notifications", desc: "Show desktop notifications for messages", fallback: true },
      { key: "flashTaskbar", label: "Flash Taskbar", desc: "Flash taskbar on new messages", fallback: true },
      { key: "suppressEveryone", label: "Suppress @everyone", desc: "Mute @everyone and @here mentions", fallback: false },
      { key: "notificationSounds", label: "Notification Sounds", desc: "Play sounds for notifications", fallback: true },
    ];

    for (const item of toggles) {
      const row = createElement("div", { class: "setting-row" });
      const info = createElement("div", {});
      const label = createElement("div", { class: "setting-label" }, item.label);
      const desc = createElement("div", { class: "setting-desc" }, item.desc);
      appendChildren(info, label, desc);

      const isOn = loadPref<boolean>(item.key, item.fallback);
      const toggle = createElement("div", { class: isOn ? "toggle on" : "toggle" });
      toggle.addEventListener("click", () => {
        const nowOn = !toggle.classList.contains("on");
        toggle.classList.toggle("on", nowOn);
        savePref(item.key, nowOn);
      }, { signal: ac.signal });

      appendChildren(row, info, toggle);
      section.appendChild(row);
    }

    return section;
  }

  function buildKeybindsTab(): HTMLDivElement {
    const section = createElement("div", { class: "settings-pane active" });
    const header = createElement("h1", {}, "Keybinds");
    section.appendChild(header);

    const pttRow = createElement("div", { class: "keybind-row" });
    const pttLabel = createElement("span", { class: "setting-label" }, "Push to Talk");
    const pttValue = createElement("span", { class: "kbd" }, loadPref<string>("pttKey", "Not set"));
    appendChildren(pttRow, pttLabel, pttValue);
    section.appendChild(pttRow);

    const searchRow = createElement("div", { class: "keybind-row" });
    const searchLabel = createElement("span", { class: "setting-label" }, "Quick Switcher");
    const searchValue = createElement("span", { class: "kbd" }, "Ctrl + K");
    appendChildren(searchRow, searchLabel, searchValue);
    section.appendChild(searchRow);

    return section;
  }

  // ---- Voice & Audio tab ------------------------------------------------------

  function buildVoiceAudioTab(): HTMLDivElement {
    const section = createElement("div", { class: "settings-pane active" });
    const header = createElement("h1", {}, "Voice & Audio");
    section.appendChild(header);

    // Input device selector
    const inputHeader = createElement("h3", {}, "Input Device");
    const inputSelect = createElement("select", {
      class: "form-input",
      style: "width:100%;margin-bottom:12px",
    });
    const defaultInputOpt = createElement("option", { value: "" }, "Default");
    inputSelect.appendChild(defaultInputOpt);
    section.appendChild(inputHeader);
    section.appendChild(inputSelect);

    // Output device selector
    const outputHeader = createElement("h3", {}, "Output Device");
    const outputSelect = createElement("select", {
      class: "form-input",
      style: "width:100%;margin-bottom:12px",
    });
    const defaultOutputOpt = createElement("option", { value: "" }, "Default");
    outputSelect.appendChild(defaultOutputOpt);
    section.appendChild(outputHeader);
    section.appendChild(outputSelect);

    // Populate devices asynchronously
    void (async () => {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const savedInput = loadPref<string>("audioInputDevice", "");
        const savedOutput = loadPref<string>("audioOutputDevice", "");

        for (const d of devices) {
          if (d.kind === "audioinput") {
            const opt = createElement("option", { value: d.deviceId },
              d.label || `Microphone (${d.deviceId.slice(0, 8)})`);
            if (d.deviceId === savedInput) opt.setAttribute("selected", "");
            inputSelect.appendChild(opt);
          } else if (d.kind === "audiooutput") {
            const opt = createElement("option", { value: d.deviceId },
              d.label || `Speaker (${d.deviceId.slice(0, 8)})`);
            if (d.deviceId === savedOutput) opt.setAttribute("selected", "");
            outputSelect.appendChild(opt);
          }
        }

        // Restore saved selections
        if (savedInput) inputSelect.value = savedInput;
        if (savedOutput) outputSelect.value = savedOutput;
      } catch {
        const errOpt = createElement("option", { value: "", disabled: "" },
          "Could not enumerate devices");
        inputSelect.appendChild(errOpt);
      }
    })();

    inputSelect.addEventListener("change", () => {
      savePref("audioInputDevice", inputSelect.value);
    }, { signal: ac.signal });

    outputSelect.addEventListener("change", () => {
      savePref("audioOutputDevice", outputSelect.value);
    }, { signal: ac.signal });

    // Input sensitivity slider
    const sensitivityHeader = createElement("h3", {}, "Input Sensitivity");
    const sensitivityRow = createElement("div", { class: "slider-row" });
    const savedSensitivity = loadPref<number>("voiceSensitivity", 50);
    const sensitivitySlider = createElement("input", {
      class: "settings-slider",
      type: "range",
      min: "0",
      max: "100",
      value: String(savedSensitivity),
    });
    const sensitivityLabel = createElement("span", { class: "slider-val" }, `${savedSensitivity}%`);
    sensitivitySlider.addEventListener("input", () => {
      const val = Number(sensitivitySlider.value);
      setText(sensitivityLabel, `${val}%`);
      savePref("voiceSensitivity", val);
    }, { signal: ac.signal });
    appendChildren(sensitivityRow, sensitivitySlider, sensitivityLabel);
    appendChildren(section, sensitivityHeader, sensitivityRow);

    // Audio processing toggles
    const audioToggles: ReadonlyArray<{ key: string; label: string; desc: string; fallback: boolean }> = [
      { key: "echoCancellation", label: "Echo Cancellation", desc: "Reduce echo from speakers feeding back into microphone", fallback: true },
      { key: "noiseSuppression", label: "Noise Suppression", desc: "Filter out background noise from your microphone", fallback: true },
      { key: "autoGainControl", label: "Automatic Gain Control", desc: "Automatically adjust microphone volume", fallback: true },
    ];

    for (const item of audioToggles) {
      const row = createElement("div", { class: "setting-row" });
      const info = createElement("div", {});
      const label = createElement("div", { class: "setting-label" }, item.label);
      const desc = createElement("div", { class: "setting-desc" }, item.desc);
      appendChildren(info, label, desc);

      const isOn = loadPref<boolean>(item.key, item.fallback);
      const toggle = createElement("div", { class: isOn ? "toggle on" : "toggle" });
      toggle.addEventListener("click", () => {
        const nowOn = !toggle.classList.contains("on");
        toggle.classList.toggle("on", nowOn);
        savePref(item.key, nowOn);
      }, { signal: ac.signal });

      appendChildren(row, info, toggle);
      section.appendChild(row);
    }

    return section;
  }

  // ---- Logs tab ---------------------------------------------------------------

  let logListEl: HTMLDivElement | null = null;
  let logFilterLevel: LogLevel | "all" = "all";
  let unsubLogListener: (() => void) | null = null;

  const LOG_LEVEL_COLORS: Record<LogLevel, string> = {
    debug: "#888",
    info: "#3ba55d",
    warn: "#faa61a",
    error: "#ed4245",
  };

  function formatLogEntry(entry: LogEntry): HTMLDivElement {
    const row = createElement("div", {
      class: "log-entry",
      style: `border-left: 3px solid ${LOG_LEVEL_COLORS[entry.level]}; padding: 4px 8px; margin: 2px 0; font-family: monospace; font-size: 12px; line-height: 1.4;`,
    });
    const time = entry.timestamp.slice(11, 23); // HH:MM:SS.mmm
    const level = entry.level.toUpperCase().padEnd(5);
    const text = `${time} ${level} [${entry.component}] ${entry.message}`;
    const textEl = createElement("span", {
      style: `color: ${LOG_LEVEL_COLORS[entry.level]}`,
    }, text);
    row.appendChild(textEl);

    if (entry.data !== undefined) {
      const dataStr = typeof entry.data === "string" ? entry.data : JSON.stringify(entry.data, null, 2);
      const dataEl = createElement("pre", {
        style: "margin: 2px 0 0 0; color: #999; font-size: 11px; white-space: pre-wrap; word-break: break-all;",
      }, dataStr);
      row.appendChild(dataEl);
    }

    return row;
  }

  function renderLogEntries(): void {
    if (logListEl === null) return;
    clearChildren(logListEl);

    const entries = getLogBuffer();
    for (const entry of entries) {
      if (logFilterLevel !== "all" && entry.level !== logFilterLevel) continue;
      logListEl.appendChild(formatLogEntry(entry));
    }

    // Auto-scroll to bottom
    logListEl.scrollTop = logListEl.scrollHeight;
  }

  function buildLogsTab(): HTMLDivElement {
    const section = createElement("div", { class: "settings-pane active" });
    const header = createElement("h1", {}, "Logs");
    section.appendChild(header);

    // Controls row
    const controls = createElement("div", {
      style: "display: flex; gap: 8px; margin-bottom: 8px; align-items: center;",
    });

    // Filter dropdown
    const filterLabel = createElement("span", { class: "setting-label", style: "margin: 0;" }, "Filter:");
    const filterSelect = createElement("select", {
      style: "background: var(--bg-tertiary); color: var(--text-normal); border: 1px solid var(--bg-active); border-radius: 4px; padding: 4px 8px; font-size: 13px;",
    });
    const levels: Array<LogLevel | "all"> = ["all", "debug", "info", "warn", "error"];
    for (const lvl of levels) {
      const opt = createElement("option", { value: lvl }, lvl.toUpperCase());
      if (lvl === logFilterLevel) opt.setAttribute("selected", "");
      filterSelect.appendChild(opt);
    }
    filterSelect.addEventListener("change", () => {
      logFilterLevel = filterSelect.value as LogLevel | "all";
      renderLogEntries();
    }, { signal: ac.signal });

    // Log level selector
    const levelLabel = createElement("span", { class: "setting-label", style: "margin: 0 0 0 16px;" }, "Min Level:");
    const levelSelect = createElement("select", {
      style: "background: var(--bg-tertiary); color: var(--text-normal); border: 1px solid var(--bg-active); border-radius: 4px; padding: 4px 8px; font-size: 13px;",
    });
    const minLevels: LogLevel[] = ["debug", "info", "warn", "error"];
    for (const lvl of minLevels) {
      const opt = createElement("option", { value: lvl }, lvl.toUpperCase());
      levelSelect.appendChild(opt);
    }
    levelSelect.addEventListener("change", () => {
      setLogLevel(levelSelect.value as LogLevel);
    }, { signal: ac.signal });

    // Clear button
    const clearBtn = createElement("button", {
      class: "ac-btn",
      style: "margin-left: auto;",
    }, "Clear Logs");
    clearBtn.addEventListener("click", () => {
      clearLogBuffer();
      renderLogEntries();
    }, { signal: ac.signal });

    // Refresh button
    const refreshBtn = createElement("button", { class: "ac-btn" }, "Refresh");
    refreshBtn.addEventListener("click", () => renderLogEntries(), { signal: ac.signal });

    appendChildren(controls, filterLabel, filterSelect, levelLabel, levelSelect, clearBtn, refreshBtn);
    section.appendChild(controls);

    // Log count
    const countEl = createElement("div", {
      style: "font-size: 12px; color: #888; margin-bottom: 4px;",
    }, `${getLogBuffer().length} entries`);
    section.appendChild(countEl);

    // Log list (scrollable)
    logListEl = createElement("div", {
      class: "log-viewer",
      style: "max-height: 60vh; overflow-y: auto; background: var(--bg-tertiary); border-radius: 8px; padding: 8px;",
    });
    section.appendChild(logListEl);

    renderLogEntries();

    // Live update: subscribe to new log entries
    unsubLogListener?.();
    unsubLogListener = addLogListener(() => {
      if (activeTab === "Logs") {
        renderLogEntries();
        countEl.textContent = `${getLogBuffer().length} entries`;
      }
    });

    return section;
  }

  const TAB_BUILDERS: Readonly<Record<TabName, () => HTMLDivElement>> = {
    Account: buildAccountTab,
    Appearance: buildAppearanceTab,
    Notifications: buildNotificationsTab,
    "Voice & Audio": buildVoiceAudioTab,
    Keybinds: buildKeybindsTab,
    Logs: buildLogsTab,
  };

  // ---- Core methods ---------------------------------------------------------

  function renderActiveTab(): void {
    if (contentArea === null) return;
    clearChildren(contentArea);
    const builder = TAB_BUILDERS[activeTab];
    contentArea.appendChild(builder());
  }

  function setActiveTab(tab: TabName): void {
    if (tab === activeTab) return;
    activeTab = tab;
    for (const [name, btn] of tabButtons) {
      btn.classList.toggle("active", name === tab);
    }
    renderActiveTab();
  }

  function show(): void {
    root?.classList.add("open");
  }

  function hide(): void {
    root?.classList.remove("open");
  }

  // ---- MountableComponent ---------------------------------------------------

  function mount(container: Element): void {
    root = createElement("div", { class: "settings-overlay", "data-testid": "settings-overlay" });

    // Sidebar
    const sidebar = createElement("div", { class: "settings-sidebar" });
    const catLabel = createElement("div", { class: "settings-cat" }, "User Settings");
    sidebar.appendChild(catLabel);
    for (const name of TAB_NAMES) {
      const btn = createElement("button", {
        class: `settings-nav-item${name === activeTab ? " active" : ""}`,
      }, name);
      btn.addEventListener("click", () => setActiveTab(name), { signal: ac.signal });
      tabButtons.set(name, btn);
      sidebar.appendChild(btn);
    }

    // Content
    contentArea = createElement("div", { class: "settings-content" });

    // Close button
    const closeBtn = createElement("button", { class: "settings-close-btn" }, "\u00D7");
    closeBtn.addEventListener("click", () => {
      options.onClose();
    }, { signal: ac.signal });

    // Escape key
    document.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Escape" && root?.classList.contains("open")) {
        options.onClose();
      }
    }, { signal: ac.signal });

    appendChildren(root, sidebar, contentArea, closeBtn);
    renderActiveTab();

    // Subscribe to uiStore for open/close
    unsubUi = uiStore.subscribe((state) => {
      if (state.settingsOpen) {
        show();
      } else {
        hide();
      }
    });

    // Sync initial state
    if (uiStore.getState().settingsOpen) {
      show();
    }

    container.appendChild(root);
  }

  function destroy(): void {
    ac.abort();
    if (unsubUi !== null) {
      unsubUi();
      unsubUi = null;
    }
    unsubLogListener?.();
    unsubLogListener = null;
    logListEl = null;
    tabButtons.clear();
    if (root !== null) {
      root.remove();
      root = null;
    }
    contentArea = null;
  }

  function open(): void {
    show();
  }

  function close(): void {
    hide();
  }

  return { mount, destroy, open, close };
}
