// The session lifecycle (SessionController): the transport-session state, the
// post-login wiring (dispatcher, session listeners, pre-auth deadline,
// connected overlay, credential save), the teardown shared by the cancel and
// invite paths, and the logout subscriber. Moved out of main.ts verbatim; the
// controller is module functions plus one configureSession() call, with no
// class or factory object. Nothing here runs at import time: main.ts calls
// configureSession() and installLogoutTeardown() at the points in the boot
// order where this code used to be inline.
//
// The invariant every teardown path keeps: api.endSession() (or the session
// reset clearAuth runs) disposes the session scope before ws.disconnect(). The
// explicit cleanups that sit before or after the disconnect are redundant with
// that scope, but they are kept in their original places.

import { TLS_CERT_CODE, type ApiClient } from "@lib/api";
import { prefetchMainPage } from "@pages/mainPagePrefetch";
import {
  normalizeHostForCertCompare,
  PREAUTH_BUSY_CAP_MS,
  PREAUTH_CONNECT_TIMEOUT_MS,
  type WsClient,
} from "@lib/ws";
import { wireDispatcher } from "@lib/dispatcher";
import { setIdentityKeyProvider } from "@lib/ws";
import { setLastChannelHost } from "@lib/last-channel";
import { authStore } from "@stores/auth.store";
import { setTransientError } from "@stores/ui.store";
import { leaveVoiceChannel } from "@stores/voice.store";
import { createConnectedOverlay } from "@components/ConnectedOverlay";
import type { ConnectedOverlayControl } from "@components/ConnectedOverlay";
import { createLogger } from "@lib/logger";
import {
  saveCredential,
  deleteCredential,
  createUserUpdateCredentialSaver,
} from "@lib/credentials";
import { connectText } from "../i18n/connect";
import type { PageId } from "./context";

const log = createLogger("main");

let api: ApiClient;
let ws: WsClient;
let appEl: HTMLElement;
let currentPage: () => PageId;
let navigate: (page: PageId) => void;

let dispatcherCleanup: (() => void) | null = null;
// Tears down the session-scoped WS listeners registered in startSession
// (user_update, onStateChange, ready). dispatcherCleanup only clears
// dispatcher-registered handlers, so these need their own teardown to avoid
// accumulating across login/logout/retry cycles.
let sessionCleanup: (() => void) | null = null;
let connectedOverlay: ConnectedOverlayControl | null = null;
let lastConnectHost = "";
let lastConnectToken = "";

/**
 * Hands the controller the services and the router's two operations it works
 * against. Call once, before anything else here. Positional rather than an
 * options object: object keys survive minification, and this runs in the
 * startup chunk.
 */
export function configureSession(
  apiClient: ApiClient,
  wsClient: WsClient,
  appElement: HTMLElement,
  currentPageId: () => PageId,
  navigateTo: (page: PageId) => void,
): void {
  api = apiClient;
  ws = wsClient;
  appEl = appElement;
  currentPage = currentPageId;
  navigate = navigateTo;
}

// livekitSession (and the ~1.3 MB livekit-client SDK behind it) is loaded
// lazily so it stays out of the startup path. When a voice session exists the
// module is necessarily already loaded, so this import resolves from the
// module cache in a microtask.
export function voiceSessionLeave(sendWsLeave: boolean): void {
  void import("@lib/livekitSession")
    .then(({ leaveVoice }) => leaveVoice(sendWsLeave))
    .catch((e) => log.warn("Failed to leave voice session", e));
}

/** The host and token of the transport session in flight or live, or null when there is none. */
export function sessionTarget(): { host: string; token: string } | null {
  return lastConnectHost ? { host: lastConnectHost, token: lastConnectToken } : null;
}

/** Whether a session has been started and not yet torn down (post-auth wiring ran). */
export function sessionInFlight(): boolean {
  return lastConnectHost !== "";
}

/**
 * Tear the in-flight session down directly: listeners, dispatcher, overlay,
 * then the socket. The caller ends the API session first. Used by the
 * auto-login cancel and the invite deep link.
 */
export function abandonInFlight(): void {
  sessionCleanup?.();
  sessionCleanup = null;
  dispatcherCleanup?.();
  dispatcherCleanup = null;
  connectedOverlay?.destroy();
  connectedOverlay = null;
  ws.disconnect();
  lastConnectHost = "";
  lastConnectToken = "";
}

