// ConnectPage — login/register page component.
// Thin composition shell that wires ServerPanel and LoginForm together.

import { createElement, appendChildren } from "@lib/dom";
import type { MountableComponent } from "@lib/safe-render";
import { openSettings, closeSettings, uiStore, setTransientError } from "@stores/ui.store";
import type { HealthStatus } from "@lib/profiles";
import { createServerPanel } from "./connect-page/ServerPanel";
import { createLoginForm } from "./connect-page/LoginForm";
import { loadCredential } from "@lib/credentials";

// ---------------------------------------------------------------------------
// Re-exports (public API must not change)
// ---------------------------------------------------------------------------

export type { SimpleProfile } from "./connect-page/ServerPanel";

import type { SimpleProfile } from "./connect-page/ServerPanel";

/** Callbacks for external wiring (API integration added later). */
export interface ConnectPageCallbacks {
  onLogin(host: string, username: string, password: string): Promise<void>;
  onRegister(host: string, username: string, password: string, inviteCode: string): Promise<void>;
  onTotpSubmit(code: string): Promise<void>;
  onAddProfile?(name: string, host: string): void;
  onDeleteProfile?(profileId: string): void;
  onToggleAutoLogin?(profileId: string, enabled: boolean): void;
  onAutoLoginCancel?(): void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_PROFILES: readonly SimpleProfile[] = [
  { name: "Local Server", host: "localhost:8443" },
];

// ---------------------------------------------------------------------------
// ConnectPage
// ---------------------------------------------------------------------------

export function createConnectPage(
  callbacks: ConnectPageCallbacks,
  initialProfiles: readonly SimpleProfile[] = DEFAULT_PROFILES,
): MountableComponent & {
  showTotp(): void;
  showConnecting(): void;
  showAutoConnecting(serverName: string): void;
  showError(message: string): void;
  resetToIdle(): void;
  updateHealthStatus(host: string, status: HealthStatus): void;
  getRememberPassword(): boolean;
  /** Whether the auto-connect checkbox is ticked. */
  getAutoConnect(): boolean;
  getPassword(): string;
  /** Re-render the server profile list with updated data. */
  refreshProfiles(profiles: readonly SimpleProfile[]): void;
  /** Pre-select a server by host — fills the login form and loads saved credentials. */
  selectServer(host: string, username?: string, autoConnect?: boolean): void;
  /** Pre-fill + switch to register mode from an owncord:// invite deep link. */
  applyInviteLink(code: string, host?: string): void;
} {
  let container: Element | null = null;
  let root: HTMLDivElement;

  // Cleanup tracking
  const abortController = new AbortController();
  const { signal } = abortController;

  // --- Create sub-components ---

  const loginForm = createLoginForm({
    signal,
    onLogin: callbacks.onLogin,
    onRegister: callbacks.onRegister,
    onTotpSubmit: callbacks.onTotpSubmit,
    onSettingsOpen: () => openSettings(),
    onAutoLoginCancel: callbacks.onAutoLoginCancel,
  });

  const serverPanel = createServerPanel(
    {
      signal,
      onServerClick(host: string, username?: string, autoConnect?: boolean) {
        loginForm.setHost(host);
        if (username) {
          loginForm.setCredentials(username);
        }
        loginForm.setAutoConnect(autoConnect === true);
      },
      onCredentialLoaded(host: string, username: string, password?: string) {
        // Guard: user may have clicked a different profile while loading
        if (loginForm.getHost() === host) {
          loginForm.setCredentials(username, password);
        }
      },
      onAddProfile: callbacks.onAddProfile,
      onDeleteProfile: callbacks.onDeleteProfile,
      onToggleAutoLogin: callbacks.onToggleAutoLogin,
    },
    initialProfiles,
  );

  // ---------------------------------------------------------------------------
  // DOM construction
  // ---------------------------------------------------------------------------

  function buildRoot(): HTMLDivElement {
    root = createElement("div", { class: "connect-page" });

    // OC Logo branding — prepended to server panel
    const branding = createElement("div", { class: "server-branding" });

    const logoSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    logoSvg.setAttribute("width", "80");
    logoSvg.setAttribute("height", "48");
    logoSvg.setAttribute("viewBox", "0 0 120 70");
    logoSvg.setAttribute("class", "oc-logo");

    const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
    const grad = document.createElementNS("http://www.w3.org/2000/svg", "linearGradient");
    grad.setAttribute("id", "oc-grad");
    grad.setAttribute("x1", "0%");
    grad.setAttribute("y1", "0%");
    grad.setAttribute("x2", "100%");
    grad.setAttribute("y2", "0%");
    const stops = [
      { offset: "0%", color: "#f97316" },
      { offset: "30%", color: "#ec4899" },
      { offset: "65%", color: "#8b5cf6" },
      { offset: "100%", color: "#06b6d4" },
    ];
    for (const s of stops) {
      const stop = document.createElementNS("http://www.w3.org/2000/svg", "stop");
      stop.setAttribute("offset", s.offset);
      stop.setAttribute("style", `stop-color:${s.color}`);
      grad.appendChild(stop);
    }
    const filter = document.createElementNS("http://www.w3.org/2000/svg", "filter");
    filter.setAttribute("id", "oc-glow");
    const blur = document.createElementNS("http://www.w3.org/2000/svg", "feGaussianBlur");
    blur.setAttribute("stdDeviation", "4");
    blur.setAttribute("result", "blur");
    filter.appendChild(blur);
    const composite = document.createElementNS("http://www.w3.org/2000/svg", "feComposite");
    composite.setAttribute("in", "SourceGraphic");
    composite.setAttribute("in2", "blur");
    composite.setAttribute("operator", "over");
    filter.appendChild(composite);
    defs.appendChild(grad);
    defs.appendChild(filter);
    logoSvg.appendChild(defs);

    const glowText = document.createElementNS("http://www.w3.org/2000/svg", "text");
    glowText.setAttribute("x", "60");
    glowText.setAttribute("y", "56");
    glowText.setAttribute("text-anchor", "middle");
    glowText.setAttribute("font-family", "'Segoe UI',system-ui,sans-serif");
    glowText.setAttribute("font-size", "68");
    glowText.setAttribute("font-weight", "900");
    glowText.setAttribute("fill", "url(#oc-grad)");
    glowText.setAttribute("letter-spacing", "-4");
    glowText.setAttribute("opacity", "0.4");
    glowText.setAttribute("filter", "url(#oc-glow)");
    glowText.setAttribute("class", "oc-glow-layer");
    glowText.textContent = "OC";
    logoSvg.appendChild(glowText);

    const sharpText = document.createElementNS("http://www.w3.org/2000/svg", "text");
    sharpText.setAttribute("x", "60");
    sharpText.setAttribute("y", "56");
    sharpText.setAttribute("text-anchor", "middle");
    sharpText.setAttribute("font-family", "'Segoe UI',system-ui,sans-serif");
    sharpText.setAttribute("font-size", "68");
    sharpText.setAttribute("font-weight", "900");
    sharpText.setAttribute("fill", "url(#oc-grad)");
    sharpText.setAttribute("letter-spacing", "-4");
    sharpText.textContent = "OC";
    logoSvg.appendChild(sharpText);

    branding.appendChild(logoSvg);

    const brandName = createElement("div", { class: "brand-name" }, "OwnCord");
    const brandTag = createElement(
      "div",
      { class: "brand-tagline" },
      "Self-hosted chat \u2014 Your server, your rules",
    );
    appendChildren(branding, brandName, brandTag);

    serverPanel.element.insertBefore(branding, serverPanel.element.firstChild);

    appendChildren(root, serverPanel.element, loginForm.element);

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
    typeof import("@components/SettingsOverlay").createSettingsOverlay
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
    void import("@components/SettingsOverlay").then(({ createSettingsOverlay }) => {
      settingsOverlayLoading = false;
      // The page may have been destroyed while the chunk loaded.
      if (signal.aborted) return;
      // Unauthenticated on the connect page — account actions are no-ops.
      settingsOverlay = createSettingsOverlay({
        isAuthenticated: false,
        onClose: () => closeSettings(),
        onChangePassword: () => Promise.resolve(),
        onUpdateProfile: () => Promise.resolve(),
        onUploadAvatar: () => Promise.reject(new Error("Not authenticated")),
        onLogout: () => {},
        onDeleteAccount: () => Promise.resolve(),
        onStatusChange: () => {},
        onEnableTotp: () => Promise.reject(new Error("Not authenticated")),
        onConfirmTotp: () => Promise.reject(new Error("Not authenticated")),
        onDisableTotp: () => Promise.reject(new Error("Not authenticated")),
      });
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
          loginForm.showError(msg);
          setTransientError(null);
        }
      },
    );
    // Show any pending auth error (e.g. "already connected from another client")
    const pendingError = uiStore.getState().transientError;
    if (pendingError) {
      loginForm.showError(pendingError);
      setTransientError(null);
    }

    // Focus the first input
    loginForm.focusHost();
  }

