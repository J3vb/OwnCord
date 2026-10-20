// OwnCord Tauri v2 Client — Entry Point

import "@styles/tokens.css";
import "@styles/base.css";
import "@styles/login.css";
import "@styles/app.css";
import "@styles/theme-neon-glow.css";

import {
  installGlobalErrorHandlers,
  renderFallback,
  safeMount,
  type RenderRecovery,
} from "@lib/safe-render";
import { createApiClient, ApiClientError } from "@lib/api";
import { SessionScope } from "@lib/sessionScope";
import { Disposable } from "@lib/disposable";
import { installGlobalGuards } from "./app/globalGuards";
import type { PageId } from "./app/context";

import { deactivatePendingMessages } from "@lib/pendingMessages";
import { openMessageTarget, openNotificationTarget } from "@lib/notifications";
import { settleNotificationLevelDefault } from "@lib/notificationLevel";
import { bracketBareIPv6Host, createWsClient } from "@lib/ws";
import { wireConnectionStatus } from "@lib/dispatcher";
import { markActiveChannelReadOnUnload } from "@lib/read-state";
import { registerSessionReset } from "@lib/sessionRegistry";
import { authStore, clearAuth } from "@stores/auth.store";
import {
  setTransientError,
  uiStore,
  setUpdateRequiredHost,
  type UpdateRequired,
} from "@stores/ui.store";
import { voiceStore, leaveVoiceChannel } from "@stores/voice.store";
import { createConnectPage } from "@pages/ConnectPage";
import { applyStoredAppearance } from "@lib/appearance";
import { startZoom } from "./features/zoom/zoomKeys";
import { migrateAutoInputSensitivity, migrateInputMode } from "@lib/inputMode";
import { createUpdateNotifier } from "@components/UpdateNotifier";
import {
  abandonInFlight,
  configureSession,
  installLogoutTeardown,
  sessionInFlight,
  startSession,
  voiceSessionLeave,
} from "./app/session";
import type { MountableComponent } from "@lib/safe-render";
import { createLogger, applyStoredLogLevel } from "@lib/logger";
import { initLogPersistence, flushLogs } from "@lib/logPersistence";
import { deleteCredential, loginWithSavedPassword, parseRelayedLogin } from "@lib/credentials";
import { initWindowState } from "@lib/window-state";
import { createProfileManager, createTauriBackend } from "@lib/profiles";
import { parseRegistrationMode, retentionNotice } from "@lib/types";
import type { AuthResponse } from "@lib/types";
import { saveUserStatus } from "@lib/userStatus";
import { getActivePresenceSender } from "@lib/presence";
import { setInviteJoinHandler } from "@lib/invite-navigation";

import { desktop } from "./platform/desktop";
import { connectText } from "./i18n/connect";
import { installCertPrompts } from "./app/certPrompts";
import { createConnectProfiles } from "./app/connectProfiles";
import {
  configureServerHealth,
  probeServerInfo,
  runHealthChecks,
  serverInfoFor,
  serverInfoProbing,
} from "./app/serverHealth";
import { createAutoLogin } from "./app/autoLogin";

// First, while storage still holds only what earlier sessions wrote: that is
// how an install from before the notification level is told from a new one.
settleNotificationLevelDefault();

// Gate the log level before anything logs: debug entries are serialized and
// persisted to disk, so in production the level must filter real work, not
// just console noise. Honors the level saved on the Logs settings tab; when
// unset, dev builds keep full debug output and production defaults to info.
applyStoredLogLevel(import.meta.env.DEV ? "debug" : "info");

const log = createLogger("main");

installGlobalGuards();

// Install global error handlers first
installGlobalErrorHandlers();

// Start log persistence immediately after: an early startup failure (a missing
// #app element, a failing lazy chunk) must still reach the on-disk log, not
// just the in-memory ring. The listener is installed before the first render
// and back-fills the bootstrap window (CLI-03).
void initLogPersistence();

// Apply stored theme/font/compact preferences before first render
applyStoredAppearance();
// Native webview zoom: the stored level now, and the zoom keys everywhere.
startZoom(() => import("./features/zoom").then((m) => m.appZoom), new Disposable().signal);

