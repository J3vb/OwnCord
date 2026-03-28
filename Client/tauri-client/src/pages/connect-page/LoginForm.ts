// LoginForm — login/register form sub-component for ConnectPage.
// Pure extraction from ConnectPage.ts. No behavior changes.

import {
  createElement,
  setText,
  appendChildren,
  qs,
} from "@lib/dom";
import { createIcon } from "@lib/icons";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Form state machine states. */
export type FormState = "idle" | "loading" | "totp" | "connecting" | "error" | "auto-connecting";

/** Form mode: login or register. */
export type FormMode = "login" | "register";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MIN_PASSWORD_LENGTH = 8;

// ---------------------------------------------------------------------------
// Options & Return type
// ---------------------------------------------------------------------------

export interface LoginFormOptions {
  readonly signal: AbortSignal;
  readonly onLogin: (host: string, username: string, password: string) => Promise<void>;
  readonly onRegister: (
    host: string,
    username: string,
    password: string,
    inviteCode: string,
  ) => Promise<void>;
  readonly onTotpSubmit: (code: string) => Promise<void>;
  readonly onSettingsOpen: () => void;
  readonly onAutoLoginCancel?: () => void;
}

export interface LoginFormApi {
  /** The form panel DOM element. */
  readonly element: HTMLDivElement;
  /** The status bar element (mounted separately at bottom of page). */
  readonly statusBarElement: HTMLDivElement;
  /** The TOTP overlay element (mounted separately). */
  readonly totpOverlayElement: HTMLDivElement;
  /** The auto-connecting overlay element (mounted separately). */
  readonly autoConnectOverlayElement: HTMLDivElement;
  showTotp(): void;
  showConnecting(): void;
  showAutoConnecting(serverName: string): void;
  showError(message: string): void;
  resetToIdle(): void;
  getRememberPassword(): boolean;
  getPassword(): string;
  /** Set the host input value (called when ServerPanel clicks a server). */
  setHost(host: string): void;
  /** Set credentials (called for auto-fill from profile or credential store). */
  setCredentials(username: string, password?: string): void;
  /** Get host input value (for guard checks). */
  getHost(): string;
  /** Focus the host input. */
  focusHost(): void;
  destroy(): void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createLoginForm(opts: LoginFormOptions): LoginFormApi {
  const { signal, onLogin, onRegister, onTotpSubmit, onSettingsOpen, onAutoLoginCancel } = opts;

  // --- internal state ---
  let formState: FormState = "idle";
  let formMode: FormMode = "login";
  let errorMessage = "";

  // --- cached DOM references ---
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
  let rememberPasswordCheckbox: HTMLInputElement;
  let statusBar: HTMLDivElement;
  let statusBarFill: HTMLDivElement;
  let autoConnectOverlay: HTMLDivElement;
  let autoConnectServerName: HTMLSpanElement;

  // ---------------------------------------------------------------------------
  // DOM construction
  // ---------------------------------------------------------------------------

  function buildFormPanel(): HTMLDivElement {
    const panel = createElement("div", { class: "form-panel" });

    // Settings gear (top right)
    const settingsBtn = createElement("button", {
      class: "settings-gear",
      type: "button",
      "aria-label": "Settings",
    });
    settingsBtn.textContent = "";
    settingsBtn.appendChild(createIcon("settings", 16));
    settingsBtn.addEventListener("click", () => onSettingsOpen(), { signal });

    // Form container
    const formContainer = createElement("div", { class: "form-container" });

    // Logo section — OC neon glow SVG
    const formLogo = createElement("div", { class: "form-logo" });
    const logoSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    logoSvg.setAttribute("width", "70");
    logoSvg.setAttribute("height", "42");
    logoSvg.setAttribute("viewBox", "0 0 120 70");
    logoSvg.setAttribute("class", "oc-logo");
    const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
    const grad = document.createElementNS("http://www.w3.org/2000/svg", "linearGradient");
    grad.setAttribute("id", "oc-grad-form");
    grad.setAttribute("x1", "0%"); grad.setAttribute("y1", "0%");
    grad.setAttribute("x2", "100%"); grad.setAttribute("y2", "0%");
    for (const [offset, color] of [["0%","#f97316"],["30%","#ec4899"],["65%","#8b5cf6"],["100%","#06b6d4"]] as const) {
      const stop = document.createElementNS("http://www.w3.org/2000/svg", "stop");
      stop.setAttribute("offset", offset);
      stop.setAttribute("style", `stop-color:${color}`);
      grad.appendChild(stop);
    }
    const filter = document.createElementNS("http://www.w3.org/2000/svg", "filter");
    filter.setAttribute("id", "oc-glow-form");
    const blur = document.createElementNS("http://www.w3.org/2000/svg", "feGaussianBlur");
    blur.setAttribute("stdDeviation", "4"); blur.setAttribute("result", "blur");
    filter.appendChild(blur);
    const comp = document.createElementNS("http://www.w3.org/2000/svg", "feComposite");
    comp.setAttribute("in", "SourceGraphic"); comp.setAttribute("in2", "blur"); comp.setAttribute("operator", "over");
    filter.appendChild(comp);
    defs.appendChild(grad); defs.appendChild(filter);
    logoSvg.appendChild(defs);
    for (const [opacity, filterAttr] of [["0.4", "url(#oc-glow-form)"], [null, null]] as const) {
      const t = document.createElementNS("http://www.w3.org/2000/svg", "text");
      t.setAttribute("x", "60"); t.setAttribute("y", "56"); t.setAttribute("text-anchor", "middle");
      t.setAttribute("font-family", "'Segoe UI',system-ui,sans-serif");
      t.setAttribute("font-size", "68"); t.setAttribute("font-weight", "900");
      t.setAttribute("fill", "url(#oc-grad-form)"); t.setAttribute("letter-spacing", "-4");
      if (opacity) { t.setAttribute("opacity", opacity); t.setAttribute("class", "oc-glow-layer"); }
      if (filterAttr) t.setAttribute("filter", filterAttr);
      t.textContent = "OC";
      logoSvg.appendChild(t);
    }
    const logoTitle = createElement("h1", {}, "OwnCord");
    const logoSubtitle = createElement("p", {}, "Connect to your server");
    appendChildren(formLogo, logoSvg, logoTitle, logoSubtitle);

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

    // Remember password checkbox
    const rememberGroup = createElement("div", { class: "form-group remember-password-group" });
    rememberPasswordCheckbox = createElement("input", {
      type: "checkbox",
      id: "remember-password",
    });
    const rememberLabel = createElement("label", {
      for: "remember-password",
      class: "remember-password-label",
    }, "Remember password");
    appendChildren(rememberGroup, rememberPasswordCheckbox, rememberLabel);

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

    appendChildren(form, hostGroup, usernameGroup, passwordGroup, rememberGroup, inviteGroup, submitBtn, formSwitch);

    // Wire form events
    form.addEventListener("submit", handleFormSubmit, { signal });
    toggleModeBtn.addEventListener("click", handleToggleMode, { signal });

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
      });
      toggle.appendChild(createIcon("eye", 16));
      toggle.addEventListener(
        "click",
        () => {
          const isPassword = input.getAttribute("type") === "password";
          input.setAttribute("type", isPassword ? "text" : "password");
          toggle.textContent = "";
          toggle.appendChild(createIcon(isPassword ? "eye-off" : "eye", 16));
        },
        { signal },
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

    totpSubmitBtn.addEventListener("click", handleTotpSubmit, { signal });
    cancelBtn.addEventListener("click", handleTotpCancel, { signal });

    // Allow Enter key in TOTP input
    totpInput.addEventListener(
      "keydown",
      (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          handleTotpSubmit();
        }
      },
      { signal },
    );

