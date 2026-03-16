// ConnectPage — login/register page component.
// Uses @lib/dom helpers exclusively. Never sets innerHTML with user content.

import {
  createElement,
  setText,
  appendChildren,
  clearChildren,
  qs,
} from "@lib/dom";
import type { MountableComponent } from "@lib/safe-render";
import { openSettings, closeSettings } from "@stores/ui.store";
import { createSettingsOverlay } from "@components/SettingsOverlay";
import type { HealthStatus } from "@lib/profiles";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Saved server profile for quick-connect. */
export interface ServerProfile {
  readonly name: string;
  readonly host: string;
}

/** Form state machine states. */
export type FormState = "idle" | "loading" | "totp" | "connecting" | "error";

/** Form mode: login or register. */
export type FormMode = "login" | "register";

/** Callbacks for external wiring (API integration added later). */
export interface ConnectPageCallbacks {
  onLogin(host: string, username: string, password: string): Promise<void>;
  onRegister(
    host: string,
    username: string,
    password: string,
    inviteCode: string,
  ): Promise<void>;
  onTotpSubmit(code: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MIN_PASSWORD_LENGTH = 8;

const DEFAULT_PROFILES: readonly ServerProfile[] = [
  { name: "Local Server", host: "localhost:8443" },
];

/** Color palette for server icons. */
const ICON_COLORS = [
  "#5865F2", "#57F287", "#FEE75C", "#EB459E", "#ED4245",
  "#3BA55D", "#FAA61A", "#5865F2",
];

function getIconColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  return ICON_COLORS[Math.abs(hash) % ICON_COLORS.length] ?? "#5865f2";
}

function getIconInitials(name: string): string {
  return name.slice(0, 2).toUpperCase();
}

// ---------------------------------------------------------------------------
// ConnectPage
// ---------------------------------------------------------------------------

export function createConnectPage(
  callbacks: ConnectPageCallbacks,
  initialProfiles: readonly ServerProfile[] = DEFAULT_PROFILES,
): MountableComponent & {
  showTotp(): void;
  showConnecting(): void;
  showError(message: string): void;
  resetToIdle(): void;
  updateHealthStatus(host: string, status: HealthStatus): void;
} {
  // --- internal state (mutable, local to this instance) ---
  let formState: FormState = "idle";
  let formMode: FormMode = "login";
  let errorMessage = "";
  let container: Element | null = null;

  // Cleanup tracking
  const abortController = new AbortController();

  // --- cached DOM references (set during build) ---
  let root: HTMLDivElement;
  let serverListEl: HTMLDivElement;
  let formTitle: HTMLHeadingElement;
  let hostInput: HTMLInputElement;
  let usernameInput: HTMLInputElement;
  let passwordInput: HTMLInputElement;
  let inviteGroup: HTMLDivElement;
  let inviteInput: HTMLInputElement;
  let submitBtn: HTMLButtonElement;
  let submitBtnText: HTMLSpanElement;
  let toggleModeBtn: HTMLAnchorElement;
  let errorBanner: HTMLDivElement;
  let totpOverlay: HTMLDivElement;
  let totpInput: HTMLInputElement;
  let totpSubmitBtn: HTMLButtonElement;
  let statusBar: HTMLDivElement;
  let statusBarFill: HTMLDivElement;

  // ---------------------------------------------------------------------------
  // DOM construction
  // ---------------------------------------------------------------------------

  function buildRoot(): HTMLDivElement {
    root = createElement("div", { class: "connect-page" });

    const leftPanel = buildServerPanel();
    const rightPanel = buildFormPanel();

    appendChildren(root, leftPanel, rightPanel);

    // Status bar at bottom (hidden by default, shown with .visible class)
    statusBar = createElement("div", { class: "status-bar" });
    statusBarFill = createElement("div", { class: "status-bar-fill" });
    statusBar.appendChild(statusBarFill);
    root.appendChild(statusBar);

    // TOTP overlay (hidden by default)
    totpOverlay = buildTotpOverlay();
    root.appendChild(totpOverlay);

    return root;
  }

  function buildServerPanel(): HTMLDivElement {
    const panel = createElement("div", { class: "server-panel" });

    const header = createElement("div", { class: "server-panel-header" });
    const heading = createElement("h2", {}, "Servers");
    header.appendChild(heading);

    serverListEl = createElement("div", { class: "server-list" });

    renderServerProfiles(initialProfiles);

    appendChildren(panel, header, serverListEl);
    return panel;
  }

  // Map of host -> DOM elements for health status updates
  const healthElements = new Map<string, { dot: HTMLDivElement; latency: HTMLSpanElement }>();

  function renderServerProfiles(profiles: readonly ServerProfile[]): void {
    clearChildren(serverListEl);
    healthElements.clear();
    for (const profile of profiles) {
      const item = createElement("div", {
        class: "server-item",
        "data-host": profile.host,
      });

      const icon = createElement("div", {
        class: "srv-icon",
        style: `background:${getIconColor(profile.name)}`,
      });
      setText(icon, getIconInitials(profile.name));

      // Health status dot on the icon
      const statusDot = createElement("div", { class: "srv-status-dot unknown" });
      icon.appendChild(statusDot);

      const info = createElement("div", { class: "srv-info" });
      const name = createElement("div", { class: "srv-name" }, profile.name);
      const meta = createElement("div", { class: "srv-meta" });
      const host = createElement("span", { class: "srv-host" }, profile.host);
      const latency = createElement("span", { class: "srv-latency" });
      appendChildren(meta, host, latency);
      appendChildren(info, name, meta);

      healthElements.set(profile.host, { dot: statusDot, latency });

      appendChildren(item, icon, info);

      item.addEventListener(
        "click",
        () => {
          hostInput.value = profile.host;
        },
        { signal: abortController.signal },
      );

      serverListEl.appendChild(item);
    }
  }

  function updateHealthStatus(host: string, status: HealthStatus): void {
    const els = healthElements.get(host);
    if (!els) return;

    // Update status dot
    els.dot.className = `srv-status-dot ${status.status}`;

    // Update latency badge
    if (status.latencyMs !== null) {
      const ms = status.latencyMs;
      setText(els.latency, `${ms}ms`);
      els.latency.className = `srv-latency ${ms < 100 ? "good" : ms < 500 ? "warn" : "bad"}`;
    } else {
      setText(els.latency, "");
      els.latency.className = "srv-latency";
    }
  }

  function buildFormPanel(): HTMLDivElement {
    const panel = createElement("div", { class: "form-panel" });

    // Settings gear (top right)
    const settingsBtn = createElement("button", {
      class: "settings-gear",
      type: "button",
      "aria-label": "Settings",
    });
    setText(settingsBtn, "\u2699");
    settingsBtn.addEventListener("click", () => openSettings(), { signal: abortController.signal });

    // Form container
    const formContainer = createElement("div", { class: "form-container" });

    // Logo section
    const formLogo = createElement("div", { class: "form-logo" });
    const logoMark = createElement("div", { class: "form-logo-mark" }, "OC");
    const logoTitle = createElement("h1", {}, "OwnCord");
    const logoSubtitle = createElement("p", {}, "Connect to your server");
    appendChildren(formLogo, logoMark, logoTitle, logoSubtitle);

    // Form title
    formTitle = createElement("h1", {}, "Login");

    // Error banner (hidden by default via CSS display:none, shown with .visible)
    errorBanner = createElement("div", {
      class: "error-banner",
      role: "alert",
    });

    // Form
    const form = createElement("form", { class: "connect-form" });
    form.setAttribute("novalidate", "");

    // Host
    const hostGroup = buildFormGroup("host", "Server Address", "text", "localhost:8443");
    hostInput = qs("input", hostGroup) as HTMLInputElement;

    // Username
    const usernameGroup = buildFormGroup("username", "Username", "text", "");
    usernameInput = qs("input", usernameGroup) as HTMLInputElement;

    // Password
    const passwordGroup = buildFormGroup("password", "Password", "password", "");
    passwordInput = qs("input", passwordGroup) as HTMLInputElement;

    // Invite code (register only, hidden by default)
    inviteGroup = buildFormGroup("invite", "Invite Code", "text", "");
    inviteGroup.classList.add("form-group--hidden");
    inviteInput = qs("input", inviteGroup) as HTMLInputElement;

    // Submit button
    submitBtn = createElement("button", {
      class: "btn-primary",
      type: "submit",
    });
    submitBtnText = createElement("span", { class: "btn-text" }, "Login");
    const spinnerWrapper = createElement("span", { class: "btn-spinner" });
    const spinner = createElement("div", { class: "spinner" });
    spinnerWrapper.appendChild(spinner);
    appendChildren(submitBtn, spinnerWrapper, submitBtnText);

    // Toggle mode link
    const formSwitch = createElement("div", { class: "form-switch" });
    toggleModeBtn = createElement("a", {}, "Need an account? Register") as HTMLAnchorElement;
    formSwitch.appendChild(toggleModeBtn);

    appendChildren(form, hostGroup, usernameGroup, passwordGroup, inviteGroup, submitBtn, formSwitch);

    // Wire form events
    form.addEventListener("submit", handleFormSubmit, { signal: abortController.signal });
    toggleModeBtn.addEventListener("click", handleToggleMode, { signal: abortController.signal });

    appendChildren(formContainer, formLogo, errorBanner, form);
    appendChildren(panel, settingsBtn, formContainer);
    return panel;
  }

  function buildFormGroup(
    id: string,
    labelText: string,
    inputType: string,
    placeholder: string,
  ): HTMLDivElement {
    const group = createElement("div", { class: "form-group" });
    const label = createElement("label", { class: "form-label", for: id }, labelText);
    const input = createElement("input", {
      class: "form-input",
      id,
      name: id,
      type: inputType,
      placeholder,
      autocomplete: inputType === "password" ? "current-password" : "off",
    });
    if (id === "host") {
      input.setAttribute("required", "");
    }
    if (id === "username" || id === "password") {
      input.setAttribute("required", "");
    }

    if (inputType === "password") {
      const wrapper = createElement("div", { class: "password-wrapper" });
      const toggle = createElement("button", {
        class: "password-toggle",
        type: "button",
        "aria-label": "Toggle password visibility",
      }, "\uD83D\uDC41");
      toggle.addEventListener(
        "click",
        () => {
          const isPassword = input.getAttribute("type") === "password";
          input.setAttribute("type", isPassword ? "text" : "password");
        },
        { signal: abortController.signal },
      );
      appendChildren(wrapper, input, toggle);
      appendChildren(group, label, wrapper);
    } else {
      appendChildren(group, label, input);
    }

    return group;
  }

  function buildTotpOverlay(): HTMLDivElement {
    const overlay = createElement("div", { class: "totp-overlay totp-overlay--hidden" });
    const card = createElement("div", { class: "totp-card" });
    const title = createElement("h2", { class: "totp-title" }, "Two-Factor Authentication");
    const description = createElement("p", {
      class: "totp-subtitle",
    }, "Enter the 6-digit code from your authenticator app.");

    totpInput = createElement("input", {
      class: "form-input",
      type: "text",
      maxlength: "6",
      placeholder: "000000",
      inputmode: "numeric",
      pattern: "[0-9]{6}",
      autocomplete: "one-time-code",
    });

    totpSubmitBtn = createElement("button", {
      class: "btn-primary",
      type: "button",
    }, "Verify");

    const cancelBtn = createElement("button", {
      class: "totp-back",
      type: "button",
    }, "Cancel");

    totpSubmitBtn.addEventListener("click", handleTotpSubmit, { signal: abortController.signal });
    cancelBtn.addEventListener("click", handleTotpCancel, { signal: abortController.signal });

    // Allow Enter key in TOTP input
    totpInput.addEventListener(
      "keydown",
      (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          handleTotpSubmit();
        }
      },
      { signal: abortController.signal },
    );

    appendChildren(card, title, description, totpInput, totpSubmitBtn, cancelBtn);
    overlay.appendChild(card);
    return overlay;
  }

