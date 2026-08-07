// OwnCord Tauri v2 Client — Entry Point

import "@styles/tokens.css";
import "@styles/base.css";
import "@styles/login.css";
import "@styles/app.css";
import "@styles/theme-neon-glow.css";

import { installGlobalErrorHandlers, safeMount } from "@lib/safe-render";
import { createRouter } from "@lib/router";
import { createApiClient } from "@lib/api";
import { createWsClient } from "@lib/ws";
import { wireDispatcher, wireConnectionStatus } from "@lib/dispatcher";
import { authStore, clearAuth } from "@stores/auth.store";
import { setTransientError } from "@stores/ui.store";
import { voiceStore, leaveVoiceChannel } from "@stores/voice.store";
import { createConnectPage } from "@pages/ConnectPage";
import { applyStoredAppearance } from "@lib/appearance";
import { restoreTheme } from "@lib/themes";
import { initPtt } from "@lib/ptt";
import { createNavigationGuard } from "@lib/navigation-guard";
import { createConnectedOverlay } from "@components/ConnectedOverlay";
import type { ConnectedOverlayControl } from "@components/ConnectedOverlay";
import { createLogger, applyStoredLogLevel } from "@lib/logger";
import { initLogPersistence, flushLogs } from "@lib/logPersistence";
import {
  saveCredential,
  loadCredential,
  deleteCredential,
  createUserUpdateCredentialSaver,
} from "@lib/credentials";
import { initWindowState } from "@lib/window-state";
import { initDeepLinks } from "@lib/deep-link";
import { jumpToMessage } from "@lib/message-navigation";
import { createCertMismatchModal, createCertFirstUseModal } from "@components/CertMismatchModal";
import { reconnectAfterCertAccept } from "@lib/cert-reconnect";
import { createProfileManager, createTauriBackend } from "@lib/profiles";
import type { CertTofuEvent } from "@lib/ws";

import { openUrl } from "@tauri-apps/plugin-opener";

// Gate the log level before anything logs: debug entries are serialized and
// persisted to disk, so in production the level must filter real work, not
// just console noise. Honors the level saved on the Logs settings tab; when
// unset, dev builds keep full debug output and production defaults to info.
applyStoredLogLevel(import.meta.env.DEV ? "debug" : "info");

const log = createLogger("main");

// livekitSession (and the ~1.3 MB livekit-client SDK behind it) is loaded
// lazily so it stays out of the startup path. When a voice session exists the
// module is necessarily already loaded, so this import resolves from the
// module cache in a microtask.
function voiceSessionLeave(sendWsLeave: boolean): void {
  void import("@lib/livekitSession")
    .then(({ leaveVoice }) => leaveVoice(sendWsLeave))
    .catch((e) => log.warn("Failed to leave voice session", e));
}

// Disable the default browser context menu globally.
document.addEventListener("contextmenu", (e) => {
  e.preventDefault();
});

// F12 or Ctrl+Shift+I opens WebView2 DevTools in development builds only.
// F5 and Ctrl+R are blocked to prevent accidental page reloads which cause
// ghost voice state (user appears in channel with no LiveKit connection).
document.addEventListener("keydown", (e) => {
  if (e.key === "F5" || (e.ctrlKey && e.key === "r")) {
    e.preventDefault();
    return;
  }
  if (import.meta.env.DEV && (e.key === "F12" || (e.ctrlKey && e.shiftKey && e.key === "I"))) {
    e.preventDefault();
    void import("@tauri-apps/api/core").then(({ invoke }) => {
      void invoke("open_devtools");
    });
  }
});

// Open external links (target="_blank") in the user's default browser.
document.addEventListener("click", (e) => {
  const link = (e.target as HTMLElement).closest("a[target='_blank']");
  if (link === null) return;
  e.preventDefault();
  const href = (link as HTMLAnchorElement).href;
  if (href && (href.startsWith("http://") || href.startsWith("https://"))) {
    void openUrl(href);
  }
});

// Install global error handlers first
installGlobalErrorHandlers();

// Apply stored theme/font/compact preferences before first render
applyStoredAppearance();

// Restore saved theme (body class) before first render
restoreTheme();

// Start push-to-talk listener (Rust-side polling, non-consuming)
void initPtt();

const appEl = document.getElementById("app");
if (!appEl) {
  throw new Error("Missing #app element");
}

