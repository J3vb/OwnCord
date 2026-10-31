// OwnCord Tauri v2 Client — Entry Point

import "@styles/tokens.css";
import "@styles/base.css";
import "@styles/login.css";
import "@styles/app.css";
import "@styles/theme-neon-glow.css";

import { installGlobalErrorHandlers } from "@lib/text/safeRender";
import { createApiClient } from "@lib/api";
import { Disposable } from "@lib/disposable";
import { isAndroidHost } from "@lib/hostPlatform";
import { installGlobalGuards } from "./app/globalGuards";

import { deactivatePendingMessages } from "@lib/pendingMessages";
import { openNotificationTarget } from "@lib/notifications";
import { settleNotificationLevelDefault } from "@lib/prefs/notificationLevel";
import { createWsClient } from "@lib/ws";
import { wireConnectionStatus } from "@lib/dispatcher";
import { markActiveChannelReadOnUnload } from "@lib/readState";
import { registerSessionReset } from "@lib/net/sessionRegistry";
import { authStore, clearAuth } from "@stores/auth.store";
import { setTransientError } from "@stores/ui.store";
import { voiceStore } from "@stores/voice.store";
import { applyStoredAppearance } from "@lib/prefs/appearance";
import {
  applyStoredCustomTheme,
  installCustomThemeEscape,
} from "./features/custom-themes/customTheme";
import { startZoom } from "./features/zoom/zoomKeys";
import { migrateAutoInputSensitivity, migrateInputMode } from "@lib/ui/inputMode";
import { migrateVoiceSensitivityScale } from "@lib/voice/gateScale";
import { configureSession, installLogoutTeardown, voiceSessionLeave } from "./app/session";
import { createLogger, applyStoredLogLevel } from "@lib/logger";
import { initLogPersistence, flushLogs } from "@lib/logPersistence";
import { initWindowState } from "@lib/prefs/windowState";
import { createProfileManager, createTauriBackend } from "@lib/presence/profiles";
import { saveUserStatus } from "@lib/presence/userStatus";
import { getActivePresenceSender } from "@lib/presence/presence";

import { desktop } from "./platform/desktop";
import { connectText } from "./i18n/connect";
import { installCertPrompts } from "./app/certPrompts";
import { configureServerHealth } from "./app/serverHealth";
import { configureRouter, activePageId, navigate, renderActive, rerunHealth } from "./app/router";
import { installDeepLinks } from "./app/deepLinks";

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
// and back-fills the bootstrap window.
void initLogPersistence();

// Apply stored theme/font/compact preferences before first render
applyStoredAppearance();
// After the built-in theme and accent: a custom theme paints on top of them.
applyStoredCustomTheme();
// Native webview zoom: the stored level now, and the zoom keys everywhere.
startZoom(() => import("./features/zoom").then((m) => m.appZoom), new Disposable().signal);
// Ctrl+Shift+Backspace turns a custom CSS theme off, even one that hides the settings.
installCustomThemeEscape(new Disposable().signal);

// A profile from before automatic sensitivity keeps a tuned slider, and one
// from before the decibel slider keeps its gate level.
migrateAutoInputSensitivity();
migrateVoiceSensitivityScale();

// Start push-to-talk listener (Rust-side polling, non-consuming), once the
// input mode is settled: a profile from before Input Mode keeps its PTT key.
migrateInputMode();
void desktop.pushToTalk.init();
// The Android app has no key to hold: its Push to Talk trigger is the
// on-screen talk button, loaded on first use.
if (isAndroidHost()) {
  void import("./features/voice/talkButton")
    .then((m) => m.startTalkButton(new Disposable().signal))
    .catch((e: unknown) => log.warn("Talk button failed to start", e));
  // Android silences a background app's mic unless a call service runs.
  void import("./features/voice/backgroundCall")
    .then((m) => m.startBackgroundCall(new Disposable().signal))
    .catch((e: unknown) => log.warn("Background call service failed to start", e));
}

const appEl = document.getElementById("app");
if (!appEl) {
  throw new Error("Missing #app element"); // i18n-exempt: developer error, index.html always ships #app
}

// Create core services
// REST traffic is tunneled through the Rust HTTP TOFU proxy (src/lib/net/httpProxy.ts
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
// text stay out of the startup chunk. The import resolves long before
// the panel can be opened, and the panel's own module imports the same chunk.
void import("@lib/net/connectionDiagnostics").then(({ configureConnectionDiagnostics }) => {
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
configureRouter(api, ws, appEl, profileManager, handleUnauthorized);
configureSession(api, ws, appEl, activePageId, navigate);
configureServerHealth(api);

installCertPrompts(ws, activePageId, navigate, rerunHealth);

// Route the tray's Status submenu (Online/Idle/Do Not Disturb/Offline) into
// the same path the in-app StatusPicker uses (UserBar.ts): persist through
// saveUserStatus() — lib/presence/userStatus.ts's documented single source of truth —
// before sending the wire message, not just a raw ws.send. Without this the
// tray's choice never reaches loadUserStatus(), so notifications.ts's DND
// gate, autoIdle's "never touch a manual DND/invisible" guard, and
// restoreSavedPresence() on the next reconnect all silently disagree with
// what the tray just set. The send itself goes through the
// session's shared PresenceSender (registered by MainPage.ts via
// setActivePresenceSender) rather than a raw ws.send: the server enforces a
// single 1-update/10s budget per user regardless of which surface sent the
// frame, and a raw send here would open a second, uncoordinated budget that
// silently drops whichever frame the server sees second. When no
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
void renderActive().then(() =>
  desktop.appProcess.reportReady().catch((err) => log.warn("Failed to report frontend ready", err)),
);

// Initialize window state persistence (fire-and-forget)
void initWindowState();

installDeepLinks(api);

// A clicked message notification opens the message it was for (U1d). The native
// host emits `notification-click` with the target; routing it through the same
// jumper a permalink uses keeps one implementation.
desktop.notifier.onMessageActivated(openNotificationTarget);

log.info("OwnCord client initialized");