  // ---------------------------------------------------------------------------
  // State transitions
  // ---------------------------------------------------------------------------

  function transitionTo(state: FormState, error?: string): void {
    formState = state;
    errorMessage = error ?? "";

    // Update UI based on state
    updateSubmitButton();
    updateErrorBanner();
    updateStatusBar();
    updateTotpOverlay();
    updateFormInputsDisabled();
  }

  function updateSubmitButton(): void {
    const isLoading = formState === "loading" || formState === "connecting";
    submitBtn.disabled = isLoading;
    submitBtn.classList.toggle("loading", isLoading);

    if (formState === "connecting") {
      setText(submitBtnText, "Connecting\u2026");
    } else if (formState === "loading") {
      setText(submitBtnText, formMode === "login" ? "Logging in\u2026" : "Registering\u2026");
    } else {
      setText(submitBtnText, formMode === "login" ? "Login" : "Register");
    }
  }

  function updateErrorBanner(): void {
    if (formState === "error" && errorMessage) {
      setText(errorBanner, errorMessage);
      errorBanner.classList.add("visible");
      // The shakeX animation plays automatically via CSS on .error-banner
      // Re-trigger animation by removing and re-adding the element
      errorBanner.style.animation = "none";
      // Force reflow to restart animation
      void errorBanner.offsetWidth;
      errorBanner.style.animation = "";
    } else {
      errorBanner.classList.remove("visible");
    }
  }

