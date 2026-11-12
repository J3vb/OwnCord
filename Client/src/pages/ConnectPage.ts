// ConnectPage — login/register page component.
// Thin composition shell that wires ServerPanel and LoginForm together.

import { Disposable } from "@lib/disposable";
import { createElement, appendChildren, setText } from "@lib/dom";
import type { MountableComponent } from "@lib/text/safeRender";
import { createLogger } from "@lib/logger";
import { openSettings, closeSettings, uiStore, setTransientError } from "@stores/ui.store";
import type { Compatibility, HealthStatus } from "@lib/presence/profiles";
import { PROTOCOL_EPOCH } from "@lib/protocolTypes";
import type { RegistrationMode } from "@lib/types";
import { createServerPanel } from "./connect-page/ServerPanel";
import { createLoginForm } from "./connect-page/LoginForm";
import { createIncompatibleNotice } from "./connect-page/IncompatibleNotice";
import { loadCredential } from "@lib/net/credentials";
import { desktop } from "../platform/desktop";
import { createConnectBranding } from "../features/connection/connectBranding";
import { preAuthSettingsOptions } from "../features/connection/preAuthSettings";

const log = createLogger("ConnectPage");

// ---------------------------------------------------------------------------
// Re-exports (public API must not change)
// ---------------------------------------------------------------------------

export type { SimpleProfile } from "./connect-page/ServerPanel";

import type { SimpleProfile } from "./connect-page/ServerPanel";
import { connectText } from "../i18n/connect";
import { portalText } from "../i18n/portal";