// Create core services
const router = createRouter("connect");
// REST traffic is tunneled through the Rust HTTP TOFU proxy (src/lib/httpProxy.ts
// → src-tauri/src/http_proxy.rs), which pins the server certificate to the same
// trust-on-first-use fingerprint as the WS proxy. No cert is ever blindly
// accepted; the bearer token never rides an unpinned TLS connection.
const api = createApiClient({ host: "" }, () => {
  log.warn("Session expired (401), clearing auth");
  setTransientError("Your session expired — sign in again.");
  clearAuth();
});
const ws = createWsClient();
// Single writer for the UX-facing connection status (docs/architecture/ux §3):
// live controls read ui.store.connectionStatus reactively instead of wiring
// their own ws.onStateChange. Lifecycle plumbing that needs the exact internal
// transition (the connected overlay below) stays on ws.onStateChange.
wireConnectionStatus(ws);
const profileManager = createProfileManager(createTauriBackend());
let dispatcherCleanup: (() => void) | null = null;
// Tears down the session-scoped WS listeners registered in wirePostAuth
// (user_update, onStateChange, ready). dispatcherCleanup only clears
// dispatcher-registered handlers, so these need their own teardown to avoid
// accumulating across login/logout/retry cycles.
let sessionCleanup: (() => void) | null = null;
let connectedOverlay: ConnectedOverlayControl | null = null;
let lastConnectHost = "";
let lastConnectToken = "";
// Re-run the connect page's health checks (set while the connect page is
// mounted, cleared otherwise) — refreshes a server's status after its
// certificate is trusted for the first time.
let rerunConnectHealth: (() => void) | null = null;
// Set while the connect page is mounted so an owncord:// deep link can pre-fill
// its register form; the pending value covers links that arrive before it mounts.
let applyInviteToConnectPage: ((code: string, host?: string) => void) | null = null;
let pendingInviteLink: { code: string; host?: string } | null = null;

// Shared guard so the first-use and mismatch cert modals never stack.
let certModalActive = false;

// First-use certificate confirmation (F4/F8). The Rust proxy REJECTS the first
// connection to a server until the user confirms its fingerprint, so no
// credential is ever sent to an unconfirmed host. This fires during the connect
// page's health check (the first TLS contact), before login.
ws.onCertFirstUse((evt: CertTofuEvent) => {
  if (certModalActive) return;
  certModalActive = true;

  const modal = createCertFirstUseModal({
    host: evt.host,
    fingerprint: evt.fingerprint,
    onAccept: () => {
      modal.destroy?.();
      certModalActive = false;
      void (async () => {
        try {
          await ws.acceptCertFingerprint(evt.host, evt.fingerprint);
          // Refresh server health so the now-trusted host becomes reachable,
          // and resume a pending connect if one was in flight.
          rerunConnectHealth?.();
          if (lastConnectHost && lastConnectToken) {
            ws.connect({ host: lastConnectHost, token: lastConnectToken });
          }
        } catch (err) {
          log.error("Failed to trust first-use certificate", err);
        }
      })();
    },
    onReject: () => {
      modal.destroy?.();
      certModalActive = false;
    },
  });
  modal.mount(document.body);
});
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
            reconnectAfterCertAccept(ws, router, lastConnectHost, lastConnectToken);
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

// Register the global cert-tofu listener now so first-use / mismatch prompts
// are received during the connect page's health checks, before any WS connect.
void ws.startCertListener();

// Current page component reference for cleanup
let currentPage: { destroy?(): void } | null = null;

/** Run health checks for a list of profiles and update the connect page. */
function runHealthChecks(
  connectPage: {
    updateHealthStatus(
      host: string,
      status: {
        status: string;
        latencyMs: number | null;
        version: string | null;
        onlineUsers: number | null;
      },
    ): void;
  },
  profiles: readonly { host: string }[],
): void {
  for (const profile of profiles) {
    void (async () => {
      try {
        connectPage.updateHealthStatus(profile.host, {
          status: "checking",
          latencyMs: null,
          version: null,
          onlineUsers: null,
        });
        const start = performance.now();
        const health = await api.getHealth(profile.host, 3000);
        const elapsed = Math.round(performance.now() - start);
        connectPage.updateHealthStatus(profile.host, {
          status: elapsed > 1500 ? "slow" : "online",
          latencyMs: elapsed,
          version: health.version ?? null,
          onlineUsers: health.online_users ?? null,
        });
      } catch (err) {
        // Record why the check failed (TLS/cert-pin/network) — otherwise a
        // "can't connect" report has no logged cause to diagnose.
        log.warn("health check failed", { host: profile.host, error: String(err) });
        connectPage.updateHealthStatus(profile.host, {
          status: "offline",
          latencyMs: null,
          version: null,
          onlineUsers: null,
        });
      }
    })();
  }
}

