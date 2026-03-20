// ConnectPage — login/register page component.
// Thin composition shell that wires ServerPanel and LoginForm together.

import { createElement, appendChildren } from "@lib/dom";
import type { MountableComponent } from "@lib/safe-render";
import { openSettings, closeSettings, uiStore, setTransientError } from "@stores/ui.store";
import { createSettingsOverlay } from "@components/SettingsOverlay";
import type { HealthStatus } from "@lib/profiles";
import { createServerPanel } from "./connect-page/ServerPanel";
import { createLoginForm } from "./connect-page/LoginForm";

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
  showError(message: string): void;
  resetToIdle(): void;
  updateHealthStatus(host: string, status: HealthStatus): void;
  getRememberPassword(): boolean;
  getPassword(): string;
  /** Re-render the server profile list with updated data. */
  refreshProfiles(profiles: readonly SimpleProfile[]): void;
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
    },
    initialProfiles,
  );

  // ---------------------------------------------------------------------------
  // DOM construction
  // ---------------------------------------------------------------------------

  function buildRoot(): HTMLDivElement {
    root = createElement("div", { class: "connect-page" });

    appendChildren(root, serverPanel.element, loginForm.element);

    // Status bar at bottom
    root.appendChild(loginForm.statusBarElement);

    // TOTP overlay
    root.appendChild(loginForm.totpOverlayElement);

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
    showError: (message: string) => loginForm.showError(message),
    resetToIdle: () => loginForm.resetToIdle(),
    updateHealthStatus: (host: string, status: HealthStatus) =>
      serverPanel.updateHealthStatus(host, status),
    getRememberPassword: () => loginForm.getRememberPassword(),
    getPassword: () => loginForm.getPassword(),
    refreshProfiles(profiles: readonly SimpleProfile[]): void {
      serverPanel.renderProfiles(profiles);
    },
  };
}

export type ConnectPage = ReturnType<typeof createConnectPage>;