  function updateStatusBar(): void {
    switch (formState) {
      case "idle":
        statusBar.classList.remove("visible", "indeterminate");
        break;
      case "loading":
        statusBar.classList.add("visible", "indeterminate");
        break;
      case "totp":
        statusBar.classList.remove("visible", "indeterminate");
        break;
      case "connecting":
        statusBar.classList.add("visible", "indeterminate");
        break;
      case "error":
        statusBar.classList.remove("visible", "indeterminate");
        break;
    }
  }

  function updateTotpOverlay(): void {
    if (formState === "totp") {
      totpOverlay.classList.remove("totp-overlay--hidden");
      totpInput.value = "";
      totpInput.focus();
    } else {
      totpOverlay.classList.add("totp-overlay--hidden");
    }
  }

  function updateFormInputsDisabled(): void {
    const disable = formState === "loading" || formState === "connecting";
    hostInput.disabled = disable;
    usernameInput.disabled = disable;
    passwordInput.disabled = disable;
    inviteInput.disabled = disable;
  }

  // ---------------------------------------------------------------------------
  // Event handlers
  // ---------------------------------------------------------------------------

  function handleToggleMode(): void {
    formMode = formMode === "login" ? "register" : "login";

    setText(formTitle, formMode === "login" ? "Login" : "Register");
    setText(submitBtnText, formMode === "login" ? "Login" : "Register");
    setText(
      toggleModeBtn,
      formMode === "login" ? "Need an account? Register" : "Already have an account? Login",
    );

    inviteGroup.classList.toggle("form-group--hidden", formMode === "login");

    // Clear any existing error
    if (formState === "error") {
      transitionTo("idle");
    }
  }

