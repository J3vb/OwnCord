// LoginForm — login/register form sub-component for ConnectPage.
// Pure extraction from ConnectPage.ts. No behavior changes.

import { createElement, setText, appendChildren, qs } from "@lib/dom";
import { createIcon } from "@lib/icons";
import type { RegistrationMode } from "@lib/types";

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

// The password box shows this when a saved password exists. It is never sent
// anywhere: submission branches on `usingSavedPassword`, never on the field's
// text, so this string can never be mistaken for a real password.
const SAVED_PASSWORD_PLACEHOLDER = "•".repeat(12);

/**
 * Copy shown in the register notice for a mode, or null when no notice
 * applies. `closed` states why register is refused; `approval` states the
 * pending-approval fact up front, not only after a 202.
 */
function registrationNoticeText(mode: RegistrationMode | null): string | null {
  if (mode === "closed") {
    return "Registration is closed on this server.";
  }
  if (mode === "approval") {
    return "Registration requires admin approval. You can register now, but an admin must approve your account before you can sign in.";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Options & Return type
// ---------------------------------------------------------------------------

export interface LoginFormOptions {
  readonly signal: AbortSignal;
  readonly onLogin: (host: string, username: string, password: string) => Promise<void>;
  /** Log in with the password held in the OS credential store. Used when
   *  the password box shows the saved-password placeholder, so the
   *  plaintext never has to exist in JavaScript. */
  readonly onLoginWithSavedPassword: (host: string, username: string) => Promise<void>;
  readonly onRegister: (
    host: string,
    username: string,
    password: string,
    inviteCode: string,
  ) => Promise<void>;
  readonly onTotpSubmit: (code: string) => Promise<void>;
  readonly onSettingsOpen: () => void;
  readonly onAutoLoginCancel?: () => void;
  /**
   * The registration mode the server reported for a host, or null when it is
   * unknown (an older server, a failed read, an unrecognised value). Null is
   * treated exactly like `invite`: a code is required. Registration is never
   * widened on an unreadable mode.
   */
  readonly getRegistrationMode?: (host: string) => RegistrationMode | null;
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
  /** Whether the auto-connect checkbox is ticked. */
  getAutoConnect(): boolean;
  /** Set the auto-connect checkbox (also forces remember-password on). */
  setAutoConnect(enabled: boolean): void;
  getPassword(): string;
  /** Set the host input value (called when ServerPanel clicks a server). */
  setHost(host: string): void;
  /** Re-derive the register affordances from the host's registration mode
   *  (call after a late `server-info` snapshot arrives for the selected host). */
  refreshRegistrationMode(): void;
  /** Set credentials (called for auto-fill from profile or credential store).
   *  `hasSavedPassword` fills the password box with a placeholder rather than
   *  a real password — the plaintext stays in the Rust backend. */
  setCredentials(username: string, hasSavedPassword?: boolean): void;
  /** Whether the password box currently holds the saved-password placeholder. */
  isUsingSavedPassword(): boolean;
  /** Pre-fill + switch to register mode from an owncord:// invite deep link. */
  applyInviteLink(code: string, host?: string): void;
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
  const {
    signal,
    onLogin,
    onLoginWithSavedPassword,
    onRegister,
    onTotpSubmit,
    onSettingsOpen,
    onAutoLoginCancel,
    getRegistrationMode,
  } = opts;

  let usingSavedPassword = false;

  /** Drop the placeholder the moment the user edits the field. */
  function clearSavedPasswordPlaceholder(): void {
    if (!usingSavedPassword) return;
    usingSavedPassword = false;
    // Only wipe the field if it still holds the placeholder. `beforeinput`
    // runs before the edit lands, so the field is still the placeholder
    // there and this clears it so the edit lands in an empty field. The
    // `input` backstop runs after a password manager has already replaced
    // the value with the real password it wants to submit — wiping that
    // unconditionally would blank a required field and block the login the
    // manager was trying to help with.
    if (passwordInput.value === SAVED_PASSWORD_PLACEHOLDER) {
      passwordInput.value = "";
    }
  }

  // --- internal state ---
  let formState: FormState = "idle";
  let formMode: FormMode = "login";
  let errorMessage = "";
  // True while a TOTP challenge is outstanding (from showTotp() until it is
  // cancelled or resolved). A rejected verify moves formState to "error" for
  // the banner/shake, but the overlay must stay up so the code can be
  // re-entered — see updateTotpOverlay().
  let totpPending = false;

  // --- cached DOM references ---
  let formTitle: HTMLHeadingElement;
  let hostInput: HTMLInputElement;
  let usernameInput: HTMLInputElement;
  let passwordInput: HTMLInputElement;
  let inviteGroup: HTMLDivElement;
  let inviteInput: HTMLInputElement;
  let registrationNotice: HTMLDivElement;
  let submitBtn: HTMLButtonElement;
  let submitBtnText: HTMLSpanElement;
  let toggleModeBtn: HTMLAnchorElement;
  let errorBanner: HTMLDivElement;
  let totpInput: HTMLInputElement;
  let totpSubmitBtn: HTMLButtonElement;
  let rememberPasswordCheckbox: HTMLInputElement;
  let autoConnectCheckbox: HTMLInputElement;
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
    grad.setAttribute("x1", "0%");
    grad.setAttribute("y1", "0%");
    grad.setAttribute("x2", "100%");
    grad.setAttribute("y2", "0%");
    for (const [offset, color] of [
      ["0%", "#f97316"],
      ["30%", "#ec4899"],
      ["65%", "#8b5cf6"],
      ["100%", "#06b6d4"],
    ] as const) {
      const stop = document.createElementNS("http://www.w3.org/2000/svg", "stop");
      stop.setAttribute("offset", offset);
      stop.setAttribute("style", `stop-color:${color}`);
      grad.appendChild(stop);
    }
    const filter = document.createElementNS("http://www.w3.org/2000/svg", "filter");
    filter.setAttribute("id", "oc-glow-form");
    const blur = document.createElementNS("http://www.w3.org/2000/svg", "feGaussianBlur");
    blur.setAttribute("stdDeviation", "4");
    blur.setAttribute("result", "blur");
    filter.appendChild(blur);
    const comp = document.createElementNS("http://www.w3.org/2000/svg", "feComposite");
    comp.setAttribute("in", "SourceGraphic");
    comp.setAttribute("in2", "blur");
    comp.setAttribute("operator", "over");
    filter.appendChild(comp);
    defs.appendChild(grad);
    defs.appendChild(filter);
    logoSvg.appendChild(defs);
    for (const [opacity, filterAttr] of [
      ["0.4", "url(#oc-glow-form)"],
      [null, null],
    ] as const) {
      const t = document.createElementNS("http://www.w3.org/2000/svg", "text");
      t.setAttribute("x", "60");
      t.setAttribute("y", "56");
      t.setAttribute("text-anchor", "middle");
      t.setAttribute("font-family", "'Segoe UI',system-ui,sans-serif");
      t.setAttribute("font-size", "68");
      t.setAttribute("font-weight", "900");
      t.setAttribute("fill", "url(#oc-grad-form)");
      t.setAttribute("letter-spacing", "-4");
      if (opacity) {
        t.setAttribute("opacity", opacity);
        t.setAttribute("class", "oc-glow-layer");
      }
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
    hostInput = qs("input", hostGroup)!;
    // Registration policy is per host, so a manually edited address re-derives
    // the mode (and the invite requirement) as the user types.
    hostInput.addEventListener("input", updateRegistrationUi, { signal });

    // Username
    const usernameGroup = buildFormGroup("username", "Username", "text", "");
    usernameInput = qs("input", usernameGroup)!;

    // Password
    const passwordGroup = buildFormGroup("password", "Password", "password", "");
    passwordInput = qs("input", passwordGroup)!;

    // Remember password checkbox
    const rememberGroup = createElement("div", { class: "form-group remember-password-group" });
    rememberPasswordCheckbox = createElement("input", {
      type: "checkbox",
      id: "remember-password",
    });
    const rememberLabel = createElement(
      "label",
      {
        for: "remember-password",
        class: "remember-password-label",
      },
      "Remember password",
    );
    appendChildren(rememberGroup, rememberPasswordCheckbox, rememberLabel);

    // Auto connect checkbox
    const autoConnectGroup = createElement("div", { class: "form-group remember-password-group" });
    autoConnectCheckbox = createElement("input", { type: "checkbox", id: "auto-connect" });
    const autoConnectLabel = createElement(
      "label",
      {
        for: "auto-connect",
        class: "remember-password-label",
      },
      "Auto connect",
    );
    appendChildren(autoConnectGroup, autoConnectCheckbox, autoConnectLabel);

    // `beforeinput` fires for every actual edit — typing, paste, drag-drop —
    // and only for edits, so caret movement leaves the placeholder alone. It
    // runs before the value changes, so clearing there means the edit lands in
    // an empty field instead of mixing with the placeholder.
    //
    // `input` is the backstop: a password manager can replace the value and
    // emit only `input`, and leaving the flag set there would submit the stored
    // password while the field shows the one the manager just filled in. It is
    // a no-op after `beforeinput` has already cleared the flag, so it cannot
    // swallow a typed character.
    passwordInput.addEventListener("beforeinput", clearSavedPasswordPlaceholder, { signal });
    passwordInput.addEventListener("input", clearSavedPasswordPlaceholder, { signal });

    autoConnectCheckbox.addEventListener(
      "change",
      () => {
        // Auto-connect replays the saved token, which only exists when the
        // password is remembered — so the pairing is enforced, not suggested.
        if (autoConnectCheckbox.checked) rememberPasswordCheckbox.checked = true;
        rememberPasswordCheckbox.disabled = autoConnectCheckbox.checked;
      },
      { signal },
    );

    // Invite code (register only, hidden by default)
    inviteGroup = buildFormGroup("invite", "Invite Code", "text", "");
    inviteGroup.classList.add("form-group--hidden");
    inviteInput = qs("input", inviteGroup)!;

    // Registration notice (register only): states the server's policy up
    // front for `closed` (why register is refused) and `approval` (the
    // pending-approval state, shown before the attempt rather than only after
    // a 202). Hidden by default.
    registrationNotice = createElement("div", {
      class: "registration-notice",
      role: "status",
    });

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
    toggleModeBtn = createElement("a", {}, "Need an account? Register");
    formSwitch.appendChild(toggleModeBtn);

    appendChildren(
      form,
      hostGroup,
      usernameGroup,
      passwordGroup,
      rememberGroup,
      autoConnectGroup,
      registrationNotice,
      inviteGroup,
      submitBtn,
      formSwitch,
    );

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
    const description = createElement(
      "p",
      {
        class: "totp-subtitle",
      },
      "Enter the 6-digit code from your authenticator app.",
    );

    totpInput = createElement("input", {
      class: "form-input",
      type: "text",
      maxlength: "6",
      placeholder: "000000",
      inputmode: "numeric",
      pattern: "[0-9]{6}",
      autocomplete: "one-time-code",
    });

    totpSubmitBtn = createElement(
      "button",
      {
        class: "btn-primary",
        type: "button",
      },
      "Verify",
    );

    const cancelBtn = createElement(
      "button",
      {
        class: "totp-back",
        type: "button",
      },
      "Cancel",
    );

    totpSubmitBtn.addEventListener("click", handleTotpSubmit, { signal });
    cancelBtn.addEventListener("click", handleTotpCancel, { signal });

    // Allow Enter key in TOTP input
    totpInput.addEventListener(
      "keydown",
      (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          void handleTotpSubmit();
        }
      },
      { signal },
    );

    appendChildren(card, title, description, totpInput, totpSubmitBtn, cancelBtn);
    overlay.appendChild(card);
    return overlay;
  }

  function buildAutoConnectOverlay(): HTMLDivElement {
    const overlay = createElement("div", {
      class: "auto-connect-overlay auto-connect-overlay--hidden",
    });
    const card = createElement("div", { class: "auto-connect-card" });

    const spinner = createElement("div", { class: "auto-connect-spinner" });
    const spinnerEl = createElement("div", { class: "spinner" });
    spinner.appendChild(spinnerEl);

    const title = createElement("h2", { class: "auto-connect-title" }, "Auto-connecting...");
    autoConnectServerName = createElement("span", { class: "auto-connect-server" });

    const cancelBtn = createElement(
      "button",
      {
        class: "btn-ghost auto-connect-cancel",
        type: "button",
      },
      "Cancel",
    );

    cancelBtn.addEventListener(
      "click",
      () => {
        transitionTo("idle");
        onAutoLoginCancel?.();
      },
      { signal },
    );

    appendChildren(card, spinner, title, autoConnectServerName, cancelBtn);
    overlay.appendChild(card);
    return overlay;
  }

  // ---------------------------------------------------------------------------
  // Build elements (before state transition functions that reference them)
  // ---------------------------------------------------------------------------

  const panelEl = buildFormPanel();

  // Status bar (hidden by default, shown with .visible class)
  const statusBar = createElement("div", { class: "status-bar" });
  const statusBarFill = createElement("div", { class: "status-bar-fill" });
  statusBar.appendChild(statusBarFill);

  // TOTP overlay (hidden by default)
  const totpOverlay = buildTotpOverlay();

  // Auto-connect overlay (hidden by default)
  const autoConnectOverlay = buildAutoConnectOverlay();

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
    const isLoading =
      formState === "loading" || formState === "connecting" || formState === "auto-connecting";
    // A closed server refuses registration outright — disable the control and
    // let the notice state why, rather than collecting a doomed attempt.
    const refused = isRegisterRefused();
    submitBtn.disabled = isLoading || refused;
    submitBtn.classList.toggle("loading", isLoading);

    if (formState === "connecting" || formState === "auto-connecting") {
      setText(submitBtnText, "Connecting\u2026");
    } else if (formState === "loading") {
      setText(submitBtnText, formMode === "login" ? "Logging in\u2026" : "Registering\u2026");
    } else if (refused) {
      setText(submitBtnText, "Registration closed");
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
    } else if (formState === "error" && totpPending) {
      // A rejected verify lands here — keep the overlay up (and the
      // already-entered code in place) instead of dropping the user back on
      // the login form with no way to retry.
      totpOverlay.classList.remove("totp-overlay--hidden");
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
    const disable =
      formState === "loading" || formState === "connecting" || formState === "auto-connecting";
    hostInput.disabled = disable;
    usernameInput.disabled = disable;
    passwordInput.disabled = disable;
    inviteInput.disabled = disable;
  }

  // ---------------------------------------------------------------------------
  // Registration mode (B7-15a)
  // ---------------------------------------------------------------------------

  /**
   * The live registration mode for the currently-typed host, or null when it
   * is unknown. Only `invite` and null require an invite code; unknown is
   * deliberately treated as invite-required, never as `open`.
   */
  function currentRegistrationMode(): RegistrationMode | null {
    const host = hostInput.value.trim();
    if (!host) return null;
    return getRegistrationMode?.(host) ?? null;
  }

  function isRegisterRefused(): boolean {
    return formMode === "register" && currentRegistrationMode() === "closed";
  }

  /**
   * Bring the register affordances in line with the selected host's mode:
   * the invite field is shown only when a code is actually needed, the notice
   * states `closed`/`approval` up front, and `closed` disables the submit
   * control. Idempotent and cheap; call it whenever the mode may have changed
   * (host edit, mode toggle, a late server-info snapshot).
   */
  function updateRegistrationUi(): void {
    const registering = formMode === "register";
    const mode = registering ? currentRegistrationMode() : null;
    const requiresInvite = mode === "invite" || mode === null;

    inviteGroup.classList.toggle("form-group--hidden", !(registering && requiresInvite));

    const text = registering ? registrationNoticeText(mode) : null;
    if (text !== null) {
      setText(registrationNotice, text);
      registrationNotice.classList.add("visible");
    } else {
      setText(registrationNotice, "");
      registrationNotice.classList.remove("visible");
    }

    updateSubmitButton();
  }

  // ---------------------------------------------------------------------------
  // Event handlers
  // ---------------------------------------------------------------------------

  function handleToggleMode(): void {
    formMode = formMode === "login" ? "register" : "login";

    // A remembered password belongs to an EXISTING account. Carrying the
    // placeholder into Register would submit a fixed, publicly known constant
    // as the new account's password, because only the login branch consults
    // `usingSavedPassword`.
    clearSavedPasswordPlaceholder();

    setText(formTitle, formMode === "login" ? "Login" : "Register");
    setText(submitBtnText, formMode === "login" ? "Login" : "Register");
    setText(
      toggleModeBtn,
      formMode === "login" ? "Need an account? Register" : "Already have an account? Login",
    );

    updateRegistrationUi();

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
    // A saved password is already known-good; it is never re-validated here
    // because its plaintext is not available to this process. The bypass is
    // login-only: registration always needs a real, freshly typed password.
    if (!usingSavedPassword || formMode !== "login") {
      if (!password) {
        return "Password is required.";
      }
      if (password.length < MIN_PASSWORD_LENGTH) {
        return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
      }
    }
    if (formMode === "register") {
      // The placeholder can re-enter the field as literal text (reveal it,
      // copy the bullets, paste them back — `beforeinput` clears the flag
      // before the paste lands), with nothing left marking it as anything
      // but ordinary text. Registration is the only place that turns that
      // text into a lasting, guessable credential, so it is the only place
      // it is refused — statelessly, because gating this on remembered
      // history (whether the field had shown the placeholder before) was
      // wrong in both directions.
      if (password === SAVED_PASSWORD_PLACEHOLDER) {
        return "That is the saved-password placeholder, not a password. Choose a different one.";
      }
      const mode = currentRegistrationMode();
      if (mode === "closed") {
        return "Registration is closed on this server.";
      }
      // `invite` and an unknown mode (older server / failed read) both require
      // a code. Never widen registration because the mode could not be read.
      if (mode === "invite" || mode === null) {
        const inviteCode = inviteInput.value.trim();
        if (!inviteCode) {
          return "Invite code is required for registration.";
        }
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
        if (usingSavedPassword) {
          await onLoginWithSavedPassword(host, username);
        } else {
          await onLogin(host, username, password);
        }
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
        message = String(err.message);
      } else {
        message = String(err);
      }
      // Cap length to prevent phishing via server-controlled error messages
      if (message.length > 200) {
        message = message.slice(0, 200) + "...";
      }
      transitionTo("error", message);
    }
  }

  async function handleTotpSubmit(): Promise<void> {
    // Re-entrancy guard: the click path is protected by the button's
    // disabled attribute, but the Enter-key listener on totpInput (below) is
    // not — key auto-repeat or a fast double-Enter during the verify round
    // trip would otherwise fire a second request with the same one-time code,
    // which the server 401s (codes are single-use) and paints a spurious
    // "invalid two-factor code" error over a login that already succeeded.
    // The disabled flag already brackets exactly the in-flight window, so
    // reusing it covers both paths with one check.
    if (totpSubmitBtn.disabled) return;

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
      // Verify succeeded — the challenge is resolved, so drop the latch.
      // Otherwise any later, unrelated error (e.g. the post-auth WS connect
      // failing) would hit the `formState === "error" && totpPending` branch
      // in updateTotpOverlay() and re-open this now-dead overlay, whose
      // partial token has already been consumed by main.ts.
      totpPending = false;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Verification failed.";
      transitionTo("error", message);
    } finally {
      totpSubmitBtn.disabled = false;
      setText(totpSubmitBtn, "Verify");
    }
  }

  function handleTotpCancel(): void {
    totpPending = false;
    transitionTo("idle");
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  return {
    element: panelEl,
    statusBarElement: statusBar,
    totpOverlayElement: totpOverlay,
    autoConnectOverlayElement: autoConnectOverlay,

    showTotp(): void {
      totpPending = true;
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
      totpPending = false;
      transitionTo("idle");
    },

    getRememberPassword(): boolean {
      return rememberPasswordCheckbox?.checked ?? false;
    },

    getAutoConnect(): boolean {
      return autoConnectCheckbox?.checked ?? false;
    },

    setAutoConnect(enabled: boolean): void {
      autoConnectCheckbox.checked = enabled;
      if (enabled) rememberPasswordCheckbox.checked = true;
      rememberPasswordCheckbox.disabled = enabled;
    },

    getPassword(): string {
      // Never hand back the placeholder. Callers use this to decide what to
      // persist, and "" means "nothing new to save" — save_credential then
      // preserves the password already in the credential store.
      if (usingSavedPassword) return "";
      return passwordInput?.value ?? "";
    },

    setHost(host: string): void {
      hostInput.value = host;
      // The host's registration mode may differ from the previous one.
      updateRegistrationUi();
    },

    refreshRegistrationMode(): void {
      updateRegistrationUi();
    },

    setCredentials(username: string, hasSavedPassword?: boolean): void {
      usernameInput.value = username;
      // The placeholder only ever belongs to LOGGING IN to an existing
      // account. Registration reads the password field as typed text, so a
      // placeholder there would be submitted as the new account's password —
      // a fixed, publicly known constant.
      //
      // The mode is checked HERE, not only when the user switches modes,
      // because this runs from an async credential load: it can resolve after
      // a switch to Register, or fire while Register is already showing
      // (clicking a server row does not force the form back to login). Both
      // orderings re-arm the placeholder if this is guarded anywhere else.
      if (hasSavedPassword && formMode === "login") {
        // Show the box as filled — the user ticked "Remember password" and
        // expects exactly that — without the plaintext ever being here.
        usingSavedPassword = true;
        passwordInput.value = SAVED_PASSWORD_PLACEHOLDER;
        rememberPasswordCheckbox.checked = true;
      } else {
        clearSavedPasswordPlaceholder();
      }
    },

    isUsingSavedPassword(): boolean {
      return usingSavedPassword;
    },

    /**
     * Pre-fill the register form from an owncord:// invite deep link and switch
     * to register mode. Host is optional — the link may carry only the code, in
     * which case the user still needs to enter the server address.
     */
    applyInviteLink(code: string, host?: string): void {
      if (host) hostInput.value = host;
      if (formMode !== "register") handleToggleMode();
      inviteInput.value = code;
      updateRegistrationUi();
      // Focus the first field the user still has to fill in.
      if (host) usernameInput.focus();
      else hostInput.focus();
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
