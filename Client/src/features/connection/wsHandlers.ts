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
import { voiceStore, leaveVoiceChannel, joinVoiceChannel } from "../../stores/voice.store";
import { PROTOCOL_EPOCH } from "../../lib/protocolTypes";
import { safetyText } from "../../i18n/safety";
import { connectText } from "../../i18n/connect";
import { livekitSession, log } from "./dispatchContext";
import type { DispatchApi, DispatchWs, Payload, ReconnectClock } from "./dispatchContext";
import type { ConnectionState } from "../../lib/ws";

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

export function handleServerRestart(
  clock: ReconnectClock,
  payload: Payload<"server_restart">,
): void {
  log.warn("Server restarting", {
    reason: payload.reason,
    delaySeconds: payload.delay_seconds,
  });
  // Every announced restart keeps the session (Q4): the token stays valid,
  // ws.ts reconnects on its own once the socket drops and resumes into the
  // same channel, and MainPage's banner counts down. A zero delay
  // (update_aborted) withdraws the announcement.
  clock.restartAnnounced = payload.delay_seconds > 0;
  // RT-12: remember the voice channel we are in so a planned restart can put
  // us back. The hub wipes voice_states on boot, so the resume cannot restore
  // the membership the way it restores chat; a later ready sends one
  // voice_join. Recorded here, while the session is still live, because the
  // drop handler clears the store's currentChannelId. An aborted restart or a
  // leave before the drop clears it again.
  if (clock.restartAnnounced) {
    clock.voiceRejoinChannelId = voiceStore.getState().currentChannelId;
  } else {
    clock.voiceRejoinChannelId = null;
  }
}

/**
 * The socket's state changed. When it drops while a restart is announced, the
 * server is really going away and its voice state (and a managed LiveKit)
 * goes with the process, so end the call. Keyed on the drop rather than the
 * notice: the notice names the restart's intent, and an announced update can
 * still be aborted before anything drops.
 */
export function handleRestartDrop(clock: ReconnectClock, state: ConnectionState): void {
  if (!clock.restartAnnounced || (state !== "reconnecting" && state !== "disconnected")) return;
  clock.restartAnnounced = false;
  if (voiceStore.getState().currentChannelId !== null) {
    void livekitSession().then(({ leaveVoice }) => leaveVoice(false));
    leaveVoiceChannel();
  } else {
    // The user left voice (or was evicted) after the notice but before the
    // drop: there is no call to return to, so forget the recorded channel.
    clock.voiceRejoinChannelId = null;
  }
}

/**
 * RT-12: put the user back in the voice channel a planned restart took them
 * out of. The hub wipes voice_states on boot, so the resume cannot restore the
 * membership the way it restores chat; `handleServerRestart` recorded the
 * channel, and this runs once from `ready`. It sends one ordinary voice_join —
 * never after a kick, move, ban or leave, which clear the recorded channel —
 * and only when the channel still exists as a joinable voice channel.
 */
export function rejoinVoiceAfterRestart(
  clock: ReconnectClock,
  ws: DispatchWs,
  payload: Payload<"ready">,
): void {
  const channelId = clock.voiceRejoinChannelId;
  clock.voiceRejoinChannelId = null;
  if (channelId === null) return;
  const channel = payload.channels.find((c) => c.id === channelId);
  if (channel === undefined || channel.type !== "voice") {
    log.info("Not rejoining voice after restart — channel is gone or no longer a voice channel", {
      channelId,
    });
    return;
  }
  // A live membership already in the payload means the rejoin is unnecessary
  // (or the user re-joined manually while ready was in flight).
  const currentUserId = authStore.getState().user?.id ?? 0;
  if (
    payload.voice_states.some((vs) => vs.user_id === currentUserId && vs.channel_id === channelId)
  ) {
    return;
  }
  log.info("Rejoining voice channel after planned restart", { channelId });
  joinVoiceChannel(channelId);
  ws.send({ type: "voice_join", payload: { channel_id: channelId } });
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
    setTransientError(`${connectText("session.banned")} ${safetyText("appeals.unavailable")}`);
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
