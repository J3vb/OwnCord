// OwnCord Tauri v2 Client — Entry Point

import { installGlobalErrorHandlers, safeMount } from "@lib/safe-render";
import { createRouter } from "@lib/router";
import { createApiClient } from "@lib/api";
import { createWsClient } from "@lib/ws";
import { wireDispatcher } from "@lib/dispatcher";
import { authStore, setAuth, clearAuth } from "@stores/auth.store";
import { createConnectPage } from "@pages/ConnectPage";
import { createMainPage } from "@pages/MainPage";
import { createLogger } from "@lib/logger";

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

// Current page component reference for cleanup
let currentPage: { destroy?(): void } | null = null;

// Render the appropriate page based on router state
function renderPage(pageId: "connect" | "main"): void {
  // Destroy previous page
  currentPage?.destroy?.();
  currentPage = null;
  appEl!.textContent = "";

  if (pageId === "connect") {
    const connectPage = createConnectPage({
      async onLogin(host, username, password) {
        api.setConfig({ host });
        const result = await api.login(username, password);
        if (result.requires_2fa) {
          // TODO: Wire TOTP form state transition
          log.info("2FA required — TOTP flow not yet wired");
          return;
        }
        if (result.token) {
          api.setConfig({ token: result.token });
          ws.connect({ host, token: result.token });
          dispatcherCleanup = wireDispatcher(ws);

          // Wait for auth_ok from WS
          const unsub = ws.onStateChange((state) => {
            if (state === "connected") {
              unsub();
              router.navigate("main");
            }
          });
        }
      },
      async onRegister(host, username, password, inviteCode) {
        api.setConfig({ host });
        const result = await api.register(username, password, inviteCode);
        api.setConfig({ token: result.token });
        ws.connect({ host, token: result.token });
        dispatcherCleanup = wireDispatcher(ws);

        const unsub = ws.onStateChange((state) => {
          if (state === "connected") {
            unsub();
            router.navigate("main");
          }
        });
      },
      async onTotpSubmit(_code) {
        // TODO: implement TOTP verification
        log.info("TOTP submit — not yet wired");
      },
    });

    safeMount(connectPage, appEl!);
    currentPage = connectPage;
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
    router.navigate("connect");
  }
});

// Initial render
renderPage(router.getCurrentPage());
log.info("OwnCord client initialized");
