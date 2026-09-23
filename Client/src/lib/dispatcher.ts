// Step 2.26 — WebSocket Dispatcher
// Wires WS client events to store updates.
// Each server message type maps to one or more store actions.
//
// This file is the composition: it holds every socket registration (the
// only door server events enter the stores through — see
// local/no-store-write-in-ws-on and features/dispatcherDoor.test.ts) and the
// order of the two cross-domain handlers, `ready` and `error`. The handler
// bodies live in features/*/wsHandlers.ts as plain functions.

import type { WsClient } from "./ws";
import { toConnectionStatus, setActiveChannelProvider } from "./ws";
import { setConnectionStatus } from "@stores/ui.store";
import { channelsStore } from "@stores/channels.store";
import type { ApiClient } from "./api";
import { showToast } from "./toast";
import { ServerMessageType as S } from "./protocolTypes";
import {
  handleAuthError,
  handleAuthOk,
  handleConnectionError,
  handleServerRestart,
} from "../features/connection/wsHandlers";
import {
  applyReadyActiveChannel,
  applyReadyChannels,
  applyReadyEmoji,
  handleChannelCreate,
  handleChannelDelete,
  handleChannelUpdate,
  handleEmojiUpdate,
  handleMemberBan,
  handleMemberJoin,
  handleMemberUpdate,
  handlePresence,
  handleRolesUpdate,
  handleUserUpdate,
  markReadyActiveChannelRead,
} from "../features/channels/wsHandlers";
import {
  activateReadyPendingMessages,
  applyReadyMessageResync,
  failPendingOnDisconnect,
  handleChatBulkDeleted,
  handleChatDeleted,
  handleChatEdited,
  handleChatMessage,
  handleChatSendOk,
  handleMessagingError,
  handleReactionUpdate,
  handleSendFailure,
  handleTyping,
} from "../features/messaging/wsHandlers";
import {
  applyReadyBlocks,
  applyReadyDms,
  handleDmChannelClose,
  handleDmChannelOpen,
} from "../features/direct-messages/wsHandlers";
import {
  handleVoiceConfig,
  handleVoiceDisconnected,
  handleVoiceE2eeAnnounce,
  handleVoiceE2eeOffer,
  handleVoiceError,
  handleVoiceJoinRollback,
  handleVoiceLeave,
  handleVoiceMoved,
  handleVoiceState,
  handleVoiceTokenFrame,
  publishReadyIdentity,
  rollbackVideoOnError,
  snapshotReadyVoice,
} from "../features/voice/wsHandlers";
import { createReconnectClock, log } from "../features/connection/dispatchContext";
import {
  applyReadySafety,
  handleModAction,
  handleTimedOutRefusal,
  refreshSafetyOnResume,
} from "../features/safety/wsHandlers";

/** Unsubscribe all listeners. */
export type DispatcherCleanup = () => void;

/**
 * The single writer for ui.store.connectionStatus (UX spec §3): collapses the
 * ws client's internal state machine onto the 3-state status. Wired once at
 * startup and kept for the app's lifetime — deliberately separate from
 * wireDispatcher, whose listeners are torn down per connection.
 */