// Shared helper for post-auth WS connect + overlay flow
export function startSession(
  host: string,
  token: string,
  username: string,
  password?: string,
  rememberPassword = true,
  // Whether this login is the user's own explicit choice about being
  // remembered. Only then may declining it delete an existing credential —
  // the auto-login path passes false, because it is replaying a stored
  // credential rather than expressing a preference, and deleting there would
  // destroy the very credential it just used.
  rememberIsUserChoice = false,
  // Runs after the pre-auth deadline gives up; a stored-token resume uses it
  // to keep waiting for a server that is still down.
  onPreauthTimeout?: () => void,
  // Stay-signed-in (Auto connect) keeps the session token even when
  // Remember password is off; the password itself is saved only with
  // `rememberPassword`.
  autoConnect = false,
): void {
  log.info("Post-auth wiring", { host, username });
  // Start downloading/parsing the MainPage chunk now so it overlaps the
  // socket handshake; the import at "connected" and the mount hit the cache.
  prefetchMainPage();
  // Tear down any prior session wiring so listeners and the connected
  // overlay never stack across a retry (a second startSession without an
  // intervening logout).
  sessionCleanup?.();
  sessionCleanup = null;
  dispatcherCleanup?.();
  dispatcherCleanup = null;
  connectedOverlay?.destroy();
  connectedOverlay = null;
  api.setConfig({ host, token });
  const owner = api.getSession();
  // Store token in authStore so the dispatcher's auth_ok handler has it
  authStore.setState((prev) => ({ ...prev, token }));
  lastConnectHost = host;
  lastConnectToken = token;
  // Scope the last-channel store to this server before the dispatcher
  // wires, so the first `ready` (which restores it) reads the right key.
  // It has to be here, not MainPage: the first ready arrives before MainPage
  // mounts, and it is what restores the last channel.
  setLastChannelHost(host);
  // The auth frame carries this device's identity public key, so peers verify
  // its voice announces against the device that signed them. Registered before
  // the dial; a keyring failure resolves null and the frame goes without it.
  // Lazy: the identity module pulls in the E2EE crypto layer, which the
  // session shell must not load just to dial.
  setIdentityKeyProvider(async (identityHost) =>
    (await import("@lib/identity")).getDeviceIdentityPublicKey(identityHost),
  );
  owner.addCleanup(() => setIdentityKeyProvider(null));
  ws.connect({ host, token });
  dispatcherCleanup = wireDispatcher(ws, api);
  owner.addCleanup(dispatcherCleanup);
  log.info("Dispatcher wired, connecting WS");

  // A stored-token resume (auto-login / quick switch) sends no REST preflight,
  // so a server that is down leaves this handshake behind the "Auto-connecting…"
  // overlay (or a manual login's spinner) while ws.ts retries forever. Bound the
  // FIRST authentication with a deadline: a never-authenticated attempt returns
  // to the form and says why, while a live session's later outages keep the
  // in-app reconnect banner and its retry loop. Cleared on the first "connected"
  // (auth_ok), a terminal disconnect, a first-use certificate prompt for this
  // host, or when the session tears down. A SERVER_BUSY refusal restarts it,
  // up to PREAUTH_BUSY_CAP_MS after this first attempt (P5-S04).
  const preauthStartedAt = Date.now();
  const onPreauthDeadline = (): void => {
    if (!owner.isCurrent()) return;
    log.warn("Pre-auth connection timed out", { host, timeoutMs: PREAUTH_CONNECT_TIMEOUT_MS });
    // Stop the retry loop and tear the dead attempt down exactly as a
    // cancelled auto-login does, then tell the user on the connect form.
    api.endSession();
    ws.disconnect();
    sessionCleanup?.();
    sessionCleanup = null;
    dispatcherCleanup?.();
    dispatcherCleanup = null;
    lastConnectHost = "";
    lastConnectToken = "";
    // A dial that failed on the certificate is not an unreachable server:
    // name it. `getConnectFailureCode` reads the distinct code the transport
    // reported for the rejected connect (ws.ts).
    setTransientError(
      ws.getConnectFailureCode() === TLS_CERT_CODE
        ? connectText("error.tlsFailed")
        : connectText("session.connectTimeout"),
    );
    onPreauthTimeout?.();
  };
  let preauthTimer: ReturnType<typeof setTimeout> | null = setTimeout(
    onPreauthDeadline,
    PREAUTH_CONNECT_TIMEOUT_MS,
  );
  const clearPreauthDeadline = (): void => {
    if (preauthTimer !== null) clearTimeout(preauthTimer);
    preauthTimer = null;
  };

  // Session-scoped WS listeners — collected so they're all removed together
  // on logout/disconnect (or the next startSession).
  const sessionUnsubs: Array<() => void> = [clearPreauthDeadline];
  // A first-use certificate prompt means the server answered: the user is
  // deciding, not waiting on an offline host, and Accept resumes this login.
  sessionUnsubs.push(
    ws.onCertFirstUse((evt) => {
      if (evt.host === normalizeHostForCertCompare(host)) clearPreauthDeadline();
    }),
  );
  sessionUnsubs.push(
    ws.onServerBusy(() => {
      if (preauthTimer === null) return;
      clearTimeout(preauthTimer);
      preauthTimer = setTimeout(
        onPreauthDeadline,
        Math.min(PREAUTH_CONNECT_TIMEOUT_MS, preauthStartedAt + PREAUTH_BUSY_CAP_MS - Date.now()),
      );
    }),
  );

  // Only persist credentials when the user opted in. The token is
  // kept when Auto connect OR Remember password is ticked; the password only
  // when Remember is ticked. Declining both is an active instruction, not
  // just an absence of one: a password stored under an earlier
  // opt-in must not outlive the opt-out, so the whole credential goes. The
  // username survives in the profile, so the form still prefills it.
  //
  // The web portal keeps the token for every login: an unticked "Stay signed
  // in" saves it session-only (it goes with the tab) rather than not at all,
  // so a reload does not sign the user out.
  const keepToken = __OWNCORD_WEB__ || rememberPassword || autoConnect;
  if (!keepToken && rememberIsUserChoice) {
    void (async () => {
      // The store holds one credential per host (`login_account(host) =
      // host`), and `save_credential` already overwrites it with no
      // username check — a remembered login by a second account on this
      // host would have clobbered it anyway. The stored username is a
      // stale copy, not an account identity, so guarding the delete on it
      // can't protect a second account; it can only leave the password the
      // user just declined sitting on disk. Delete unconditionally for the
      // host. Cost: if two accounts share a host, opting out as one
      // removes the credential the other saved.
      //
      // A failed delete leaves that password on disk. Silence there would
      // tell the user the opt-out took effect when it did not, so it is
      // surfaced the same way a failed save is.
      const removed = await deleteCredential(host);
      if (!removed && owner.isCurrent()) {
        log.warn("Credential delete failed — the saved password is still stored", {
          host,
        });
        setTransientError(connectText("session.passwordRemoveFailed"));
      }
    })();
  }
  if (keepToken) {
    // Auto connect without Remember: keep the token only. A user's own login
    // also erases any password saved under an earlier Remember opt-in
    // (clearPassword); a stored-token resume never clears anything.
    const clearPassword = !rememberPassword && rememberIsUserChoice;
    // The user's own login decides where a portal token lives; a resume says
    // nothing, so the token stays in the area it was read from.
    const savedPassword = rememberPassword ? password : undefined;
    (__OWNCORD_WEB__
      ? saveCredential(
          host,
          username,
          token,
          savedPassword,
          clearPassword,
          rememberIsUserChoice ? !autoConnect : undefined,
        )
      : saveCredential(host, username, token, savedPassword, clearPassword)
    )
      .then((ok) => {
        if (!ok && owner.isCurrent()) {
          log.warn("Credential save failed — auto-login will not work for this server");
          setTransientError(connectText("session.credentialsSaveFailed"));
        }
      })
      .catch(() => {
        // saveCredential already catches internally; this is defence-in-depth
      });
  }

  // Update saved credentials when the current user changes their username.
  // Guarded by the same remember-password opt-out as the initial save above.
  // No password is passed: save_credential preserves the stored
  // one when none is supplied, which is why the plaintext no longer has to
  // make a round trip through JavaScript.
  sessionUnsubs.push(
    ws.on(
      "user_update",
      __OWNCORD_WEB__
        ? createUserUpdateCredentialSaver(host, keepToken, () => {
            if (!owner.isCurrent()) return;
            log.warn("Credential re-save failed — auto-login will not work for this server");
            setTransientError(connectText("session.credentialsSaveFailed"));
          })
        : createUserUpdateCredentialSaver(host, keepToken),
    ),
  );

  const unsubState = ws.onStateChange((wsState) => {
    log.debug("WS state change", { state: wsState });
    if (wsState === "connected") {
      // Authenticated: the pre-auth deadline has nothing left to bound, and
      // keeping it would bounce a live session out on its first later outage.
      clearPreauthDeadline();
      // Stop listening once connected so a later transition can't fire this
      // handler again.
      unsubState();
      // Already prefetched at the top of startSession; this resolves from
      // the module cache and covers a prefetch that failed transiently.
      prefetchMainPage();
    } else if (wsState === "disconnected") {
      // Terminal non-connected transition (auth_error, cert-mismatch reject,
      // or intentional disconnect before ever connecting): drop the handler
      // so it doesn't linger and fire on a later connect. The pre-auth
      // deadline goes with it: it bounds only the endless retry loop, and
      // with this handler gone nothing would clear it on a later auth_ok
      // (a certificate re-dial after a mismatch).
      clearPreauthDeadline();
      unsubState();
    }
  });
  sessionUnsubs.push(unsubState);

  // Build the connected overlay from the auth_ok payload itself, not
  // authStore: ws.ts fires onStateChange("connected") synchronously BEFORE
  // dispatching the auth_ok message that carries server_name/motd
  // (setState() then dispatch() in the same handleMessage() call), so
  // authStore.setAuth() — run by the dispatcher's own auth_ok handler —
  // has not applied yet at that point. Reading straight from the payload
  // sidesteps the race instead of racing it.
  const unsubAuthOk = ws.on("auth_ok", (payload) => {
    unsubAuthOk();
    // Ensure exactly one overlay exists at a time.
    connectedOverlay?.destroy();
    connectedOverlay = createConnectedOverlay({
      serverName: payload.server_name ?? host,
      username: payload.user.username ?? username,
      motd: payload.motd ?? "",
      onReady: () => {
        if (!owner.isCurrent()) return;
        connectedOverlay?.destroy();
        connectedOverlay = null;
        // This handler's closures (the owner cleanup, the `ready` listener in
        // sessionUnsubs) outlive the overlay until logout; drop their shared
        // reference so the destroyed overlay's DOM can be collected.
        ownedOverlay = null;
        navigate("main");
      },
    });
    let ownedOverlay: ConnectedOverlayControl | null = connectedOverlay;
    owner.addCleanup(() => {
      ownedOverlay?.destroy();
      if (connectedOverlay === ownedOverlay) connectedOverlay = null;
    });
    appEl.appendChild(connectedOverlay.element);
    connectedOverlay.show();

    const unsubReady = ws.on("ready", () => {
      unsubReady();
      connectedOverlay?.markReady();
    });
    sessionUnsubs.push(unsubReady);
  });
  sessionUnsubs.push(unsubAuthOk);

  sessionCleanup = () => {
    for (const unsub of sessionUnsubs) unsub();
    sessionUnsubs.length = 0;
  };
  owner.addCleanup(sessionCleanup);
}

