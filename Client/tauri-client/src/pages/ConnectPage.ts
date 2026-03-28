// ConnectPage — login/register page component.
// Thin composition shell that wires ServerPanel and LoginForm together.

import { createElement, appendChildren } from "@lib/dom";
import type { MountableComponent } from "@lib/safe-render";
import { openSettings, closeSettings, uiStore, setTransientError } from "@stores/ui.store";
import { createSettingsOverlay } from "@components/SettingsOverlay";
import type { HealthStatus } from "@lib/profiles";
import { createServerPanel } from "./connect-page/ServerPanel";
import { createLoginForm } from "./connect-page/LoginForm";
import { loadCredential } from "@lib/credentials";

// ---------------------------------------------------------------------------
// Re-exports (public API must not change)
// ---------------------------------------------------------------------------

export type { FormState, FormMode } from "./connect-page/LoginForm";
export type { SimpleProfile } from "./connect-page/ServerPanel";

import type { SimpleProfile } from "./connect-page/ServerPanel";

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
  getPassword(): string;
  /** Re-render the server profile list with updated data. */
  refreshProfiles(profiles: readonly SimpleProfile[]): void;
  /** Pre-select a server by host — fills the login form and loads saved credentials. */
  selectServer(host: string, username?: string): void;
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
      onServerClick(host: string, username?: string) {
        loginForm.setHost(host);
        if (username) {
          loginForm.setCredentials(username);
        }
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
    const brandTag = createElement("div", { class: "brand-tagline" }, "Self-hosted chat \u2014 Your server, your rules");
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
      onStatusChange: () => { /* no-op on connect page */ },
    });
    settingsOverlay.mount(rootEl);

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
    showTotp: () => loginForm.showTotp(),
    showConnecting: () => loginForm.showConnecting(),
    showAutoConnecting: (serverName: string) => loginForm.showAutoConnecting(serverName),
    showError: (message: string) => loginForm.showError(message),
    resetToIdle: () => loginForm.resetToIdle(),
    updateHealthStatus: (host: string, status: HealthStatus) =>
      serverPanel.updateHealthStatus(host, status),
    getRememberPassword: () => loginForm.getRememberPassword(),
    getPassword: () => loginForm.getPassword(),
    refreshProfiles(profiles: readonly SimpleProfile[]): void {
      serverPanel.renderProfiles(profiles);
    },
    selectServer(host: string, username?: string): void {
      loginForm.setHost(host);
      if (username) {
        loginForm.setCredentials(username);
      }
      // Load saved credentials asynchronously (same flow as clicking a server card)
      void (async () => {
        try {
          const cred = await loadCredential(host);
          if (cred && loginForm.getHost() === host) {
            loginForm.setCredentials(cred.username, cred.password);
          }
        } catch {
          // Credential loading is best-effort; user can type manually
        }
      })();
    },
  };
}

export type ConnectPage = ReturnType<typeof createConnectPage>;