// A profile from before automatic sensitivity keeps a tuned slider.
migrateAutoInputSensitivity();

// Start push-to-talk listener (Rust-side polling, non-consuming), once the
// input mode is settled: a profile from before Input Mode keeps its PTT key.
migrateInputMode();
void desktop.pushToTalk.init();

const appEl = document.getElementById("app");
if (!appEl) {
  throw new Error("Missing #app element"); // i18n-exempt: developer error, index.html always ships #app
}

// The active page. `currentPage` further down holds the mounted page
// *component*, so the page id needs its own name.
let activePage: PageId = "connect";

/** Switch pages, re-rendering only when the page actually changed. */
function navigate(page: PageId): void {
  if (page === activePage) return;
  activePage = page;
  void renderPage(page);
}

// Create core services
// REST traffic is tunneled through the Rust HTTP TOFU proxy (src/lib/httpProxy.ts
// → src-tauri/src/http_proxy.rs), which pins the server certificate to the same
// trust-on-first-use fingerprint as the WS proxy. No cert is ever blindly
// accepted; the bearer token never rides an unpinned TLS connection.
/** Shared 401 handling, named so the saved-password relay path can run the
 *  same side effect `api.ts` runs for an ordinary request. */
function handleUnauthorized(): void {
  log.warn("Session expired (401), clearing auth");
  // A 401 on a request made before any session existed (e.g. a failed login
  // attempt) is not a session "expiring" — the login form's own catch block
  // already surfaces that failure. Only warn about a session that was live.
  if (authStore.getState().isAuthenticated) {
    setTransientError(connectText("session.expired"));
  }
  clearAuth();
}
const api = createApiClient({ host: "" }, handleUnauthorized);
const ws = createWsClient();
// Diagnostics back the lazily loaded Settings > Diagnostics & logs panel, so their engine and
// text stay out of the startup chunk (B9-20). The import resolves long before
// the panel can be opened, and the panel's own module imports the same chunk.
void import("@lib/connectionDiagnostics").then(({ configureConnectionDiagnostics }) => {
  configureConnectionDiagnostics(api, ws);
});
// App-lifetime hook: main.ts runs once per window. The other per-server resets
// register themselves from their own modules.
void registerSessionReset(
  "main:pending-and-api",
  (reason) => {
    // Server switches retain their account-scoped drafts. Explicit logout and
    // invalid credentials discard pending sends.
    try {
      deactivatePendingMessages({
        discard:
          reason === "user" && sessionStorage.getItem("owncord:quick-switch-target") === null,
      });
    } finally {
      api.endSession();
    }
  },
  { phase: "session" },
);
// Single writer for the UX-facing connection status (docs/architecture/ux §3):
// live controls read ui.store.connectionStatus reactively instead of wiring
// their own ws.onStateChange. Lifecycle plumbing that needs the exact internal
// transition (the connected overlay below) stays on ws.onStateChange.
wireConnectionStatus(ws);
const profileManager = createProfileManager(createTauriBackend());
configureSession(api, ws, appEl, () => activePage, navigate);
configureServerHealth(api);
// Re-run the connect page's health checks (set while the connect page is
// mounted, cleared otherwise) — refreshes a server's status after its
// certificate is trusted for the first time.
let rerunConnectHealth: (() => void) | null = null;
// Set while the connect page is mounted so an owncord:// deep link can pre-fill
// its register form; the pending value covers links that arrive before it mounts.
let applyInviteToConnectPage: ((code: string, host?: string) => void) | null = null;
let pendingInviteLink: { code: string; host?: string } | null = null;

installCertPrompts(
  ws,
  () => activePage,
  navigate,
  () => rerunConnectHealth?.(),
);