export function wireConnectionStatus(ws: Pick<WsClient, "onStateChange">): () => void {
  return ws.onStateChange((s) => setConnectionStatus(toConnectionStatus(s)));
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
        | "getMessages"
        | "getMessagesAround"
        | "getOwnModeration"
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
      refreshSafetyOnResume(api, payload);
    }),
  );

  unsubs.push(ws.on(S.AUTH_ERROR, (payload) => handleAuthError(api, payload)));

  // ── Ready (initial state dump) ────────────────────────

  unsubs.push(
    ws.on(S.READY, (payload) => {
      // The order is behavior: pending messages -> voice snapshot (before
      // setVoiceStates overwrites it) -> channels/roles/members -> voice
      // restate + reconcile -> identity publish -> active channel -> message
      // resync (reads the active channel just chosen) -> DMs -> mark read ->
      // blocks -> emoji.
      activateReadyPendingMessages(api, payload);
      const applyReadyVoice = snapshotReadyVoice();
      applyReadyChannels(payload);
      applyReadyVoice(ws, payload);
      publishReadyIdentity(api, payload);
      const readyActive = applyReadyActiveChannel(payload);
      applyReadyMessageResync(api, clock);
      const dmPayloads = payload.dm_channels ?? [];
      applyReadyDms(payload);
      markReadyActiveChannelRead(readyActive);
      applyReadyBlocks(api);
      applyReadyEmoji(api);
      applyReadySafety(api, payload);

      log.info("Ready payload applied", {
        channels: payload.channels.length,
        members: payload.members.length,
        voiceStates: payload.voice_states.length,
        dmChannels: dmPayloads.length,
      });
    }),
  );

  // ── DM Channels ─────────────────────────────────────

  unsubs.push(ws.on(S.DM_CHANNEL_OPEN, handleDmChannelOpen));

  unsubs.push(ws.on(S.DM_CHANNEL_CLOSE, handleDmChannelClose));

  // ── Chat Messages ─────────────────────────────────────

  unsubs.push(ws.on(S.CHAT_MESSAGE, (payload) => handleChatMessage(clock, payload)));

  unsubs.push(ws.on(S.CHAT_EDITED, handleChatEdited));

  unsubs.push(ws.on(S.CHAT_DELETED, handleChatDeleted));

  unsubs.push(ws.on(S.CHAT_BULK_DELETED, handleChatBulkDeleted));

  unsubs.push(ws.on(S.CHAT_SEND_OK, (payload, id) => handleChatSendOk(api, payload, id)));

  // ── Reactions ───────────────────────────────────────────

  unsubs.push(ws.on(S.REACTION_UPDATE, handleReactionUpdate));

  // ── Typing ────────────────────────────────────────────

  unsubs.push(ws.on(S.TYPING, handleTyping));

  // ── Presence ──────────────────────────────────────────

  unsubs.push(ws.on(S.PRESENCE, handlePresence));

  // ── Channels ──────────────────────────────────────────

  unsubs.push(ws.on(S.CHANNEL_CREATE, handleChannelCreate));

  unsubs.push(ws.on(S.CHANNEL_UPDATE, handleChannelUpdate));

  unsubs.push(ws.on(S.CHANNEL_DELETE, handleChannelDelete));

  // ── Members ───────────────────────────────────────────

  unsubs.push(ws.on(S.MEMBER_JOIN, handleMemberJoin));

  unsubs.push(ws.on(S.MEMBER_BAN, handleMemberBan));

  // mod_action: a warning or timeout applied to this user (B9-15).
  unsubs.push(ws.on(S.MOD_ACTION, (payload) => handleModAction(api, payload)));

  unsubs.push(ws.on(S.MEMBER_UPDATE, handleMemberUpdate));

  unsubs.push(ws.on(S.ROLES_UPDATE, handleRolesUpdate));

  unsubs.push(ws.on(S.EMOJI_UPDATE, handleEmojiUpdate));

  unsubs.push(ws.on(S.USER_UPDATE, handleUserUpdate));

  // ── Voice ─────────────────────────────────────────────

  unsubs.push(ws.on(S.VOICE_STATE, handleVoiceState));

  unsubs.push(ws.on(S.VOICE_MOVED, (payload) => handleVoiceMoved(ws, payload)));

  unsubs.push(ws.on(S.VOICE_DISCONNECTED, handleVoiceDisconnected));

  unsubs.push(ws.on(S.VOICE_LEAVE, handleVoiceLeave));

  unsubs.push(ws.on(S.VOICE_CONFIG, handleVoiceConfig));

  unsubs.push(ws.on(S.VOICE_TOKEN, handleVoiceTokenFrame));

  // ── Voice E2EE (client-side ECDH key exchange) ────────

  unsubs.push(ws.on(S.VOICE_E2EE_ANNOUNCE, handleVoiceE2eeAnnounce));

  unsubs.push(ws.on(S.VOICE_E2EE_OFFER, handleVoiceE2eeOffer));

  // ── Server Events ─────────────────────────────────────

  unsubs.push(ws.on(S.SERVER_RESTART, handleServerRestart));

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
      // Never consumes the frame: the refused send/reaction/join still rolls back below.
      handleTimedOutRefusal(api, payload);
      if (handleMessagingError(payload, id)) return;
      handleVoiceJoinRollback();
      if (handleVoiceError(payload, id)) return;
      // Every remaining code has no dedicated handler above (not a pending
      // send/reaction rollback, not a capacity refusal) — this is the one
      // place every remaining server error lands (a rejected fire-and-forget
      // chat_edit, for one), so it must not be silently dropped just because
      // it isn't RATE_LIMITED/FORBIDDEN. transientError has exactly one
      // reader — ConnectPage's login-screen banner — so writing it here is
      // invisible for the whole time the user is in-app (MainPage never
      // subscribes) and only resurfaces, stale and out of context, next time
      // the login screen mounts (OC-0064). Use the same in-app toast the
      // sibling CHANNEL_FULL/VIDEO_LIMIT branches above already use. Fire
      // synchronously, independent of the video-rollback lookup below: both
      // paths react to this exact same message, so there is nothing left to
      // gate on that lookup resolving.
      showToast(payload.message || "Server error", "error");

      rollbackVideoOnError(id);
    }),
  );

  return () => {
    for (const unsub of unsubs) {
      unsub();
    }
  };
}
