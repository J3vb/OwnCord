// OwnCord Tauri v2 Client — Entry Point

import "@styles/tokens.css";
import "@styles/base.css";
import "@styles/login.css";
import "@styles/app.css";

import { installGlobalErrorHandlers, safeMount } from "@lib/safe-render";
import { createRouter } from "@lib/router";
import { createApiClient } from "@lib/api";
import { createWsClient } from "@lib/ws";
import { wireDispatcher } from "@lib/dispatcher";
import { authStore, setAuth, clearAuth } from "@stores/auth.store";
import { voiceStore, leaveVoiceChannel } from "@stores/voice.store";
import { leaveVoice as voiceSessionLeave } from "@lib/voiceSession";
import { createConnectPage } from "@pages/ConnectPage";
import { createMainPage } from "@pages/MainPage";
import { applyStoredAppearance } from "@components/SettingsOverlay";
import { createConnectedOverlay } from "@components/ConnectedOverlay";
import type { ConnectedOverlayControl } from "@components/ConnectedOverlay";
import { createLogger } from "@lib/logger";
import { saveCredential, deleteCredential } from "@lib/credentials";
import { initWindowState } from "@lib/window-state";
import { createCertMismatchModal } from "@components/CertMismatchModal";
import { createProfileManager, createTauriBackend } from "@lib/profiles";
import type { CertTofuEvent } from "@lib/ws";

const log = createLogger("main");

// Install global error handlers first
installGlobalErrorHandlers();

// Apply stored theme/font/compact preferences before first render
applyStoredAppearance();

const appEl = document.getElementById("app");
if (!appEl) {
  throw new Error("Missing #app element");
}

// Create core services
const router = createRouter("connect");
const api = createApiClient({ host: "" }, () => {
  log.warn("Session expired (401), clearing auth");
  clearAuth();
});
const ws = createWsClient();
const profileManager = createProfileManager(createTauriBackend());
let dispatcherCleanup: (() => void) | null = null;
let connectedOverlay: ConnectedOverlayControl | null = null;
let lastConnectHost = "";
let lastConnectToken = "";

// Certificate mismatch modal handler
let certModalActive = false;
ws.onCertMismatch((evt: CertTofuEvent) => {
  if (certModalActive) return;
  certModalActive = true;

  const modal = createCertMismatchModal({
    host: evt.host,
    storedFingerprint: evt.storedFingerprint ?? "Unknown",
    newFingerprint: evt.fingerprint,
    onAccept: () => {
      modal.destroy?.();
      certModalActive = false;
      void (async () => {
        try {
          await ws.acceptCertFingerprint(evt.host, evt.fingerprint);
          if (lastConnectHost && lastConnectToken) {
            ws.connect({ host: lastConnectHost, token: lastConnectToken });
          }
        } catch (err) {
          log.error("Failed to accept cert fingerprint", err);
        }
      })();
    },
    onReject: () => {
      modal.destroy?.();
      certModalActive = false;
      ws.disconnect();
      clearAuth();
      router.navigate("connect");
    },
  });
  modal.mount(document.body);
});

// Current page component reference for cleanup
let currentPage: { destroy?(): void } | null = null;

/** Run health checks for a list of profiles and update the connect page. */
function runHealthChecks(
  connectPage: { updateHealthStatus(host: string, status: { status: string; latencyMs: number | null; version: string | null }): void },
  profiles: readonly { host: string }[],
): void {
  for (const profile of profiles) {
    void (async () => {
      try {
        connectPage.updateHealthStatus(profile.host, {
          status: "checking",
          latencyMs: null,
          version: null,
        });
        const start = performance.now();
        const health = await api.getHealth(profile.host, 3000);
        const elapsed = Math.round(performance.now() - start);
        connectPage.updateHealthStatus(profile.host, {
          status: elapsed > 1500 ? "slow" : "online",
          latencyMs: elapsed,
          version: health.version,
        });
      } catch {
        connectPage.updateHealthStatus(profile.host, {
          status: "offline",
          latencyMs: null,
          version: null,
        });
      }
    })();
  }
}