// Guards the async MainPage mount below against the destroy-before-mount race:
// a stale mount is discarded when a newer navigation supersedes it.
const navGuard = createNavigationGuard();

// Render the appropriate page based on router state
async function renderPage(pageId: "connect" | "main"): Promise<void> {
  const isCurrentNavigation = navGuard.begin();
  log.info("Navigating to page", { pageId });
  // Destroy previous page
  currentPage?.destroy?.();
  currentPage = null;
  appEl!.textContent = "";
  // Only valid while the connect page is mounted (re-set in its render branch).
  rerunConnectHealth = null;
  applyInviteToConnectPage = null;

  // Shared helper for post-auth WS connect + overlay flow
  function wirePostAuth(
    host: string,
    token: string,
    username: string,
    password?: string,
    rememberPassword = true,
  ): void {
    log.info("Post-auth wiring", { host, username });
    // Tear down any prior session wiring so listeners and the connected
    // overlay never stack across a retry (a second wirePostAuth without an
    // intervening logout).
    sessionCleanup?.();
    sessionCleanup = null;
    dispatcherCleanup?.();
    dispatcherCleanup = null;
    connectedOverlay?.destroy();
    connectedOverlay = null;
    api.setConfig({ token });
    // Store token in authStore so the dispatcher's auth_ok handler has it
    authStore.setState((prev) => ({ ...prev, token }));
    lastConnectHost = host;
    lastConnectToken = token;
    ws.connect({ host, token });
    dispatcherCleanup = wireDispatcher(ws, api);
    log.info("Dispatcher wired, connecting WS");

    // Session-scoped WS listeners — collected so they're all removed together
    // on logout/disconnect (or the next wirePostAuth).
    const sessionUnsubs: Array<() => void> = [];

    // BUG-135: Only persist credentials when the user opted in.
    if (rememberPassword) {
      saveCredential(host, username, token, password)
        .then((ok) => {
          if (!ok) {
            log.warn("Credential save failed — auto-login will not work for this server");
            setTransientError("Could not save credentials — auto-login won't work");
          }
        })
        .catch(() => {
          // saveCredential already catches internally; this is defence-in-depth
        });
    }

    // Update saved credentials when the current user changes their username.
    // Guarded by the same remember-password opt-out as the initial save
    // above (BUG-135), and passes the session's password through so a later
    // save doesn't wipe out the one saved at login for an opted-in user.
    sessionUnsubs.push(
      ws.on("user_update", createUserUpdateCredentialSaver(host, rememberPassword, password)),
    );

    const unsubState = ws.onStateChange((wsState) => {
      log.debug("WS state change", { state: wsState });
      if (wsState === "connected") {
        // Stop listening once connected so a later transition can't fire this
        // handler again (which would append a second overlay).
        unsubState();
        // Pre-warm the lazily-loaded MainPage chunk (and the LiveKit stack
        // behind it) so navigating past the connected overlay doesn't wait
        // on a dynamic import.
        void import("@pages/MainPage");
        const auth = authStore.getState();
        // Ensure exactly one overlay exists at a time.
        connectedOverlay?.destroy();
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
        sessionUnsubs.push(unsubReady);
      } else if (wsState === "disconnected") {
        // Terminal non-connected transition (auth_error, cert-mismatch reject,
        // or intentional disconnect before ever connecting): drop the handler
        // so it doesn't linger and fire on a later connect.
        unsubState();
      }
    });
    sessionUnsubs.push(unsubState);

    sessionCleanup = () => {
      for (const unsub of sessionUnsubs) unsub();
      sessionUnsubs.length = 0;
    };
  }

  // Track partial auth state for TOTP flow
  let pendingTotpHost = "";
  let pendingTotpPartialToken = "";
  let pendingTotpUsername = "";

  if (pageId === "connect") {
    // Helper to get the profile list for the ConnectPage
    function getProfileList(): readonly {
      name: string;
      host: string;
      id?: string;
      username?: string;
    }[] {
      const saved = profileManager.getAll();
      if (saved.length > 0) return saved;
      // Fallback: show a default local server entry
      return [{ name: "Local Server", host: "localhost:8443" }];
    }

    // Auto-save a profile for a host after successful login (if not already saved)
    function ensureProfileExists(host: string, username: string, rememberPassword: boolean): void {
      const existing = profileManager.getAll().find((p) => p.host === host);
      if (existing) {
        // Update username, rememberPassword preference, and lastConnected
        profileManager.updateProfile(existing.id, { username, rememberPassword });
        profileManager.setLastConnected(existing.id);
      } else {
        const created = profileManager.addProfile({
          name: host.split(":")[0] ?? host,
          host,
          username,
          autoConnect: false,
          rememberPassword,
          color: "#5865F2",
        });
        profileManager.setLastConnected(created.id);
      }
      void profileManager.saveProfiles();
    }

    const connectPage = createConnectPage(
      {
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
            const remember = connectPage.getRememberPassword();
            const savedPassword = remember ? password : undefined;
            ensureProfileExists(host, username, remember);
            wirePostAuth(host, result.token, username, savedPassword, remember);
          }
        },
        async onRegister(host, username, password, inviteCode) {
          api.setConfig({ host });
          const result = await api.register(username, password, inviteCode);
          const remember = connectPage.getRememberPassword();
          const savedPassword = remember ? password : undefined;
          ensureProfileExists(host, username, remember);
          wirePostAuth(host, result.token, username, savedPassword, remember);
        },
        async onTotpSubmit(code) {
          if (!pendingTotpPartialToken) {
            log.error("TOTP submit without pending partial token");
            return;
          }
          try {
            const result = await api.verifyTotp(code, pendingTotpPartialToken);
            if (result.token) {
              const remember = connectPage.getRememberPassword();
              const savedPassword = remember ? connectPage.getPassword() : undefined;
              ensureProfileExists(pendingTotpHost, pendingTotpUsername, remember);
              wirePostAuth(
                pendingTotpHost,
                result.token,
                pendingTotpUsername,
                savedPassword,
                remember,
              );
            }
          } finally {
            // Clear sensitive partial token immediately after use (success or failure)
            pendingTotpPartialToken = "";
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
        onToggleAutoLogin(profileId, enabled) {
          profileManager.setAutoLogin(enabled ? profileId : null);
          void profileManager.saveProfiles();
          connectPage.refreshProfiles(getProfileList());
        },
        onAutoLoginCancel() {
          autoLoginCancelled = true;
        },
      },
      getProfileList(),
    );

    let autoLoginCancelled = false;

    safeMount(connectPage, appEl!);

    // Periodic health check — re-run every 15s so offline servers update when they come back
    const healthCheckInterval = setInterval(() => {
      runHealthChecks(connectPage, getProfileList());
    }, 15_000);

    // Wrap destroy to clear the interval
    currentPage = {
      destroy() {
        clearInterval(healthCheckInterval);
        connectPage.destroy?.();
      },
    };

    // Expose a health-refresh hook so trusting a first-use certificate can
    // re-check the now-reachable server without a full page navigation.
    rerunConnectHealth = () => runHealthChecks(connectPage, getProfileList());

    // Route deep-link invites into this connect page. Apply any that arrived
    // before it mounted.
    applyInviteToConnectPage = (code, host) => connectPage.applyInviteLink(code, host);
    if (pendingInviteLink !== null) {
      connectPage.applyInviteLink(pendingInviteLink.code, pendingInviteLink.host);
      pendingInviteLink = null;
    }

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

      // Quick-switch: if the user switched servers via the overlay, auto-select
      // the target server profile so they can reconnect with one click.
      const quickSwitchTarget = sessionStorage.getItem("owncord:quick-switch-target");
      if (quickSwitchTarget !== null) {
        sessionStorage.removeItem("owncord:quick-switch-target");
        const targetProfile = profileManager.getAll().find((p) => p.host === quickSwitchTarget);
        connectPage.selectServer(quickSwitchTarget, targetProfile?.username ?? undefined);
        return; // Skip auto-login when switching servers
      }

      // Auto-login: if a profile has autoConnect enabled, try to reconnect
      // using the stored token (password is no longer returned from the
      // credential store over IPC for security).
      const autoProfile = profileManager.getAutoConnectProfile();
      if (autoProfile) {
        try {
          const cred = await loadCredential(autoProfile.host);
          if (cred?.username && cred?.token && !autoLoginCancelled) {
            connectPage.selectServer(autoProfile.host, cred.username);
            connectPage.showAutoConnecting(autoProfile.name);

            if (autoLoginCancelled) return;

            // Use stored token directly for reconnection. Preserve the
            // profile's existing rememberPassword rather than forcing it to
            // false (autoConnect profiles always have it true — see
            // setAutoLogin), and skip wirePostAuth's credential re-save: the
            // password is never returned over IPC here, so saving with
            // rememberPassword defaulted to true would call saveCredential
            // with password undefined, which rewrites the whole stored
            // blob and silently destroys any password the user opted to
            // remember (save_credential only carries the password key
            // `if let Some(...)`, so a None wipes it — see credentials.rs).
            api.setConfig({ host: autoProfile.host });
            ensureProfileExists(autoProfile.host, cred.username, autoProfile.rememberPassword);
            wirePostAuth(autoProfile.host, cred.token, cred.username, undefined, false);
            return;
          }
        } catch (err) {
          if (!autoLoginCancelled) {
            const message = err instanceof Error ? err.message : "Auto-login failed";
            log.warn("Auto-login failed", { host: autoProfile.host, error: message });
            connectPage.showError(`Auto-login failed: ${message}`);
          }
        }
      }
    })();
  } else {
    // MainPage (and the LiveKit voice stack it statically imports) loads
    // lazily so it stays out of the startup path. The chunk is pre-warmed as
    // soon as the WS connect succeeds, so this normally resolves from the
    // module cache.
    const { createMainPage } = await import("@pages/MainPage");
    // A newer navigation may have superseded this one while the chunk loaded;
    // mounting now would fight the page that navigation rendered.
    if (!isCurrentNavigation()) return;
    const mainPage = createMainPage({ ws, api });
    safeMount(mainPage, appEl!);
    currentPage = mainPage;
  }
}

