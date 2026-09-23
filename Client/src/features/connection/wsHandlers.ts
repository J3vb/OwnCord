// Auth, server-restart and connection-level error handlers — extracted from
// lib/dispatcher.ts, which keeps every socket subscription and calls these
// plain functions.
import { authStore, setAuth, clearAuth } from "../../stores/auth.store";
import {
  setTransientError,
  setUpdateRequiredHost,
  setSessionReplaced,
} from "../../stores/ui.store";
import { channelsStore } from "../../stores/channels.store";
import { voiceStore, leaveVoiceChannel } from "../../stores/voice.store";
import { PROTOCOL_EPOCH } from "../../lib/protocolTypes";
import { safetyText } from "../../i18n/safety";
import { livekitSession, log } from "./dispatchContext";
import type { DispatchApi, DispatchWs, Payload, ReconnectClock } from "./dispatchContext";

export function handleAuthOk(
  ws: DispatchWs,
  clock: ReconnectClock,
  payload: Payload<"auth_ok">,
): void {
  if (clock.hasAuthenticatedBefore) {
    clock.lastReconnectHandshakeAt = Date.now();
  }
  clock.hasAuthenticatedBefore = true;
  setAuth(authStore.getState().token ?? "", payload.user, payload.server_name, payload.motd);

  // The resume path can land with no ChannelTopic subscription: the hub
  // only transfers a focused channel from an old connection entry, but
  // readPump's unregister deletes that entry as soon as the server
  // observes the socket close — which happens well before the client's
  // first reconnect attempt. Re-asserting focus here (idempotent on the
  // server) covers that gap on every connect, resume included.
  const activeChannelId = channelsStore.select((s) => s.activeChannelId);
  if (activeChannelId !== null) {
    ws.send({ type: "channel_focus", payload: { channel_id: activeChannelId } });
  }
}

export function handleAuthError(
  api: DispatchApi | undefined,
  payload: Payload<"auth_error">,
): void {
  log.error("Auth failed", { message: payload.message });
  setTransientError(payload.message);
  const epochRefusal = payload.code === "protocol_epoch_unsupported";
  // Hand the refused host to the connect page so it can name which side
  // updates, and offer the client update when this build is the older one.
  if (epochRefusal) {
    const host = api?.getConfig?.().host;
    if (host) {
      setUpdateRequiredHost({
        host,
        serverEpoch: payload.server_epoch ?? null,
        clientEpoch: PROTOCOL_EPOCH,
      });
    }
  }
  // A protocol refusal is not a bad token: say so, so main.ts keeps the
  // stored credential for the relaunch after the update.
  clearAuth(epochRefusal ? "protocol_epoch" : "user");
}

export function handleServerRestart(payload: Payload<"server_restart">): void {
  log.warn("Server restarting", {
    reason: payload.reason,
    delaySeconds: payload.delay_seconds,
  });
  if (payload.reason === "shutdown") {
    // GracefulStop broadcast: the server is going down, not briefly
    // restarting in place. Kick back to the login screen instead of
    // spinning the reconnect loop against a dead host. clearAuth also
    // leaves voice — stopping any live camera/screenshare tracks and
    // resetting their toggles to off. "server_shutdown" keeps the saved
    // credential (the token is still valid), so auto-login can resume
    // when the server comes back.
    setTransientError("The server was shut down — you have been signed out.");
    clearAuth("server_shutdown");
    return;
  }
  setTransientError(`Server is restarting: ${payload.reason ?? "maintenance"}`);
}

/**
 * The `BANNED` and `SESSION_REPLACED` branches of `error`. Returns true when
 * the frame was one of them and the error chain must stop.
 */
export function handleConnectionError(ws: DispatchWs, payload: Payload<"error">): boolean {
  if (payload.code === "BANNED") {
    // Banned users must not reconnect — show error and force logout.
    // The server answers a ban with a generic `error` frame (not
    // `auth_error`), so ws.ts never sets intentionalClose for this path.
    // main.ts's authStore subscriber would normally do that teardown,
    // but it only runs once the router has reached "main" — during
    // login / auto-login / the connected-overlay window it hasn't, so
    // left to that subscriber alone the client redials the same banned
    // token via scheduleReconnect() forever (OC-0107). Disconnect here
    // directly: it's idempotent with that subscriber's own
    // ws.disconnect() and covers every router state, not just "main".
    setTransientError(
      `${(payload.message || "You have been banned").replace(/([^.!?])$/, "$1.")} ${safetyText("appeals.unavailable")}`,
    );
    ws.disconnect();
    clearAuth();
    return true;
  }
  if (payload.code === "SESSION_REPLACED") {
    // The same account connected from another device and the server
    // closed this socket. Reconnecting would kick that device, which
    // would reconnect and kick this one, forever — so stop like BANNED.
    // Unlike BANNED this device is still signed in: keep the credential
    // and auth, and let the user take the connection back ("Use here").
    // The voice session moves with the connection, so leave it here.
    ws.disconnect();
    if (voiceStore.getState().currentChannelId !== null) {
      void livekitSession().then(({ leaveVoice }) => leaveVoice(false));
      leaveVoiceChannel();
    }
    setSessionReplaced(true);
    return true;
  }
  return false;
}