// Render the appropriate page based on router state
function renderPage(pageId: "connect" | "main"): void {
  log.info("Navigating to page", { pageId });
  // Destroy previous page
  currentPage?.destroy?.();
  currentPage = null;
  appEl!.textContent = "";

  // Shared helper for post-auth WS connect + overlay flow
  function wirePostAuth(host: string, token: string, username: string, password?: string): void {
    log.info("Post-auth wiring", { host, username });
    api.setConfig({ token });
    // Store token in authStore so the dispatcher's auth_ok handler has it
    authStore.setState((prev) => ({ ...prev, token }));
    lastConnectHost = host;
    lastConnectToken = token;
    ws.connect({ host, token });
    dispatcherCleanup = wireDispatcher(ws);
    log.info("Dispatcher wired, connecting WS");

    // Save credential for auto-reconnect (fire-and-forget)
    void saveCredential(host, username, token, password);

    const unsubState = ws.onStateChange((wsState) => {
      log.debug("WS state change", { state: wsState });
      if (wsState === "connected") {
        unsubState();
        const auth = authStore.getState();
        connectedOverlay = createConnectedOverlay({
          serverName: auth.serverName ?? host,
          username: auth.user?.username ?? username,
          motd: auth.motd ?? "",
          onReady: () => {
            connectedOverlay?.destroy();
            connectedOverlay = null;
            router.navigate("main");
          },
        });
        appEl!.appendChild(connectedOverlay.element);
        connectedOverlay.show();

        const unsubReady = ws.on("ready", () => {
          unsubReady();
          connectedOverlay?.markReady();
        });
      }
    });
  }

  // Track partial auth state for TOTP flow
  let pendingTotpHost = "";
  let pendingTotpPartialToken = "";
  let pendingTotpUsername = "";

  if (pageId === "connect") {
    // Helper to get the profile list for the ConnectPage
    function getProfileList(): readonly { name: string; host: string; id?: string; username?: string }[] {
      const saved = profileManager.getAll();
      if (saved.length > 0) return saved;
      // Fallback: show a default local server entry
      return [{ name: "Local Server", host: "localhost:8443" }];
    }

    // Auto-save a profile for a host after successful login (if not already saved)
    function ensureProfileExists(host: string, username: string): void {
      const existing = profileManager.getAll().find((p) => p.host === host);
      if (existing) {
        // Update username and lastConnected
        profileManager.updateProfile(existing.id, { username });
        profileManager.setLastConnected(existing.id);
      } else {
        const created = profileManager.addProfile({
          name: host.split(":")[0] ?? host,
          host,
          username,
          autoConnect: false,
          rememberPassword: false,
          color: "#5865F2",
        });
        profileManager.setLastConnected(created.id);
      }
      void profileManager.saveProfiles();
    }

    const connectPage = createConnectPage({
      async onLogin(host, username, password) {
        api.setConfig({ host });
        const result = await api.login(username, password);
        if (result.requires_2fa) {
          pendingTotpHost = host;
          pendingTotpPartialToken = result.partial_token ?? "";
          pendingTotpUsername = username;
          connectPage.showTotp();
          return;
        }
        if (result.token) {
          const savedPassword = connectPage.getRememberPassword() ? password : undefined;
          ensureProfileExists(host, username);
          wirePostAuth(host, result.token, username, savedPassword);
        }
      },
      async onRegister(host, username, password, inviteCode) {
        api.setConfig({ host });
        const result = await api.register(username, password, inviteCode);
        const savedPassword = connectPage.getRememberPassword() ? password : undefined;
        ensureProfileExists(host, username);
        wirePostAuth(host, result.token, username, savedPassword);
      },
      async onTotpSubmit(code) {
        if (!pendingTotpPartialToken) {
          log.error("TOTP submit without pending partial token");
          return;
        }
        const result = await api.verifyTotp(code, pendingTotpPartialToken);
        if (result.token) {
          const savedPassword = connectPage.getRememberPassword() ? connectPage.getPassword() : undefined;
          ensureProfileExists(pendingTotpHost, pendingTotpUsername);
          wirePostAuth(pendingTotpHost, result.token, pendingTotpUsername, savedPassword);
        }
      },
      onAddProfile(name, host) {
        profileManager.addProfile({
          name,
          host,
          username: "",
          autoConnect: false,
          rememberPassword: false,
          color: "#5865F2",
        });
        void profileManager.saveProfiles();
        connectPage.refreshProfiles(getProfileList());
        // Check health for the new profile
        runHealthChecks(connectPage, getProfileList());
      },
      onDeleteProfile(profileId) {
        profileManager.removeProfile(profileId);
        void profileManager.saveProfiles();
        connectPage.refreshProfiles(getProfileList());
      },
    }, getProfileList());

    safeMount(connectPage, appEl!);
    currentPage = connectPage;

    // Load saved profiles and kick off health checks
    void (async () => {
      try {
        await profileManager.loadProfiles();
        const profiles = getProfileList();
        connectPage.refreshProfiles(profiles);
        runHealthChecks(connectPage, profiles);
      } catch (err) {
        log.warn("Failed to load profiles, using defaults", err);
        runHealthChecks(connectPage, getProfileList());
      }
    })();
  } else {
    const mainPage = createMainPage({ ws, api });
    safeMount(mainPage, appEl!);
    currentPage = mainPage;
  }
}

// Listen for navigation changes
router.onNavigate(renderPage);

// Handle logout / disconnect
authStore.subscribe((state) => {
  if (!state.isAuthenticated && router.getCurrentPage() === "main") {
    // Leave voice channel before disconnecting so other clients see it immediately
    const voice = voiceStore.getState();
    if (voice.currentChannelId !== null) {
      voiceSessionLeave();
      ws.send({ type: "voice_leave", payload: {} });
      leaveVoiceChannel();
    }
    dispatcherCleanup?.();
    dispatcherCleanup = null;
    ws.disconnect();
    // Clear stored credential on logout
    const host = api.getConfig().host;
    if (host) {
      void deleteCredential(host);
    }
    router.navigate("connect");
  }
});

// Send voice_leave on window close (best-effort — server readPump defer is the safety net)
window.addEventListener("beforeunload", () => {
  const voice = voiceStore.getState();
  if (voice.currentChannelId !== null) {
    voiceSessionLeave();
    ws.send({ type: "voice_leave", payload: {} });
  }
});

// Initial render
renderPage(router.getCurrentPage());

// Initialize window state persistence (fire-and-forget)
void initWindowState();

log.info("OwnCord client initialized");