// Listen for navigation changes
router.onNavigate((pageId) => {
  void renderPage(pageId);
});

// Handle logout / disconnect
authStore.subscribeSelector(
  (s) => s.isAuthenticated,
  (isAuthenticated) => {
    if (!isAuthenticated && router.getCurrentPage() === "main") {
      // Leave voice channel before disconnecting so other clients see it
      // immediately. Gated on clearAuth's logoutWasInVoice snapshot rather
      // than the live voiceStore: clearAuth applies state (including this
      // isAuthenticated flip) synchronously and already reset voiceStore in
      // that same call, before this subscriber ever runs (store
      // notifications are microtask-deferred) — voiceStore here would always
      // read "idle".
      if (authStore.getState().logoutWasInVoice === true) {
        voiceSessionLeave(false); // false: we send voice_leave below
        ws.send({ type: "voice_leave", payload: {} });
        leaveVoiceChannel();
      }
      dispatcherCleanup?.();
      dispatcherCleanup = null;
      sessionCleanup?.();
      sessionCleanup = null;
      ws.disconnect();
      lastConnectToken = "";
      lastConnectHost = "";
      // Clear stored credential on logout — but keep it when the server
      // kicked us by shutting down: the token is still valid, and deleting
      // the credential would break auto-login every time the server restarts.
      const host = api.getConfig().host;
      if (host && authStore.getState().logoutReason !== "server_shutdown") {
        void deleteCredential(host);
      }
      router.navigate("connect");
    }
  },
);