// Route the tray's Status submenu (Online/Idle/Do Not Disturb/Offline) into
// the same path the in-app StatusPicker uses (UserBar.ts): persist through
// saveUserStatus() — lib/userStatus.ts's documented single source of truth —
// before sending the wire message, not just a raw ws.send. Without this the
// tray's choice never reaches loadUserStatus(), so notifications.ts's DND
// gate, autoIdle's "never touch a manual DND/invisible" guard, and
// restoreSavedPresence() on the next reconnect all silently disagree with
// what the tray just set (OC-0037). The send itself goes through the
// session's shared PresenceSender (registered by MainPage.ts via
// setActivePresenceSender) rather than a raw ws.send: the server enforces a
// single 1-update/10s budget per user regardless of which surface sent the
// frame, and a raw send here would open a second, uncoordinated budget that
// silently drops whichever frame the server sees second (OC-0176). When no
// session is mounted the optional call is a no-op, matching the old raw
// ws.send's "safe no-op when disconnected" behavior, so no auth guard is
// needed here.
desktop.trayStatus.onStatusChange((status) => {
  if (status === "online" || status === "idle" || status === "dnd" || status === "offline") {
    // The tray's legacy "offline" spelling maps to "invisible" the same way
    // userStatus.ts migrates an old client's stored "offline" value (see its
    // doc comment) — the local pref and the wire message must agree.
    const mapped = status === "offline" ? "invisible" : status;
    saveUserStatus(mapped);
    getActivePresenceSender()?.send(mapped);
  }
});

// Current page component reference for cleanup
let currentPage: { destroy?(): void } | null = null;

// Guards the async MainPage mount below against the destroy-before-mount race:
// a stale mount is discarded when a newer navigation supersedes it.
let navGeneration = 0;

/** Longest Reload waits for the voice leave before reloading regardless. */
const RELOAD_VOICE_LEAVE_TIMEOUT_MS = 2000;

// The two ways out of a page that failed to render (the fallback's buttons).
// F5 and Ctrl+R are blocked, so without these a failed render is a dead end.
// One reload at a time: a second click while the voice leave is pending must
// wait for it too, not reload straight away.
let reloadInFlight: Promise<void> | null = null;

async function reloadAfterVoiceLeave(): Promise<void> {
  // Leave a call first, the way a logout does, so other members don't see a
  // ghost in the channel and no native call stays live behind the reloaded
  // page. The leave is awaited (the native room's disconnect finishes in the
  // host) but bounded: a hung or failed leave must not strand the user on
  // the fallback.
  if (voiceStore.getState().currentChannelId !== null) {
    ws.send({ type: "voice_leave", payload: {} });
    leaveVoiceChannel();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        import("@lib/livekitSession").then(({ leaveVoice }) => leaveVoice(false)),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, RELOAD_VOICE_LEAVE_TIMEOUT_MS);
        }),
      ]);
    } catch (err) {
      log.warn("Failed to leave voice before reload", err);
    } finally {
      clearTimeout(timer);
    }
  }
  window.location.reload();
}

const renderRecovery: RenderRecovery = {
  reload: () => {
    reloadInFlight ??= reloadAfterVoiceLeave().finally(() => {
      reloadInFlight = null;
    });
    return reloadInFlight;
  },
  signOut: () => {
    const wasSignedIn = authStore.getState().isAuthenticated;
    clearAuth();
    // A signed-in logout is navigated by the authStore subscriber (it needs
    // the router still on "main"); only a session that never authenticated
    // has to be sent back here.
    if (wasSignedIn) return;
    if (activePage === "connect") void renderPage("connect");
    else navigate("connect");
  },
};

