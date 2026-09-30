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
import { PROTOCOL_EPOCH, ServerRestartReason } from "../../lib/protocolTypes";
import type { ServerRestartReasonValue } from "../../lib/protocolTypes";
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

// RT-12: a restart that may put us back in our call after it drops. The
// shutdown reason is a stop or restart from outside the server (SIGTERM, a
// supervisor), and D-2 gives it its own shorter window: a quick systemctl/
// docker restart is a blip, while a long maintenance stop still ends the call.
const REJOIN_WINDOWS_MS: ReadonlyMap<ServerRestartReasonValue, number> = new Map([
  [ServerRestartReason.UPDATE, 10 * 60_000],
  [ServerRestartReason.BACKUP_RESTORE, 10 * 60_000],
  [ServerRestartReason.SETUP, 10 * 60_000],
  [ServerRestartReason.SHUTDOWN, 2 * 60_000],
]);

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
  // RT-12: mark whether the coming drop may put us back in our call. The hub
  // wipes voice_states on boot, so the resume cannot restore the membership
  // the way it restores chat; the drop records the channel and a later ready
  // sends one voice_join. The notice carries the reason's own window (D-2): a
  // planned restart gets 10 minutes, an outside shutdown a shorter 2 minutes.
  const windowMs = REJOIN_WINDOWS_MS.get(payload.reason);
  clock.voiceRejoinExpiresAt =
    clock.restartAnnounced && windowMs !== undefined ? Date.now() + windowMs : null;
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
  // RT-12: record the call we are in now, before leaveVoiceChannel clears it,
  // so a switch, join, kick or leave during the countdown is already settled.
  const channelId = voiceStore.getState().currentChannelId;
  clock.voiceRejoinChannelId = clock.voiceRejoinExpiresAt === null ? null : channelId;
  if (channelId !== null) {
    void livekitSession().then(({ leaveVoice }) => leaveVoice(false));
    leaveVoiceChannel();
  }
}

/**
 * RT-12: put the user back in the voice channel a planned restart took them
 * out of. The hub wipes voice_states on boot, so the resume cannot restore the
 * membership the way it restores chat; `handleRestartDrop` recorded the
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
  const expiresAt = clock.voiceRejoinExpiresAt;
  clock.voiceRejoinChannelId = null;
  if (channelId === null || expiresAt === null) return;
  if (Date.now() > expiresAt) {
    log.info("Not rejoining voice after restart — the server was down too long", { channelId });
    return;
  }
  const isDmCall = (payload.dm_channels ?? []).some((dm) => dm.channel_id === channelId);
  const channel = payload.channels.find((c) => c.id === channelId);
  if (!isDmCall && (channel === undefined || channel.type !== "voice")) {
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
 * The `BANNED`, `SESSION_REPLACED` and `ANOTHER_DEVICE_ACTIVE` branches of
 * `error`. Returns true when the frame was one of them and the error chain
 * must stop.
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
  if (payload.code === "SESSION_REPLACED" || payload.code === "ANOTHER_DEVICE_ACTIVE") {
    // The same account is live on another device. SESSION_REPLACED is the
    // server closing this socket because a new device took it;
    // ANOTHER_DEVICE_ACTIVE is the server refusing this device's wake
    // reconnect because the other device still holds it (U4). In both cases
    // reconnecting would kick that device, which would reconnect and kick
    // this one, forever — so stop like BANNED. Unlike BANNED this device is
    // still signed in: keep the credential and auth, and let the user take
    // the connection back ("Use here").
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
