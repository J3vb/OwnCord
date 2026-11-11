// OwnCord Tauri v2 Client — Entry Point

import "@styles/tokens.css";
import "@styles/base.css";
import "@styles/login.css";
import "@styles/app.css";
import "@styles/theme-neon-glow.css";

import { installGlobalErrorHandlers } from "@lib/text/safeRender";
import { createApiClient } from "@lib/api";
import { installGlobalGuards } from "./app/globalGuards";

import { deactivatePendingMessages } from "@lib/pendingMessages";
import { settleNotificationLevelDefault } from "@lib/prefs/notificationLevel";
import { createWsClient } from "@lib/ws";
import { markActiveChannelReadOnUnload } from "@lib/readState";
import { registerSessionReset } from "@lib/net/sessionRegistry";
import { authStore, clearAuth } from "@stores/auth.store";
import { setTransientError } from "@stores/ui.store";
import { voiceStore } from "@stores/voice.store";
import { configureSession, installLogoutTeardown, voiceSessionLeave } from "./app/session";
import { createLogger, applyStoredLogLevel } from "@lib/logger";
import { initLogPersistence, flushLogs } from "@lib/logPersistence";
import { createProfileManager, createTauriBackend } from "@lib/presence/profiles";

import { desktop } from "./platform/desktop";
import { connectText } from "./i18n/connect";
import { installCertPrompts } from "./app/certPrompts";
import { configureServerHealth } from "./app/serverHealth";
import { configureRouter, activePageId, navigate, renderActive, rerunHealth } from "./app/router";
import { afterCoreSteps, beforeRenderSteps, runStartupSteps } from "./app/startup";

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
// The diagnostic event log and the app's own lifecycle events, off the startup
// path; owners that record earlier are queued until it attaches.
void import("@lib/diagnostics/appEvents")
  .then((m) => m.startAppEvents(desktop.appMetadata, desktop.logFiles))
  .catch((e: unknown) => log.warn("Diagnostic event log failed to start", e));

runStartupSteps(beforeRenderSteps, { log });

const appEl = document.getElementById("app");
if (!appEl) {
  throw new Error("Missing #app element"); // i18n-exempt: developer error, index.html always ships #app
}

// Create core services
// REST traffic is tunneled through the Rust HTTP TOFU proxy (src/lib/net/httpProxy.ts
// → src-tauri/src/http_proxy.rs), which pins the server certificate to the same
// trust-on-first-use fingerprint as the WS proxy. No cert is ever blindly
// accepted; the bearer token never rides an unpinned TLS connection.
/** The API client's 401 sink: a live session's token was refused. */
function handleUnauthorized(): void {
  log.warn("Session expired (401), clearing auth");
  // A 401 on a request made before any session existed is not a session
  // "expiring" (the sign-in calls skip this sink, so a refused password never
  // gets here). Only warn about a session that was live.
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
const profileManager = createProfileManager(createTauriBackend());
configureRouter(api, ws, appEl, profileManager);
configureSession(api, ws, appEl, activePageId, navigate);
configureServerHealth(api);

installCertPrompts(ws, activePageId, navigate, rerunHealth);

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

runStartupSteps(afterCoreSteps(api), { log });

log.info("OwnCord client initialized");
