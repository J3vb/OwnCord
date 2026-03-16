// OwnCord Tauri v2 Client — Entry Point

import { installGlobalErrorHandlers, safeMount } from "@lib/safe-render";
import { createRouter } from "@lib/router";
import { createApiClient } from "@lib/api";
import { createWsClient } from "@lib/ws";
import { wireDispatcher } from "@lib/dispatcher";
import { authStore, setAuth, clearAuth } from "@stores/auth.store";
import { createConnectPage } from "@pages/ConnectPage";
import { createMainPage } from "@pages/MainPage";
import { createConnectedOverlay } from "@components/ConnectedOverlay";
import type { ConnectedOverlayControl } from "@components/ConnectedOverlay";
import { createLogger } from "@lib/logger";
import { saveCredential, deleteCredential } from "@lib/credentials";
import { initWindowState } from "@lib/window-state";

const log = createLogger("main");

// Install global error handlers first
installGlobalErrorHandlers();

const appEl = document.getElementById("app");
if (!appEl) {
  throw new Error("Missing #app element");
}

// Create core services
const router = createRouter("connect");
const api = createApiClient({ host: "" });
const ws = createWsClient();
let dispatcherCleanup: (() => void) | null = null;
let connectedOverlay: ConnectedOverlayControl | null = null;

// Current page component reference for cleanup
let currentPage: { destroy?(): void } | null = null;

// Render the appropriate page based on router state
function renderPage(pageId: "connect" | "main"): void {
  // Destroy previous page
  currentPage?.destroy?.();
  currentPage = null;
  appEl!.textContent = "";

  // Shared helper for post-auth WS connect + overlay flow
  function wirePostAuth(host: string, token: string, username: string): void {
    api.setConfig({ token });
    ws.connect({ host, token });
    dispatcherCleanup = wireDispatcher(ws);

    // Save credential for auto-reconnect (fire-and-forget)
    void saveCredential(host, username, token);

    const unsubState = ws.onStateChange((wsState) => {
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
          wirePostAuth(host, result.token, username);
        }
      },
      async onRegister(host, username, password, inviteCode) {
        api.setConfig({ host });
        const result = await api.register(username, password, inviteCode);
        wirePostAuth(host, result.token, username);
      },
      async onTotpSubmit(code) {
        if (!pendingTotpPartialToken) {
          log.error("TOTP submit without pending partial token");
          return;
        }
        const result = await api.verifyTotp(code, pendingTotpPartialToken);
        if (result.token) {
          wirePostAuth(pendingTotpHost, result.token, pendingTotpUsername);
        }
      },
    });

    safeMount(connectPage, appEl!);
    currentPage = connectPage;

    // Kick off health checks for default profiles in background
    void (async () => {
      const profiles = [{ host: "localhost:8443", name: "Local Server" }];
      for (const profile of profiles) {
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

// Initial render
renderPage(router.getCurrentPage());

// Initialize window state persistence (fire-and-forget)
void initWindowState();

log.info("OwnCord client initialized");