  function validateForm(): string | null {
    const host = hostInput.value.trim();
    const username = usernameInput.value.trim();
    const password = passwordInput.value;

    if (!host) {
      return "Server address is required.";
    }
    if (!username) {
      return "Username is required.";
    }
    if (!password) {
      return "Password is required.";
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
    }
    if (formMode === "register") {
      const inviteCode = inviteInput.value.trim();
      if (!inviteCode) {
        return "Invite code is required for registration.";
      }
    }
    return null;
  }

  async function handleFormSubmit(e: Event): Promise<void> {
    e.preventDefault();

    if (formState === "loading" || formState === "connecting") {
      return;
    }

    const validationError = validateForm();
    if (validationError !== null) {
      transitionTo("error", validationError);
      return;
    }

    const host = hostInput.value.trim();
    const username = usernameInput.value.trim();
    const password = passwordInput.value;

    transitionTo("loading");

    try {
      if (formMode === "login") {
        await callbacks.onLogin(host, username, password);
      } else {
        const inviteCode = inviteInput.value.trim();
        await callbacks.onRegister(host, username, password, inviteCode);
      }
      // If the callback didn't throw, the caller handles navigation.
      // The caller may also call showTotp() or showError() on this page.
    } catch (err: unknown) {
      let message: string;
      if (err instanceof Error) {
        message = err.message;
      } else if (typeof err === "string") {
        message = err;
      } else if (err !== null && typeof err === "object" && "message" in err) {
        message = String((err as { message: unknown }).message);
      } else {
        message = String(err);
      }
      transitionTo("error", message);
    }
  }