/** Callbacks for external wiring (API integration added later). */
export interface ConnectPageCallbacks {
  onLogin(host: string, username: string, password: string): Promise<void>;
  /** Log in using the password kept in the OS credential store. */
  onLoginWithSavedPassword(host: string, username: string): Promise<void>;
  onRegister(host: string, username: string, password: string, inviteCode: string): Promise<void>;
  onTotpSubmit(code: string): Promise<void>;
  /** Recover with a recovery kit secret or an owner-issued credential. */
  onRecover?(host: string, username: string, secret: string, newPassword: string): Promise<void>;
  onAddProfile?(name: string, host: string): void;
  onDeleteProfile?(profileId: string): void;
  onToggleAutoLogin?(profileId: string, enabled: boolean): void;
  onAutoLoginCancel?(): void;
  /** Mount the client-update banner for a refused/older host (client-older). */
  onUpdateClient?(host: string): void;
  /** The registration mode `server-info` reported for a host, if known. */
  getRegistrationMode?(host: string): RegistrationMode | null;
  /** The retention sentence `server-info` reported for a host, if known. */
  getRetentionNotice?(host: string): string | null;
  /** A typed host settled in register mode; probe its `server-info` if unknown. */
  onHostSettled?(host: string): void;
  /** The name `server-info` reported for a host, if known (the portal card's subtitle). */
  getServerName?(host: string): string | null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const defaultProfiles = (): readonly SimpleProfile[] => [
  { name: connectText("profiles.defaultName"), host: "localhost:8443", synthetic: true },
];

// ---------------------------------------------------------------------------
// ConnectPage
// ---------------------------------------------------------------------------

export function createConnectPage(
  callbacks: ConnectPageCallbacks,
  initialProfiles: readonly SimpleProfile[] = defaultProfiles(),
): MountableComponent & {
  showTotp(): void;
  showConnecting(): void;
  showAutoConnecting(serverName: string): void;
  /** "Waiting for <server>… Cancel"; Cancel, typing and picking another server report `onAutoLoginCancel`. */
  showServerWait(serverName: string, host: string): void;
  hideServerWait(): void;
  showError(message: string): void;
  /** A non-error informational message (pending approval), not the red banner. */
  showNotice(message: string): void;
  resetToIdle(): void;
  updateHealthStatus(host: string, status: HealthStatus): void;
  /** Advisory per-row epoch badge; never disables Connect. */
  updateCompatibility(host: string, compatibility: Compatibility, serverEpoch: number | null): void;
  /** Show the incompatible state for a refused host (WS refusal or selection). */
  showIncompatible(host: string, serverEpoch: number | null, clientEpoch?: number): void;
  getRememberPassword(): boolean;
  /** Whether the auto-connect checkbox is ticked. */
  getAutoConnect(): boolean;
  getPassword(): string;
  /** Whether the password box holds the saved-password placeholder. */
  isUsingSavedPassword(): boolean;
  /** Re-render the server profile list with updated data. */
  refreshProfiles(profiles: readonly SimpleProfile[]): void;
  /** Pre-select a server by host — fills the login form and loads saved credentials. */
  selectServer(
    host: string,
    username?: string,
    autoConnect?: boolean,
    rememberPassword?: boolean,
  ): void;
  /** Pre-fill + switch to register mode from an owncord:// invite deep link. */
  applyInviteLink(code: string, host?: string): void;
  /** Resubmit a sign-in refused because `host`'s certificate was not confirmed yet. */
  resubmitAfterCertAccept(host: string): void;
} {
  let container: Element | null = null;
  let root: HTMLDivElement;

  // The one host a web portal signs in to. Read only behind
  // `__OWNCORD_WEB__`: the server panel is built but not mounted, and a header
  // names the server.
  const fixedHost = __OWNCORD_WEB__ ? (desktop.serverScope.fixedHost ?? undefined) : undefined;

  // Cleanup tracking
  const disposable = new Disposable();
  const { signal } = disposable;

  // --- Create sub-components ---

  let knownProfiles: readonly SimpleProfile[] = initialProfiles;

  const loginForm = createLoginForm({
    signal,
    onLogin: callbacks.onLogin,
    onLoginWithSavedPassword: callbacks.onLoginWithSavedPassword,
    onRegister: callbacks.onRegister,
    onTotpSubmit: callbacks.onTotpSubmit,
    onRecover: callbacks.onRecover,
    onSettingsOpen: () => openSettings(),
    onAutoLoginCancel: callbacks.onAutoLoginCancel,
    getRegistrationMode: callbacks.getRegistrationMode,
    getRetentionNotice: callbacks.getRetentionNotice,
    onHostSettled: callbacks.onHostSettled,
    // A typed host that is a saved profile takes that profile's two flags, so
    // an opted-out profile is not overridden by the defaults. Applied once per
    // match so later edits to the boxes are the user's own.
    onHostInput: (host) => applySavedFlags(host),
    getSavedHosts: () => knownProfiles.map((p) => p.host),
    ...(__OWNCORD_WEB__ ? { fixedHost } : {}),
  });
  let appliedProfileHost = "";
  function applySavedFlags(host: string): void {
    if (host === appliedProfileHost) return;
    const saved = knownProfiles.find((p) => p.synthetic !== true && p.host === host) as
      { autoConnect?: boolean; rememberPassword?: boolean } | undefined;
    appliedProfileHost = saved ? host : "";
    if (!saved) return;
    loginForm.setAutoConnect(saved.autoConnect === true);
    loginForm.setRememberPassword(saved.rememberPassword === true);
  }

  // Per-host compatibility from the advisory preflight. The notice reads it
  // when the user selects a server; the 15 s probe only writes badges.
  const compatibilityByHost = new Map<
    string,
    { readonly compatibility: Compatibility; readonly serverEpoch: number | null }
  >();

  // The banner text of the last transient error, and of the one a protocol
  // refusal raised: leaving the notice clears only the latter.
  let lastTransientError: string | null = null;
  let refusalError: string | null = null;

  const incompatibleNotice = createIncompatibleNotice({
    onUpdate: (host) => callbacks.onUpdateClient?.(host),
    onLeave: () => {
      incompatibleNotice.hide();
      loginForm.clearError(refusalError);
      refusalError = null;
    },
  });

  function selectHost(host: string): void {
    const known = compatibilityByHost.get(host);
    if (
      known &&
      (known.compatibility === "client-older" || known.compatibility === "server-older")
    ) {
      incompatibleNotice.show(host, known.serverEpoch, PROTOCOL_EPOCH);
    } else {
      incompatibleNotice.hide();
    }
  }

  const serverPanel = createServerPanel(
    {
      signal,
      onServerClick(
        host: string,
        username?: string,
        autoConnect?: boolean,
        rememberPassword?: boolean,
      ) {
        loginForm.cancelServerWaitUnless(host);
        loginForm.setHost(host);
        if (username) {
          loginForm.setCredentials(username);
        }
        // A saved profile sets both boxes; a host with no profile gets the
        // defaults (stay signed in, password not remembered).
        loginForm.setAutoConnect(autoConnect ?? true);
        loginForm.setRememberPassword(rememberPassword ?? false);
        // The notice appears only for the host the user selects — never for a
        // background-probe profile.
        selectHost(host);
      },
      onCredentialLoaded(host: string, username: string, hasPassword?: boolean) {
        // Guard: user may have clicked a different profile while loading
        if (loginForm.getHost() === host) {
          loginForm.setCredentials(username, hasPassword);
        }
      },
      onAddProfile: callbacks.onAddProfile,
      onDeleteProfile: callbacks.onDeleteProfile,
      onToggleAutoLogin: callbacks.onToggleAutoLogin,
    },
    initialProfiles,
  );

  // The portal's one heading is the form card; its subtitle names the server:
  // what `server-info` reported, else the host.
  function refreshPortalName(): void {
    if (!__OWNCORD_WEB__ || fixedHost === undefined) return;
    const subtitle = loginForm.element.querySelector(".form-logo p");
    if (subtitle === null) return;
    const server = callbacks.getServerName?.(fixedHost) ?? fixedHost;
    setText(subtitle, portalText("login.subtitle", { server }));
  }

  // ---------------------------------------------------------------------------
  // DOM construction
  // ---------------------------------------------------------------------------

  function buildRoot(): HTMLDivElement {
    root = createElement("div", { class: "connect-page" });

    const branding = createConnectBranding();

    if (__OWNCORD_WEB__ && fixedHost !== undefined) {
      // One server: no list to pick from and no second brand block; the form
      // card is the only heading and the panel is never mounted.
      root.classList.add("connect-page--portal");
      appendChildren(root, loginForm.element);
      refreshPortalName();
    } else {
      serverPanel.element.insertBefore(branding, serverPanel.element.firstChild);
      appendChildren(root, serverPanel.element, loginForm.element);
    }

    // The incompatible-epoch notice sits above the form so it is seen before
    // another attempt; hidden until a mismatch is selected or refused. It goes
    // inside the form panel: .connect-page is a flex row, so a direct child
    // would claim its own column and squeeze the form.
    const connectForm = loginForm.element.querySelector(".connect-form")!;
    connectForm.parentElement!.insertBefore(incompatibleNotice.element, connectForm);

    // Status bar at bottom
    root.appendChild(loginForm.statusBarElement);

    // TOTP overlay
    root.appendChild(loginForm.totpOverlayElement);

    // Auto-connect overlay
    root.appendChild(loginForm.autoConnectOverlayElement);

    return root;
  }

  // ---------------------------------------------------------------------------
  // MountableComponent
  // ---------------------------------------------------------------------------

  let settingsOverlay: ReturnType<
    typeof import("../features/settings/SettingsOverlay").createSettingsOverlay
  > | null = null;
  let settingsOverlayLoading = false;
  let unsubSettingsOpen: (() => void) | null = null;
  let unsubTransientError: (() => void) | null = null;

  // The settings overlay (whose tabs pull in the LiveKit stack) is created
  // lazily on first open so it stays out of the startup path. Once created it
  // manages its own show/hide off uiStore.settingsOpen.
  function ensureSettingsOverlay(): void {
    if (settingsOverlay !== null || settingsOverlayLoading) return;
    settingsOverlayLoading = true;
    void import("../features/settings/SettingsOverlay").then(({ createSettingsOverlay }) => {
      settingsOverlayLoading = false;
      // The page may have been destroyed while the chunk loaded.
      if (signal.aborted) return;
      // Unauthenticated on the connect page — account actions are no-ops.
      settingsOverlay = createSettingsOverlay(preAuthSettingsOptions());
      settingsOverlay.mount(root);
    });
  }

  function mount(target: Element): void {
    container = target;
    const rootEl = buildRoot();
    container.appendChild(rootEl);

    // Create the settings overlay the first time settings are opened.
    unsubSettingsOpen = uiStore.subscribeSelector(
      (s) => s.settingsOpen,
      (settingsOpen) => {
        if (settingsOpen) ensureSettingsOverlay();
      },
    );
    if (uiStore.getState().settingsOpen) ensureSettingsOverlay();

    // Surface a transient error for as long as this page is mounted — not
    // just one already pending at mount time. A WS auth_error, a cert-
    // mismatch reject, or a background credential-save warning can all set
    // this while the connect page is already up; a one-time getState() read
    // here would silently drop them.
    unsubTransientError = uiStore.subscribeSelector(
      (s) => s.transientError,
      (msg) => {
        if (msg) {
          lastTransientError = msg;
          loginForm.showError(msg);
          setTransientError(null);
        }
      },
    );
    // Show any pending auth error (e.g. "already connected from another client")
    const pendingError = uiStore.getState().transientError;
    if (pendingError) {
      lastTransientError = pendingError;
      loginForm.showError(pendingError);
      setTransientError(null);
    }

    // Focus the first input
    loginForm.focusHost();
  }

  function destroy(): void {
    // Abort all event listeners registered with the signal
    disposable.destroy();
    unsubSettingsOpen?.();
    unsubSettingsOpen = null;
    unsubTransientError?.();
    unsubTransientError = null;
    settingsOverlay?.destroy?.();
    settingsOverlay = null;

    // Any transient error set while this page was mounted (shown or not)
    // must not resurface at the next mount — which only happens after a
    // later logout, where it would misleadingly read as a fresh login
    // failure rather than whatever set it during this session.
    setTransientError(null);

    // Mirror MainPage.destroy(): clear settingsOpen so the next page to
    // mount an (initially hidden) SettingsOverlay off that flag — MainPage,
    // after a successful login — doesn't show it over the freshly loaded app.
    closeSettings();

    if (container && root) {
      container.removeChild(root);
    }
    container = null;
  }

  return {
    mount,
    destroy,
    showTotp: () => loginForm.showTotp(),
    showConnecting: () => loginForm.showConnecting(),
    showAutoConnecting: (serverName: string) => loginForm.showAutoConnecting(serverName),
    showServerWait: (serverName: string, host: string) =>
      loginForm.showServerWait(serverName, host),
    hideServerWait: () => loginForm.hideServerWait(),
    showError: (message: string) => loginForm.showError(message),
    showNotice: (message: string) => loginForm.showNotice(message),
    resetToIdle: () => loginForm.resetToIdle(),
    updateHealthStatus: (host: string, status: HealthStatus) =>
      serverPanel.updateHealthStatus(host, status),
    updateCompatibility: (
      host: string,
      compatibility: Compatibility,
      serverEpoch: number | null,
    ) => {
      compatibilityByHost.set(host, { compatibility, serverEpoch });
      serverPanel.updateCompatibility(host, compatibility);
      refreshPortalName();
      // A fresh server-info snapshot may change the host's registration mode;
      // re-derive the register affordances if it is the selected host.
      if (loginForm.getHost().trim() === host) {
        loginForm.refreshRegistrationMode();
      }
    },
    showIncompatible(host: string, serverEpoch: number | null, clientEpoch = PROTOCOL_EPOCH): void {
      refusalError = lastTransientError;
      incompatibleNotice.show(host, serverEpoch, clientEpoch);
    },
    getRememberPassword: () => loginForm.getRememberPassword(),
    getAutoConnect: () => loginForm.getAutoConnect(),
    getPassword: () => loginForm.getPassword(),
    resubmitAfterCertAccept: (host: string) => loginForm.resubmitAfterCertAccept(host),
    isUsingSavedPassword: () => loginForm.isUsingSavedPassword(),
    refreshProfiles(profiles: readonly SimpleProfile[]): void {
      knownProfiles = profiles;
      serverPanel.renderProfiles(profiles);
      // Profiles load after the form mounts; a host typed before they arrived
      // still takes its saved profile's flags.
      applySavedFlags(loginForm.getHost().trim());
    },
    selectServer(
      host: string,
      username?: string,
      autoConnect?: boolean,
      rememberPassword?: boolean,
    ): void {
      loginForm.setHost(host);
      if (username) {
        loginForm.setCredentials(username);
      }
      loginForm.setAutoConnect(autoConnect ?? true);
      loginForm.setRememberPassword(rememberPassword ?? false);
      // A profile that opted out must not pick up a stored credential that outlived the opt-out.
      if (rememberPassword === false) return;
      // Load saved credentials asynchronously (same flow as clicking a server card)
      void (async () => {
        try {
          const cred = await loadCredential(host);
          if (cred && loginForm.getHost() === host) {
            // Show the password box as filled when one is saved, so the
            // "Remember password" tick keeps its promise. The plaintext stays
            // in the Rust backend; submitting uses onLoginWithSavedPassword.
            loginForm.setCredentials(cred.username, cred.hasPassword);
          }
        } catch (err) {
          log.debug("Credential auto-fill failed (best-effort, user can type manually)", {
            host,
            err,
          });
        }
      })();
    },
    applyInviteLink(code: string, host?: string): void {
      loginForm.applyInviteLink(code, host);
    },
  };
}