// Render the appropriate page based on router state
async function renderPage(pageId: PageId): Promise<void> {
  const thisNavigation = ++navGeneration;
  const isCurrentNavigation = (): boolean => thisNavigation === navGeneration;
  log.info("Navigating to page", { pageId });
  // Destroy previous page
  currentPage?.destroy?.();
  currentPage = null;
  appEl!.textContent = "";
  // Only valid while the connect page is mounted (re-set in its render branch).
  rerunConnectHealth = null;
  applyInviteToConnectPage = null;

  // Track partial auth state for TOTP flow
  let pendingTotpHost = "";
  let pendingTotpPartialToken = "";
  let pendingTotpUsername = "";

  if (pageId === "connect") {
    const pageOwner = new SessionScope({ host: "", generation: 0 });
    const [getProfileList, persistProfiles, mutateAutoLogin, ensureProfileExists] =
      createConnectProfiles(profileManager, pageOwner);

    // Shared tail of both login paths: branch to the 2FA challenge, or wire the
    // session. Structural rather than duplicated, so the saved-password path
    // cannot drift from the typed-password one. `password` is undefined on the
    // saved-password path — the plaintext never leaves the credential store,
    // and save_credential preserves it when none is supplied.
    function completeLogin(
      host: string,
      username: string,
      result: AuthResponse,
      password?: string,
    ): void {
      if (result.requires_2fa) {
        pendingTotpHost = host;
        pendingTotpPartialToken = result.partial_token ?? "";
        pendingTotpUsername = username;
        connectPage.showTotp();
        return;
      }
      if (!result.token) return;
      const remember = connectPage.getRememberPassword();
      ensureProfileExists(host, username, remember, connectPage.getAutoConnect());
      startSession(
        host,
        result.token,
        username,
        remember ? password : undefined,
        remember,
        true,
        undefined,
        connectPage.getAutoConnect(),
      );
    }

    const connectPage = createConnectPage(
      {
        // The mode is read from the per-host snapshot `runHealthChecks` fills
        // beside the health probe. Unknown (no snapshot / unrecognised value)
        // returns null, which LoginForm treats as invite-required.
        getRegistrationMode(host) {
          const info = serverInfoFor(host);
          return parseRegistrationMode(info?.registration_mode);
        },
        getRetentionNotice: (host) => retentionNotice(serverInfoFor(host)),
        // A typed host has no health row; probe it so register mode can read its mode.
        onHostSettled(host) {
          if (!serverInfoFor(host) && !serverInfoProbing(host))
            void probeServerInfo(connectPage, host, pageOwner);
        },
        async onLogin(host, username, password) {
          api.endSession();
          api.setConfig({ host });
          const attempt = api.getSession();
          const result = await api.login(username, password);
          attempt.assertCurrent();
          pageOwner.assertCurrent();
          completeLogin(host, username, result, password);
        },
        async onLoginWithSavedPassword(host, username) {
          api.endSession();
          api.setConfig({ host });
          const attempt = api.getSession();
          // loginWithSavedPassword's own IPC await isn't cancellable, so a
          // cancelled login would otherwise hang until the backend's own
          // SAVED_LOGIN_TIMEOUT — route it through the scope so it rejects
          // promptly instead.
          const relayed = await attempt.run(loginWithSavedPassword(host, username));
          attempt.assertCurrent();
          pageOwner.assertCurrent();
          if (!relayed) {
            throw new Error(connectText("session.savedLoginUnavailable"));
          }
          // The relayed body is the same AuthResponse shape api.login returns,
          // so from here the flow is literally the typed-password one.
          let result;
          try {
            result = parseRelayedLogin(relayed);
          } catch (err) {
            // Run the same side effect `api.ts` runs for a 401 on any other
            // request, so the two login paths cannot diverge on session state.
            if (err instanceof ApiClientError && err.status === 401) {
              handleUnauthorized();
            }
            throw err;
          }
          completeLogin(host, username, result);
        },
        async onRegister(host, username, password, inviteCode) {
          api.endSession();
          api.setConfig({ host });
          const attempt = api.getSession();
          const result = await api.register(username, password, inviteCode);
          attempt.assertCurrent();
          pageOwner.assertCurrent();
          if (result.status === "pending_approval" || result.token === undefined) {
            // Approval mode (B4-1): no session yet — an admin decides. This is
            // an expected state, not a failure, so it is an informational
            // notice rather than a red error (DP-54).
            connectPage.showNotice(connectText("registration.pendingApproval"));
            return;
          }
          const remember = connectPage.getRememberPassword();
          const savedPassword = remember ? password : undefined;
          ensureProfileExists(host, username, remember, connectPage.getAutoConnect());
          startSession(
            host,
            result.token,
            username,
            savedPassword,
            remember,
            true,
            undefined,
            connectPage.getAutoConnect(),
          );
        },
        async onRecover(host, username, secret, newPassword) {
          api.endSession();
          api.setConfig({ host });
          const attempt = api.getSession();
          const result = await api.recoverAccount(username, secret, newPassword);
          attempt.assertCurrent();
          pageOwner.assertCurrent();
          // The login shape: sign the session in exactly as a login does.
          completeLogin(host, username, result, newPassword);
        },
        async onTotpSubmit(code) {
          if (!pendingTotpPartialToken) {
            log.error("TOTP submit without pending partial token");
            return;
          }
          const attempt = api.getSession();
          const result = await api.verifyTotp(code, pendingTotpPartialToken);
          attempt.assertCurrent();
          pageOwner.assertCurrent();
          if (result.token) {
            // Clear the sensitive partial token now that it has been
            // exchanged for a real session token. A rejected code must NOT
            // clear it here — the TOTP *code* is single-use (the server
            // 401s a replay), but the partial token is the short-lived 2FA
            // challenge itself and stays valid for a retry. LoginForm keeps
            // the TOTP overlay open across a failed verify for exactly that
            // retry; clearing this unconditionally (the old `finally`) made
            // every retry hit the guard above and silently do nothing.
            pendingTotpPartialToken = "";
            const remember = connectPage.getRememberPassword();
            // "" when the saved-password placeholder was used — save_credential
            // then keeps the stored password rather than clearing it.
            const savedPassword = remember ? connectPage.getPassword() || undefined : undefined;
            ensureProfileExists(
              pendingTotpHost,
              pendingTotpUsername,
              remember,
              connectPage.getAutoConnect(),
            );
            startSession(
              pendingTotpHost,
              result.token,
              pendingTotpUsername,
              savedPassword,
              remember,
              true,
              undefined,
              connectPage.getAutoConnect(),
            );
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
          persistProfiles();
          connectPage.refreshProfiles(getProfileList());
          // Check health for the new profile
          runHealthChecks(connectPage, getProfileList(), pageOwner);
        },
        onDeleteProfile(profileId) {
          // Look the host up before removal: deleting a saved profile must
          // also drop its OS credential, or re-adding the same host resumes
          // the old remembered password (F11). Credentials are keyed by host,
          // so keep it while another profile still points at that server.
          const host = profileManager.getAll().find((p) => p.id === profileId)?.host;
          profileManager.removeProfile(profileId);
          if (host && !profileManager.getAll().some((p) => p.host === host)) {
            void deleteCredential(host);
            forgetServerWait(host);
          }
          persistProfiles();
          connectPage.refreshProfiles(getProfileList());
        },
        onToggleAutoLogin(profileId, enabled) {
          mutateAutoLogin(() => profileManager.setAutoLogin(enabled ? profileId : null));
          persistProfiles();
          connectPage.refreshProfiles(getProfileList());
        },
        onAutoLoginCancel() {
          cancelAutoLogin();
          deactivatePendingMessages();
          api.endSession();
          // Every read of this flag (in app/autoLogin.ts) runs before the overlay carrying
          // this Cancel button is ever painted, so by the time a click
          // reaches here the session is already in flight (startSession has
          // called ws.connect and registered listeners). Tear it down the
          // same way the logout path does.
          abandonInFlight();
        },
        onUpdateClient(host) {
          mountUpdateNotifier(host);
        },
      },
      getProfileList(),
    );

    const [startAutoLogin, cancelAutoLogin, forgetServerWait] = createAutoLogin(
      api,
      profileManager,
      pageOwner,
      connectPage,
      ensureProfileExists,
      getProfileList,
    );

    safeMount(connectPage, appEl!, renderRecovery);

    // A server refused this client's protocol epoch as too old: state the
    // requirement on the connect page itself and offer the update there. The
    // main page's notifier never mounts on a refusal, so without this the user
    // would have to fetch the installer by hand. Subscribed, not read once:
    // on a first login or a startup auto-login this page is already mounted
    // when the refusal arrives and nothing re-renders it (no overlay exists
    // before auth_ok, so the isAuthenticated subscriber below does not
    // navigate).
    let updateNotifier: MountableComponent | null = null;
    const mountUpdateNotifier = (host: string): void => {
      // A later refusal (another server tried from this same page) replaces
      // the banner rather than being ignored.
      updateNotifier?.destroy?.();
      const notifier = createUpdateNotifier({ serverUrl: `https://${bracketBareIPv6Host(host)}` });
      notifier.mount(appEl!);
      updateNotifier = notifier;
    };
    const offerUpdate = (required: UpdateRequired | null): void => {
      if (!required) return;
      // Consume the fact: the next connect page must not re-offer it.
      setUpdateRequiredHost(null);
      connectPage.showIncompatible(required.host, required.serverEpoch, required.clientEpoch);
      if (required.serverEpoch !== null && required.serverEpoch > required.clientEpoch) {
        mountUpdateNotifier(required.host);
      }
    };
    const unsubUpdateRequired = uiStore.subscribeSelector((s) => s.updateRequiredHost, offerUpdate);
    offerUpdate(uiStore.getState().updateRequiredHost);

    // Periodic health check — re-run every 15s so offline servers update when they come back
    const healthCheckInterval = setInterval(() => {
      runHealthChecks(connectPage, getProfileList(), pageOwner);
    }, 15_000);

    pageOwner.addCleanup(() => clearInterval(healthCheckInterval));
    pageOwner.addCleanup(unsubUpdateRequired);
    // Page-owned checks and listeners cannot update a later connect screen.
    // Wrap destroy to clear the interval
    currentPage = {
      destroy() {
        pageOwner.dispose();
        updateNotifier?.destroy?.();
        connectPage.destroy?.();
      },
    };

    // Expose a health-refresh hook so trusting a first-use certificate can
    // re-check the now-reachable server without a full page navigation.
    rerunConnectHealth = () => runHealthChecks(connectPage, getProfileList(), pageOwner);

    // Route deep-link invites into this connect page. Apply any that arrived
    // before it mounted.
    applyInviteToConnectPage = (code, host) => connectPage.applyInviteLink(code, host);
    if (pendingInviteLink !== null) {
      connectPage.applyInviteLink(pendingInviteLink.code, pendingInviteLink.host);
      pendingInviteLink = null;
    }

    startAutoLogin();
  } else {
    // MainPage (and the LiveKit voice stack it statically imports) loads
    // lazily so it stays out of the startup path. The chunk is pre-warmed as
    // soon as the WS connect succeeds, so this normally resolves from the
    // module cache.
    try {
      const { createMainPage } = await import("@pages/MainPage");
      // A newer navigation may have superseded this one while the chunk loaded;
      // mounting now would fight the page that navigation rendered.
      if (!isCurrentNavigation()) return;
      const mainPage = createMainPage({
        ws,
        api,
        getRetentionNotice: () => retentionNotice(serverInfoFor(api.getConfig().host ?? "")),
      });
      safeMount(mainPage, appEl!, renderRecovery);
      currentPage = mainPage;
    } catch (err) {
      // A rejected chunk import (or a page factory that throws) would leave
      // the cleared window blank. Show the same fallback a failed mount does.
      log.error("Main page failed to load", err);
      if (isCurrentNavigation()) renderFallback(appEl!, err, renderRecovery);
    }
  }
}

installLogoutTeardown();

// Send voice_leave on window close (best-effort — server readPump defer is the safety net)
window.addEventListener("beforeunload", () => {
  const voice = voiceStore.getState();
  if (voice.currentChannelId !== null) {
    voiceSessionLeave(false); // false: we send voice_leave below
    ws.send({ type: "voice_leave", payload: {} });
  }
  deactivatePendingMessages();
  // Messages read live never raise an unread count, so no other path records
  // them as read before the window closes.
  markActiveChannelReadOnUnload();
  api.endSession();
  // Flush any buffered log entries to disk before the window closes.
  void flushLogs();
});

// Initial render (fire-and-forget — the initial page is "connect", whose
// render branch is synchronous), then tell the native host's startup watchdog
// the window came up.
void renderPage(activePage).then(() =>
  desktop.appProcess.reportReady().catch((err) => log.warn("Failed to report frontend ready", err)),
);

// Initialize window state persistence (fire-and-forget)
void initWindowState();

// Route owncord:// invite deep links into the register form. OwnCord invites
// are registration invites, so a link can only pre-fill + open the register
// form — it can't complete a join by itself.
function handleInviteDeepLink(code: string, host?: string): void {
  pendingInviteLink = { code, host };
  if (activePage === "main") {
    // Let the logout path do the teardown instead of navigating behind a
    // live session: clearAuth() fires while the router is still on "main",
    // so the authStore subscriber above runs its full teardown (voice leave,
    // dispatcher/session cleanup, ws.disconnect) and navigates to "connect"
    // itself — whose render branch consumes pendingInviteLink below.
    //
    // "server_switch", not the default "user": the invite is not a logout, so
    // the current server's credential must survive (the user may return to A
    // later) — the same reason the quick-switch path uses it (F7).
    clearAuth("server_switch");
    return;
  }
  deactivatePendingMessages();
  api.endSession();
  if (sessionInFlight()) {
    // startSession already ran — a login/auto-login/register is connecting,
    // or reached auth_ok (isAuthenticated flipped true) but the connected
    // overlay's ready hand-off hasn't called navigate("main") yet, so
    // the branch above never triggered. The authStore subscriber only tears
    // down once the active page IS "main", so it won't fire for this window
    // either: left alone, the overlay's timer fires navigate("main")
    // regardless, mounting MainPage on top of whatever this handler does to
    // authStore below. Tear the in-flight session down directly, the same
    // way onAutoLoginCancel does, before applying the invite below.
    abandonInFlight();
    if (authStore.getState().isAuthenticated) {
      clearAuth();
    }
  }
  navigate("connect");
  // If the connect page was already mounted, navigate() may not re-render it —
  // apply directly. Otherwise the connect render branch consumes the pending link.
  if (pendingInviteLink !== null && applyInviteToConnectPage !== null) {
    applyInviteToConnectPage(code, host);
    pendingInviteLink = null;
  }
}
// Route owncord://message/<channelId>/<messageId> permalinks, and a call
// toast's owncord://channel/<channelId> (no message id), to the main
// page's jumper. Before the main page mounts (or when the channel isn't
// visible to this user) the jump is a logged no-op — a link into a server the
// user is not signed into has nothing to open. A link that named a server (a
// Windows toast's launch URI) is ignored when another server is signed in now,
// the same guard a clicked notification goes through.
function handleMessageDeepLink(
  channelId: number,
  messageId: number | undefined,
  host?: string,
): void {
  openMessageTarget(channelId, messageId, host);
}
// An invite link from outside the app (the OS, a browser, another program)
// would otherwise end the signed-in session the moment it arrives. While
// signed in (or signing in), ask first; Cancel leaves everything as it is and the
// link is dropped. Elsewhere (connect page) nothing is lost, so it runs as
// before. A second link while the dialog is open replaces the first.
function handleExternalInviteLink(code: string, host?: string): void {
  // Signed in, or signing in (the connect call is in flight, or the connected
  // overlay is still up before the main page mounts): taking the link ends
  // that session, so ask. Otherwise nothing is lost and it runs as before.
  if (activePage !== "main" && !authStore.getState().isAuthenticated && !sessionInFlight()) {
    handleInviteDeepLink(code, host);
    return;
  }
  const inVoice = voiceStore.getState().currentChannelId !== null;
  const currentName = authStore.getState().serverName ?? api.getConfig().host;
  // On demand, like the in-chat chip: keeps the modal and its catalog out of
  // the startup chunk.
  void Promise.all([import("@components/InviteJoinConfirm"), import("./i18n/messaging")])
    .then(([{ confirmInviteJoin }, { messagingText }]) => {
      const current =
        currentName === undefined || currentName === ""
          ? messagingText("invite.thisServer")
          : currentName;
      confirmInviteJoin(
        messagingText(inVoice ? "invite.openBodyInVoice" : "invite.openBody", { current }),
        () => handleInviteDeepLink(code, host),
        {
          title:
            host === undefined
              ? messagingText("invite.openTitleNoHost")
              : messagingText("invite.openTitle", { target: host }),
          confirmLabel: messagingText("invite.openButton"),
        },
      );
    })
    .catch((err: unknown) => log.warn("Invite confirmation failed to open", err));
}
// An invite chip clicked in chat already asked ("Leave X to join Y?") through
// the same dialog before it reached this handler, so it goes straight in.
setInviteJoinHandler(handleInviteDeepLink);
void desktop.deepLinks.init(handleExternalInviteLink, handleMessageDeepLink);

// A clicked message notification opens the message it was for (U1d). The native
// host emits `notification-click` with the target; routing it through the same
// jumper a permalink uses keeps one implementation.
desktop.notifier.onMessageActivated(openNotificationTarget);

log.info("OwnCord client initialized");