  async function handleTotpSubmit(): Promise<void> {
    const code = totpInput.value.trim();
    if (code.length !== 6 || !/^\d{6}$/.test(code)) {
      // Simple inline feedback — add error class to the input
      totpInput.classList.add("error");
      setTimeout(() => totpInput.classList.remove("error"), 500);
      return;
    }

    totpSubmitBtn.disabled = true;
    setText(totpSubmitBtn, "Verifying\u2026");

    try {
      await callbacks.onTotpSubmit(code);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Verification failed.";
      transitionTo("error", message);
    } finally {
      totpSubmitBtn.disabled = false;
      setText(totpSubmitBtn, "Verify");
    }
  }

  function handleTotpCancel(): void {
    transitionTo("idle");
  }

  // ---------------------------------------------------------------------------
  // Public API for external state control
  // ---------------------------------------------------------------------------

  /** Called externally when login returns requires_2fa. */
  function showTotp(): void {
    transitionTo("totp");
  }

  /** Called externally to show a connection-in-progress state. */
  function showConnecting(): void {
    transitionTo("connecting");
  }

  /** Called externally to display an error. */
  function showError(message: string): void {
    transitionTo("error", message);
  }

  /** Reset form to idle state. */
  function resetToIdle(): void {
    transitionTo("idle");
  }

  // ---------------------------------------------------------------------------
  // MountableComponent
  // ---------------------------------------------------------------------------

  // Settings overlay instance
  let settingsOverlay: ReturnType<typeof createSettingsOverlay> | null = null;

  function mount(target: Element): void {
    container = target;
    const rootEl = buildRoot();
    container.appendChild(rootEl);

    // Mount settings overlay on the connect page
    settingsOverlay = createSettingsOverlay({
      onClose: () => closeSettings(),
      onChangePassword: async () => { /* no-op on connect page */ },
      onUpdateProfile: async () => { /* no-op on connect page */ },
      onLogout: () => { /* no-op on connect page */ },
    });
    settingsOverlay.mount(rootEl);

    // Focus the first input
    hostInput.focus();
  }

  function destroy(): void {
    // Abort all event listeners registered with the signal
    abortController.abort();
    settingsOverlay?.destroy?.();
    settingsOverlay = null;

    if (container && root) {
      container.removeChild(root);
    }
    container = null;
  }

  return {
    mount,
    destroy,
    // Extended API for external control
    showTotp,
    showConnecting,
    showError,
    resetToIdle,
    updateHealthStatus,
  };
}

export type ConnectPage = ReturnType<typeof createConnectPage>;
