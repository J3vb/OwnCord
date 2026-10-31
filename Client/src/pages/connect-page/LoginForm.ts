// LoginForm — login/register form sub-component for ConnectPage.
// Pure extraction from ConnectPage.ts. No behavior changes.

import { createElement, setText } from "@lib/dom";
import { normalizeHostForCertCompare } from "@lib/net/hostNormalize";
import type { RegistrationMode } from "@lib/types";
import { connectText } from "../../i18n/connect";
import { SAVED_PASSWORD_PLACEHOLDER } from "./login-form/loginShared";
import type { LoginFormState, LoginFormInternals } from "./login-form/loginState";
import { createLoginFormDom } from "./login-form/loginFormDom";
import { createLoginFormView } from "./login-form/loginFormView";
import { createLoginFormSubmit } from "./login-form/loginFormSubmit";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Form state machine states. */
export type FormState = "idle" | "loading" | "totp" | "connecting" | "error" | "auto-connecting";

/** Form mode: login or register. */
export type FormMode = "login" | "register";

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
  /**
   * Recover an account with a recovery kit secret or an owner-issued
   * recovery credential, setting a new password. On success the caller signs
   * the returned session in exactly as a login does. Without it, the form
   * offers no recovery entry.
   */
  readonly onRecover?: (
    host: string,
    username: string,
    secret: string,
    newPassword: string,
  ) => Promise<void>;
  readonly onSettingsOpen: () => void;
  readonly onAutoLoginCancel?: () => void;
  /**
   * The registration mode the server reported for a host, or null when it is
   * unknown (an older server, a failed read, an unrecognised value). Null is
   * treated exactly like `invite`: a code is required. Registration is never
   * widened on an unreadable mode.
   */
  readonly getRegistrationMode?: (host: string) => RegistrationMode | null;
  /** The server-default retention sentence for a host, shown at sign-up;
   *  null when unknown, and then nothing is shown. */
  readonly getRetentionNotice?: (host: string) => string | null;
  /** The host box settled (debounced) in register mode, or register mode was
   *  entered with a host typed; lets the owner fetch that host's mode. */
  readonly onHostSettled?: (host: string) => void;
  /** The host box was edited; the owner may apply a matching saved profile's settings. */
  readonly onHostInput?: (host: string) => void;
  /** The saved hosts, so a typed address that differs only in case keeps the saved spelling. */
  readonly getSavedHosts?: () => readonly string[];
  /**
   * The one host this page signs in to (the web portal). Read only
   * in `__OWNCORD_WEB__` builds: the host box is filled and hidden, a host
   * given later is ignored, and the form offers "Stay signed in" only.
   */
  readonly fixedHost?: string;
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
  /** "Waiting for <server>… Cancel" while a down server is re-probed; the form stays usable. */
  showServerWait(serverName: string, host: string): void;
  /** Report a cancel when waiting on a server other than `host`. */
  cancelServerWaitUnless(host: string): void;
  /** Hide the waiting line without reporting a cancel. */
  hideServerWait(): void;
  showError(message: string): void;
  /** Drop the error banner when it shows exactly `message` (null never matches). */
  clearError(message: string | null): void;
  /** A non-error, informational message (e.g. pending approval) shown as a
   *  notice rather than the red error banner. */
  showNotice(message: string): void;
  resetToIdle(): void;
  getRememberPassword(): boolean;
  /** Whether the auto-connect checkbox is ticked. */
  getAutoConnect(): boolean;
  /** Set the auto-connect (stay signed in) checkbox. Independent of remember-password. */
  setAutoConnect(enabled: boolean): void;
  /** Set the remember-password checkbox. */
  setRememberPassword(enabled: boolean): void;
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
  /** Resubmit a sign-in the desktop proxy refused because `host`'s certificate
   *  was not confirmed yet. `host` is the accepted certificate's normalized host. */
  resubmitAfterCertAccept(host: string): void;
  destroy(): void;
}

