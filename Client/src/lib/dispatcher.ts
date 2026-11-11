// Step 2.26 — WebSocket Dispatcher
// Wires WS client events to store updates.
// Each server message type maps to one or more store actions.
//
// This file is the composition: it holds every socket registration (the
// only door server events enter the stores through — see
// local/no-store-write-in-ws-on and features/dispatcherDoor.test.ts) and the
// order of the two cross-domain handlers, `ready` and `error`. The handler
// bodies live in features/*/wsHandlers.ts as plain functions.

import type { ConnectionState, WsClient } from "./ws";
import { toConnectionStatus, setActiveChannelProvider } from "./ws";
import { getActivePresenceSender } from "./presence/presence";
import { handleActivityRefusal } from "./presence/gameActivityBridge";
import { setConnectionStatus } from "@stores/ui.store";
import { channelsStore } from "@stores/channels.store";
import { serverErrorText } from "./api";
import type { ApiClient } from "./api";
import { showToast } from "./ui/toast";
import { connectText } from "../i18n/connect";
import { ServerMessageType as S } from "./protocolTypes";
import {
  handleAuthOk,
  handleConnectionError,
  handleRestartDrop,
  rejoinVoiceAfterRestart,
  wsRoutes as connectionRoutes,
} from "../features/connection/wsHandlers";
import {
  applyReadyActiveChannel,
  applyReadyChannels,
  applyReadyEmoji,
  applyReadyStickers,
  handleMarkUnreadError,
  applyReadyReadPointer,
  resetChannelActivity,
  applyReadyGameActivities,
  applyAuthOkGameActivityPolicy,
  markReadyActiveChannelRead,
  wsRoutes as channelRoutes,
} from "../features/channels/wsHandlers";
import {
  activateReadyPendingMessages,
  applyReadyMessageResync,
  failPendingOnDisconnect,
  handleMessagingError,
  handleSendFailure,
  applyReadyThreads,
  resumeThreadFocus,
  wsRoutes as messagingRoutes,
} from "../features/messaging/wsHandlers";
import {
  applyReadyBlocks,
  applyReadyDms,
  wsRoutes as dmRoutes,
} from "../features/direct-messages/wsHandlers";
import {
  applyReadyDmRequests,
  wsRoutes as dmRequestRoutes,
} from "../features/message-requests/wsHandlers";
import {
  handleVoiceWatchError,
  handleVoiceError,
  handleVoicePasswordRefusal,
  handleVoiceJoinRollback,
  publishReadyIdentity,
  rollbackVideoOnError,
  snapshotReadyVoice,
  wsRoutes as voiceRoutes,
} from "../features/voice/wsHandlers";
import { createReconnectClock, log } from "../features/connection/dispatchContext";
import type { DispatchContext, Subscribe, WsRoute } from "../features/connection/dispatchContext";
import { failMarkUnread, forgetPendingMarkUnread, resetReadPointerState } from "./readState";
import { resetServerCapabilities } from "./net/serverCapabilities";
import {
  applyReadySafety,
  handleTimedOutRefusal,
  refreshSafetyOnResume,
  wsRoutes as safetyRoutes,
} from "../features/safety/wsHandlers";
import {
  applyReadyMemberTimeouts,
  wsRoutes as moderationRoutes,
} from "../features/moderation/wsHandlers";
import { WsErrorCode } from "@lib/protocolTypes";

/** Every feature's own events. Each event appears in exactly one table. */
export const featureRoutes: readonly WsRoute[] = [
  ...connectionRoutes,
  ...channelRoutes,
  ...messagingRoutes,
  ...dmRoutes,
  ...dmRequestRoutes,
  ...safetyRoutes,
  ...moderationRoutes,
  ...voiceRoutes,
];

/** Unsubscribe all listeners. */
export type DispatcherCleanup = () => void;

/**
 * The single writer for ui.store.connectionStatus (UX spec §3): collapses the
 * ws client's internal state machine onto the 3-state status, and records
 * whether a dial has failed in the current outage. That fact holds across the
 * backoff's later dials and clears only on a connection or a fresh connect
 * from a stopped socket (sign-in, server switch, "Use here"). Wired once at
 * startup and kept for the app's lifetime — deliberately separate from
 * wireDispatcher, whose listeners are torn down per connection.
 */
export function wireConnectionStatus(ws: Pick<WsClient, "onStateChange">): () => void {
  let prev: ConnectionState = "disconnected";
  let dialFailed = false;
  return ws.onStateChange((s) => {
    if (s === "connected" || (s === "connecting" && prev === "disconnected")) {
      dialFailed = false;
    } else if (
      (prev === "connecting" || prev === "authenticating") &&
      (s === "reconnecting" || s === "disconnected")
    ) {
      dialFailed = true;
    }
    prev = s;
    setConnectionStatus(toConnectionStatus(s), dialFailed);
  });
}