// Send voice_leave on window close (best-effort — server readPump defer is the safety net)
window.addEventListener("beforeunload", () => {
  const voice = voiceStore.getState();
  if (voice.currentChannelId !== null) {
    voiceSessionLeave(false); // false: we send voice_leave below
    ws.send({ type: "voice_leave", payload: {} });
  }
  // Flush any buffered log entries to disk before the window closes.
  void flushLogs();
});

// Initial render (fire-and-forget — the initial page is "connect", whose
// render branch is synchronous)
void renderPage(router.getCurrentPage());

// Initialize window state persistence (fire-and-forget)
void initWindowState();

// Route owncord:// invite deep links into the register form. OwnCord invites
// are registration invites, so a link can only pre-fill + open the register
// form — it can't complete a join by itself.
function handleInviteDeepLink(code: string, host?: string): void {
  pendingInviteLink = { code, host };
  router.navigate("connect");
  // If the connect page was already mounted, navigate() may not re-render it —
  // apply directly. Otherwise the connect render branch consumes the pending link.
  if (pendingInviteLink !== null && applyInviteToConnectPage !== null) {
    applyInviteToConnectPage(code, host);
    pendingInviteLink = null;
  }
}
// Route owncord://message/<channelId>/<messageId> permalinks to the main
// page's jumper. Before the main page mounts (or when the channel isn't
// visible to this user) the jump is a logged no-op — a link into a server the
// user is not signed into has nothing to open.
function handleMessageDeepLink(channelId: number, messageId: number): void {
  jumpToMessage(channelId, messageId);
}
void initDeepLinks(handleInviteDeepLink, handleMessageDeepLink);

// Initialize log persistence to disk (fire-and-forget)
void initLogPersistence();

log.info("OwnCord client initialized");