export function createLoginForm(opts: LoginFormOptions): LoginFormApi {
  const {
    signal,
    onLogin,
    onLoginWithSavedPassword,
    onRegister,
    onTotpSubmit,
    onRecover,
    onSettingsOpen,
    onAutoLoginCancel,
    getRegistrationMode,
    getRetentionNotice,
    onHostSettled,
    onHostInput,
    getSavedHosts,
  } = opts;

  // Written literally at every use so the desktop build drops each branch.
  const fixedHost = __OWNCORD_WEB__ ? opts.fixedHost : undefined;
  // The DOM references are left out: buildFormPanel and the overlay builders
  // fill them in below, before any handler can read them.
  const st = {
    opts,
    signal,
    onLogin,
    onLoginWithSavedPassword,
    onRegister,
    onTotpSubmit,
    onRecover,
    onSettingsOpen,
    onAutoLoginCancel,
    getRegistrationMode,
    getRetentionNotice,
    onHostSettled,
    onHostInput,
    getSavedHosts,
    fixedHost,
    hostSettledSeq: 0,
    usingSavedPassword: false,
    formState: "idle",
    formMode: "login",
    errorMessage: "",
    noticeMessage: "",
    errorField: null,
    totpPending: false,
    certRefusedSubmit: null,
    focusBeforeBusy: null,
    usernameCap: 0,
    serverWaitHost: "",
    cancelAuthBusyRetry: null,
    recoverCtx: undefined,
  } as LoginFormState;
  const lf = {} as LoginFormInternals;
  Object.assign(
    lf,
    createLoginFormDom(st, lf),
    createLoginFormView(st, lf),
    createLoginFormSubmit(st, lf),
  );

  // ---------------------------------------------------------------------------
  // Build elements (before state transition functions that reference them)
  // ---------------------------------------------------------------------------

  st.panelEl = lf.buildFormPanel();

  // Status bar (hidden by default, shown with .visible class)
  st.statusBar = createElement("div", { class: "status-bar" });

  st.statusBarFill = createElement("div", { class: "status-bar-fill" });

  st.statusBar.appendChild(st.statusBarFill);

  // TOTP overlay (hidden by default)
  st.totpOverlay = lf.buildTotpOverlay();

  // Auto-connect overlay (hidden by default)
  st.autoConnectOverlay = lf.buildAutoConnectOverlay();

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  return {
    element: st.panelEl,
    statusBarElement: st.statusBar,
    totpOverlayElement: st.totpOverlay,
    autoConnectOverlayElement: st.autoConnectOverlay,

    showTotp(): void {
      st.totpPending = true;
      lf.transitionTo("totp");
    },

    showConnecting(): void {
      lf.transitionTo("connecting");
    },

    showAutoConnecting(serverName: string): void {
      setText(st.autoConnectServerName, serverName);
      lf.transitionTo("auto-connecting");
    },

    showServerWait(serverName: string, host: string): void {
      setText(st.serverWaitText, connectText("login.waitingForServer", { server: serverName }));
      st.serverWaitHost = host;
      st.serverWait.hidden = false;
    },

    cancelServerWaitUnless(host: string): void {
      if (host !== st.serverWaitHost) lf.cancelServerWait();
    },

    hideServerWait(): void {
      st.serverWait.hidden = true;
    },

    showError(message: string): void {
      lf.transitionTo("error", message);
    },

    clearError(message: string | null): void {
      if (st.formState === "error" && message !== null && st.errorMessage === message) {
        lf.transitionTo("idle");
      }
    },

    showNotice(message: string): void {
      // A notice supersedes any error banner, and the form stays usable.
      lf.transitionTo("idle");
      st.noticeMessage = message;
      lf.updateInfoNotice();
    },

    resetToIdle(): void {
      st.totpPending = false;
      lf.transitionTo("idle");
    },

    getRememberPassword(): boolean {
      return st.rememberPasswordCheckbox?.checked ?? false;
    },

    getAutoConnect(): boolean {
      return st.autoConnectCheckbox?.checked ?? false;
    },

    setAutoConnect(enabled: boolean): void {
      st.autoConnectCheckbox.checked = enabled;
    },

    setRememberPassword(enabled: boolean): void {
      if (__OWNCORD_WEB__ && st.fixedHost !== undefined) return;
      st.rememberPasswordCheckbox.checked = enabled;
    },

    getPassword(): string {
      // Never hand back the placeholder. Callers use this to decide what to
      // persist, and "" means "nothing new to save" — save_credential then
      // preserves the password already in the credential store.
      if (st.usingSavedPassword) return "";
      return st.passwordInput?.value ?? "";
    },

    setHost(host: string): void {
      if (__OWNCORD_WEB__ && st.fixedHost !== undefined) return;
      st.certRefusedSubmit = null;
      lf.writeHost(host);
      // The host's registration mode may differ from the previous one.
      lf.updateRegistrationUi();
    },

    refreshRegistrationMode(): void {
      lf.updateRegistrationUi();
    },

    setCredentials(username: string, hasSavedPassword?: boolean): void {
      st.certRefusedSubmit = null;
      st.usernameInput.value = username;
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
      if (hasSavedPassword && st.formMode === "login") {
        // Show the box as filled — the user ticked "Remember password" and
        // expects exactly that — without the plaintext ever being here.
        st.usingSavedPassword = true;
        st.passwordInput.value = SAVED_PASSWORD_PLACEHOLDER;
        st.rememberPasswordCheckbox.checked = true;
      } else {
        lf.clearSavedPasswordPlaceholder();
      }
    },

    isUsingSavedPassword(): boolean {
      return st.usingSavedPassword;
    },

    /**
     * Pre-fill the register form from an owncord:// invite deep link and switch
     * to register mode. Host is optional — the link may carry only the code, in
     * which case the user still needs to enter the server address.
     */
    applyInviteLink(code: string, host?: string): void {
      const hostFixed = __OWNCORD_WEB__ && st.fixedHost !== undefined;
      if (host && !hostFixed) lf.writeHost(host);
      if (st.formMode !== "register") lf.handleToggleMode();
      st.inviteInput.value = code;
      lf.updateRegistrationUi();
      // Focus the first field the user still has to fill in.
      if (host || hostFixed) st.usernameInput.focus();
      else st.hostInput.focus();
    },

    getHost(): string {
      return st.hostInput === undefined ? "" : lf.currentHost();
    },

    focusHost(): void {
      // A touch screen opens its keyboard on focus, covering the saved servers.
      if (typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches)
        return;
      if (__OWNCORD_WEB__ && st.fixedHost !== undefined) st.usernameInput.focus();
      else st.hostInput.focus();
    },

    resubmitAfterCertAccept(host: string): void {
      const refused = st.certRefusedSubmit;
      if (refused === null || normalizeHostForCertCompare(refused.host) !== host) return;
      st.certRefusedSubmit = null;
      // The user may have moved on since: another server, the other mode, or
      // a submit of their own already under way.
      if (st.formState !== "error" || st.formMode !== refused.mode) return;
      if (lf.currentHost() !== refused.host) return;
      void lf.handleFormSubmit(new Event("submit"));
    },

    destroy(): void {
      // Cleanup is handled by the shared AbortSignal from the parent
    },
  };
}