    appendChildren(card, title, description, totpInput, totpSubmitBtn, cancelBtn);
    overlay.appendChild(card);
    return overlay;
  }

  function buildAutoConnectOverlay(): HTMLDivElement {
    const overlay = createElement("div", { class: "auto-connect-overlay auto-connect-overlay--hidden" });
    const card = createElement("div", { class: "auto-connect-card" });

    const spinner = createElement("div", { class: "auto-connect-spinner" });
    const spinnerEl = createElement("div", { class: "spinner" });
    spinner.appendChild(spinnerEl);

    const title = createElement("h2", { class: "auto-connect-title" }, "Auto-connecting...");
    autoConnectServerName = createElement("span", { class: "auto-connect-server" });

    const cancelBtn = createElement("button", {
      class: "btn-ghost auto-connect-cancel",
      type: "button",
    }, "Cancel");

    cancelBtn.addEventListener("click", () => {
      transitionTo("idle");
      onAutoLoginCancel?.();
    }, { signal });

    appendChildren(card, spinner, title, autoConnectServerName, cancelBtn);
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
    updateAutoConnectOverlay();
    updateFormInputsDisabled();
  }

  function updateSubmitButton(): void {
    const isLoading = formState === "loading" || formState === "connecting" || formState === "auto-connecting";
    submitBtn.disabled = isLoading;
    submitBtn.classList.toggle("loading", isLoading);

    if (formState === "connecting" || formState === "auto-connecting") {
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
      case "totp":
      case "error":
        statusBar.classList.remove("visible", "indeterminate");
        break;
      case "loading":
      case "connecting":
      case "auto-connecting":
        statusBar.classList.add("visible", "indeterminate");
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

  function updateAutoConnectOverlay(): void {
    if (formState === "auto-connecting") {
      autoConnectOverlay.classList.remove("auto-connect-overlay--hidden");
    } else {
      autoConnectOverlay.classList.add("auto-connect-overlay--hidden");
    }
  }

  function updateFormInputsDisabled(): void {
    const disable = formState === "loading" || formState === "connecting" || formState === "auto-connecting";
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
        await onLogin(host, username, password);
      } else {
        const inviteCode = inviteInput.value.trim();
        await onRegister(host, username, password, inviteCode);
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
      await onTotpSubmit(code);
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
  // Build elements
  // ---------------------------------------------------------------------------

  const panelEl = buildFormPanel();

  // Status bar (hidden by default, shown with .visible class)
  statusBar = createElement("div", { class: "status-bar" });
  statusBarFill = createElement("div", { class: "status-bar-fill" });
  statusBar.appendChild(statusBarFill);

  // TOTP overlay (hidden by default)
  totpOverlay = buildTotpOverlay();

  // Auto-connect overlay (hidden by default)
  autoConnectOverlay = buildAutoConnectOverlay();

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  return {
    element: panelEl,
    statusBarElement: statusBar,
    totpOverlayElement: totpOverlay,
    autoConnectOverlayElement: autoConnectOverlay,

    showTotp(): void {
      transitionTo("totp");
    },

    showConnecting(): void {
      transitionTo("connecting");
    },

    showAutoConnecting(serverName: string): void {
      setText(autoConnectServerName, serverName);
      transitionTo("auto-connecting");
    },

    showError(message: string): void {
      transitionTo("error", message);
    },

    resetToIdle(): void {
      transitionTo("idle");
    },

    getRememberPassword(): boolean {
      return rememberPasswordCheckbox?.checked ?? false;
    },

    getPassword(): string {
      return passwordInput?.value ?? "";
    },

    setHost(host: string): void {
      hostInput.value = host;
    },

    setCredentials(username: string, password?: string): void {
      usernameInput.value = username;
      if (password) {
        passwordInput.value = password;
        rememberPasswordCheckbox.checked = true;
      }
    },

    getHost(): string {
      return hostInput?.value ?? "";
    },

    focusHost(): void {
      hostInput.focus();
    },

    destroy(): void {
      // Cleanup is handled by the shared AbortSignal from the parent
    },
  };
}