/**
 * Wire a WsClient to all domain stores.
 * Returns a cleanup function that removes all listeners.
 *
 * `api` is optional so tests can wire the dispatcher without a client; when
 * present it is used to refresh DM block state (GET /blocks) on ready, and to
 * refetch the active channel's history after a full-ready resync.
 */
export function wireDispatcher(
  ws: WsClient,
  api?: Pick<ApiClient, "listBlocks"> &
    Partial<
      Pick<
        ApiClient,
        | "updateProfile"
        | "getConfig"
        | "listEmoji"
        | "listStickers"
        | "getMessages"
        | "getMessagesAround"
        | "listDmRequests"
        | "decideDmRequest"
        | "getDmChannels"
        | "getOwnModeration"
        | "getMyAppeals"
      >
    >,
): DispatcherCleanup {
  const unsubs: Array<() => void> = [];
  const clock = createReconnectClock();

  // ── Auth ──────────────────────────────────────────────

  // Let the transport declare the open channel in the auth frame itself, so a
  // resuming server can restore the ChannelTopic subscription during the
  // handshake rather than only after the channel_focus round trip below —
  // closing the window in which channel broadcasts reach nobody on this
  // socket. The round trip stays as the fallback for older servers.
  setActiveChannelProvider(() => channelsStore.select((s) => s.activeChannelId));
  unsubs.push(() => setActiveChannelProvider(null));

  unsubs.push(
    ws.on(S.AUTH_OK, (payload) => {
      handleAuthOk(ws, clock, payload);
      // Every connect and resume restates the game activity switch; a resume
      // gets no ready, and the frame is not replayed.
      applyAuthOkGameActivityPolicy(payload);
      refreshSafetyOnResume(api, payload);
      // thread_focus is not carried across a connection: say it again, and
      // refetch the open panel's history (it missed frames while down).
      resumeThreadFocus(ws, api);
      // A resume gets no ready (a full flow, "none", refetches these from ready), and
      // these changes are not replayed: refetch them so one missed while down shows.
      // (sticker_update is unsequenced; a block or unblock may come from another device.)
      if (payload.replay_source === "buffer" || payload.replay_source === "db") {
        applyReadyDmRequests(api);
        applyReadyBlocks(api, "resume");
        applyReadyStickers(api);
      }
    }),
  );

  // ── Ready (initial state dump) ────────────────────────

  unsubs.push(
    ws.on(S.READY, (payload) => {
      // The order is behavior: pending messages -> voice snapshot (before
      // setVoiceStates overwrites it) -> channels/roles/members -> voice
      // restate + reconcile -> identity publish -> active channel -> message
      // resync (reads the active channel just chosen) -> DMs -> mark read ->
      // blocks -> Message Requests -> emoji -> stickers.
      applyReadyReadPointer(payload);
      activateReadyPendingMessages(api, payload);
      const applyReadyVoice = snapshotReadyVoice();
      applyReadyChannels(payload);
      applyReadyThreads(payload);
      applyReadyVoice(ws, payload);
      publishReadyIdentity(api, payload);
      const readyActive = applyReadyActiveChannel(payload);
      applyReadyMessageResync(api, clock);
      const dmPayloads = payload.dm_channels ?? [];
      applyReadyDms(payload);
      // After the roster and the DM list: the games ride on both.
      applyReadyGameActivities(payload);
      markReadyActiveChannelRead(readyActive);
      applyReadyBlocks(api);
      applyReadyDmRequests(api);
      applyReadyEmoji(api);
      applyReadyStickers(api);
      applyReadySafety(api, payload);
      applyReadyMemberTimeouts(payload);
      // If a planned restart took us out of a voice channel, put us
      // back once ready confirms the post-restart world.
      rejoinVoiceAfterRestart(clock, ws, payload);

      log.info("Ready payload applied", {
        channels: payload.channels.length,
        members: payload.members.length,
        voiceStates: payload.voice_states.length,
        dmChannels: dmPayloads.length,
      });
    }),
  );

  // ── Feature routes ─────────────────────────────────
  // Every event without a cross-feature order. A feature adds its events to
  // its own wsRoutes table, not here.

  const ctx: DispatchContext = { ws, api, clock };
  const subscribe: Subscribe = (type, listener) => ws.on(type, listener);
  for (const r of featureRoutes) unsubs.push(r.attach(subscribe, ctx));

  // A Mark Unread still waiting for its answer cannot get one across a change
  // of connection state; forget it rather than restore against the next.
  unsubs.push(ws.onStateChange(forgetPendingMarkUnread));
  // The capabilities and the seen/pending state belong to this session.
  unsubs.push(resetServerCapabilities, resetReadPointerState);
  unsubs.push(resetChannelActivity);

  // ── Server Events ─────────────────────────────────────

  unsubs.push(ws.onStateChange((state) => handleRestartDrop(clock, state)));

  // Local transport failures (proxy not open, outbound channel full/closed):
  // fail the matching optimistic row exactly like a server error reply would.
  // An optimistic reaction toggle rolls back the same way. Fire-and-forget
  // sends (typing, presence, voice) have no pending entry and stay logged-only.
  // A connection that leaves "connected" can never deliver chat_send_ok for
  // frames already handed to the transport: fail every pending optimistic
  // send so its row offers retry instead of spinning forever (and the leaked
  // pendingSends entries are cleared).
  unsubs.push(ws.onStateChange(failPendingOnDisconnect));

  unsubs.push(ws.onSendFailure(handleSendFailure));
  // A mark_unread that never left: put the pointer back and say so.
  unsubs.push(ws.onSendFailure((id) => failMarkUnread(id, "failed")));

  unsubs.push(
    ws.on(S.ERROR, (payload, id) => {
      log.error("Server error", {
        code: payload.code,
        message: payload.message,
        id,
      });
      // An ordered chain with early returns, and the order is behavior:
      // connection (BANNED, SESSION_REPLACED) -> pending send/reaction ->
      // the voice-join rollback, which deliberately runs before every
      // code-specific branch and never consumes the frame -> capacity
      // refusals -> the generic toast -> the video rollback.
      if (handleConnectionError(ws, payload)) return;
      // The game activity loop's own refused activity_update (RATE_LIMITED,
      // TIMED_OUT, ...): it retries on its next poll, and nothing is toasted.
      if (handleActivityRefusal(payload.code, id)) return;
      // A server that does not know voice_watch answers with an error: ignore it.
      if (handleVoiceWatchError(payload, id)) return;
      // A timeout refuses a custom status without writing or broadcasting
      // anything, so the PresenceSender's optimistic apply would leave the
      // user seeing and saving a status nobody else has. This is the one
      // writer for server events, so the rollback (a store write) lives here;
      // a no-op for any frame the sender did not put on the wire.
      // A BAD_REQUEST (a custom status the server's character or length rules
      // refuse) leaves the same unaccepted optimistic value behind, so
      // it takes the same rollback; the toast below carries the server's text.
      // A REQUEST_TIMEOUT (the server's per-frame deadline) means the
      // frame was not applied, which leaves the same unaccepted value behind.
      if (
        payload.code === WsErrorCode.TIMED_OUT ||
        payload.code === WsErrorCode.BAD_REQUEST ||
        payload.code === WsErrorCode.REQUEST_TIMEOUT
      ) {
        getActivePresenceSender()?.rollbackRefused(id);
      }
      // Never consumes the frame: the refused send/reaction/join still rolls back below.
      handleTimedOutRefusal(api, payload);
      // A refused Mark Unread restores the pointer and says so.
      if (handleMarkUnreadError(payload, id)) return;
      if (handleMessagingError(payload, id)) return;
      handleVoiceJoinRollback(ws, payload, id);
      if (handleVoicePasswordRefusal(ws, payload, id)) return;
      if (handleVoiceError(payload, id)) return;
      // Every remaining code has no dedicated handler above (not a pending
      // send/reaction rollback, not a capacity refusal) — this is the one
      // place every remaining server error lands (a rejected fire-and-forget
      // chat_edit, for one), so it must not be silently dropped just because
      // it isn't RATE_LIMITED/FORBIDDEN. transientError has exactly one
      // reader — ConnectPage's login-screen banner — so writing it here is
      // invisible for the whole time the user is in-app (MainPage never
      // subscribes) and only resurfaces, stale and out of context, next time
      // the login screen mounts. Use the same in-app toast the
      // sibling CHANNEL_FULL/VIDEO_LIMIT branches above already use. Fire
      // synchronously, independent of the video-rollback lookup below: both
      // paths react to this exact same message, so there is nothing left to
      // gate on that lookup resolving.
      showToast(
        serverErrorText(payload.code, payload.message, connectText("error.serverFallback")),
        "error",
      );

      rollbackVideoOnError(id);
    }),
  );

  return () => {
    // Each entry is isolated: one that throws must not leave the rest of the
    // socket handlers subscribed to a connection that is being torn down.
    for (const unsub of unsubs) {
      try {
        unsub();
      } catch (err) {
        log.error("Dispatcher cleanup step failed", err);
      }
    }
  };
}