  function destroy(): void {
    // Abort all event listeners registered with the signal
    abortController.abort();
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
    showError: (message: string) => loginForm.showError(message),
    resetToIdle: () => loginForm.resetToIdle(),
    updateHealthStatus: (host: string, status: HealthStatus) =>
      serverPanel.updateHealthStatus(host, status),
    getRememberPassword: () => loginForm.getRememberPassword(),
    getAutoConnect: () => loginForm.getAutoConnect(),
    getPassword: () => loginForm.getPassword(),
    refreshProfiles(profiles: readonly SimpleProfile[]): void {
      serverPanel.renderProfiles(profiles);
    },
    selectServer(host: string, username?: string, autoConnect?: boolean): void {
      loginForm.setHost(host);
      if (username) {
        loginForm.setCredentials(username);
      }
      loginForm.setAutoConnect(autoConnect === true);
      // Load saved credentials asynchronously (same flow as clicking a server card)
      void (async () => {
        try {
          const cred = await loadCredential(host);
          if (cred && loginForm.getHost() === host) {
            // Prefill the saved password so the user isn't retyping it.
            loginForm.setCredentials(cred.username, cred.password);
          }
        } catch {
          // Credential loading is best-effort; user can type manually
        }
      })();
    },
    applyInviteLink(code: string, host?: string): void {
      loginForm.applyInviteLink(code, host);
    },
  };
}