/** Handle logout / disconnect. App-lifetime: never unsubscribed. */
export function installLogoutTeardown(): void {
  // Handle logout / disconnect. App-lifetime: never unsubscribed.
  void authStore.subscribeSelector(
    (s) => s.isAuthenticated,
    (isAuthenticated) => {
      // The router only reaches "main" from the connected overlay's own
      // onReady, a task after `ready` arrives — so a session that ends between
      // auth_ok and ready (a ban, an auth_error on an intervening reconnect)
      // flips isAuthenticated false while the router is still "connect". The synchronous session cleanup has already
      // destroyed its overlay; lastConnectHost retains the transport ownership
      // needed to finish teardown here. Otherwise the overlay (position:fixed, opaque,
      // z-index 200, appended straight to #app in startSession's auth_ok
      // handler) is orphaned over the connect page with no remaining owner —
      // its only other teardown paths are its own onReady timer (never armed
      // without `ready`), the next startSession, onAutoLoginCancel, and the
      // invite deep-link handler, none of which this path takes.
      if (!isAuthenticated && (currentPage() === "main" || lastConnectHost !== "")) {
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
        connectedOverlay?.destroy();
        connectedOverlay = null;
        ws.disconnect();
        // The token this session ran on, for the web's delete: another tab may
        // have saved a different one since, and that one must survive.
        const sessionToken = lastConnectToken;
        lastConnectToken = "";
        lastConnectHost = "";
        // Clear stored credential on logout. (A server restart never gets
        // here: it keeps the session and reconnects.)
        const host = api.getConfig().host;
        const reason = authStore.getState().logoutReason;
        if (host) {
          // A protocol-epoch refusal keeps the credential: the token is
          // still valid, and the update the connect page offers relaunches
          // straight into auto-login with it (sessionStorage — and so the
          // skip flag below — does not survive that relaunch).
          // A quick switch keeps it as well: switching back resumes with it, and
          // the departed session is left for that return.
          if (reason !== "protocol_epoch" && reason !== "server_switch") {
            if (__OWNCORD_WEB__) void deleteCredential(host, sessionToken || undefined);
            else void deleteCredential(host);
          }
          // Whenever this session must not turn around and auto-login with the
          // credential (removed, or just refused), say so.
          sessionStorage.setItem("owncord:skip-auto-login", "1");
        }
        navigate("connect");
      }
    },
  );
}
