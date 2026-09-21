// Step 2.26 — WebSocket Dispatcher
// Wires WS client events to store updates.
// Each server message type maps to one or more store actions.

import type { WsClient } from "./ws";
import { toConnectionStatus, setActiveChannelProvider } from "./ws";
import { authStore, setAuth, clearAuth } from "@stores/auth.store";
import {
  setTransientError,
  setConnectionStatus,
  setUpdateRequiredHost,
  setSessionReplaced,
} from "@stores/ui.store";
import { channelsStore } from "@stores/channels.store";
import { voiceStore, leaveVoiceChannel } from "@stores/voice.store";
import type { ApiClient } from "./api";
import { createLogger } from "./logger";
import { showToast } from "./toast";
import { ServerMessageType as S, PROTOCOL_EPOCH } from "./protocolTypes";
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
  applyReadyVoice,
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
import { createReconnectClock, livekitSession } from "../features/connection/dispatchContext";
import type { DispatchContext } from "../features/connection/dispatchContext";

const log = createLogger("dispatcher");

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
        "updateProfile" | "getConfig" | "listEmoji" | "getMessages" | "getMessagesAround"
      >
    >,
): DispatcherCleanup {
  const unsubs: Array<() => void> = [];
  const ctx: DispatchContext = { ws, api, clock: createReconnectClock() };

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
      if (ctx.clock.hasAuthenticatedBefore) {
        ctx.clock.lastReconnectHandshakeAt = Date.now();
      }
      ctx.clock.hasAuthenticatedBefore = true;
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
    }),
  );

  unsubs.push(
    ws.on(S.AUTH_ERROR, (payload) => {
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
    }),
  );

  // ── Ready (initial state dump) ────────────────────────

  unsubs.push(
    ws.on(S.READY, (payload) => {
      activateReadyPendingMessages(ctx, payload);
      const voiceSnapshot = snapshotReadyVoice();

      applyReadyChannels(payload);
      applyReadyVoice(ctx, payload, voiceSnapshot);

      publishReadyIdentity(ctx, payload);

      const readyActive = applyReadyActiveChannel(payload);

      applyReadyMessageResync(ctx);

      const dmPayloads = payload.dm_channels ?? [];
      applyReadyDms(payload);

      markReadyActiveChannelRead(readyActive);

      applyReadyBlocks(ctx);

      applyReadyEmoji(ctx);

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

  unsubs.push(ws.on(S.CHAT_MESSAGE, (payload) => handleChatMessage(ctx, payload)));

  unsubs.push(ws.on(S.CHAT_EDITED, handleChatEdited));

  unsubs.push(ws.on(S.CHAT_DELETED, handleChatDeleted));

  unsubs.push(ws.on(S.CHAT_BULK_DELETED, handleChatBulkDeleted));

  unsubs.push(ws.on(S.CHAT_SEND_OK, (payload, id) => handleChatSendOk(ctx, payload, id)));

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

  unsubs.push(ws.on(S.MEMBER_UPDATE, handleMemberUpdate));

  unsubs.push(ws.on(S.ROLES_UPDATE, handleRolesUpdate));

  unsubs.push(ws.on(S.EMOJI_UPDATE, handleEmojiUpdate));

  unsubs.push(ws.on(S.USER_UPDATE, handleUserUpdate));

  // ── Voice ─────────────────────────────────────────────

  unsubs.push(ws.on(S.VOICE_STATE, handleVoiceState));

  unsubs.push(ws.on(S.VOICE_MOVED, (payload) => handleVoiceMoved(ctx, payload)));

  unsubs.push(ws.on(S.VOICE_DISCONNECTED, handleVoiceDisconnected));

  unsubs.push(ws.on(S.VOICE_LEAVE, handleVoiceLeave));

  unsubs.push(ws.on(S.VOICE_CONFIG, handleVoiceConfig));

  unsubs.push(ws.on(S.VOICE_TOKEN, handleVoiceTokenFrame));

  // ── Voice E2EE (client-side ECDH key exchange) ────────

  unsubs.push(ws.on(S.VOICE_E2EE_ANNOUNCE, handleVoiceE2eeAnnounce));

  unsubs.push(ws.on(S.VOICE_E2EE_OFFER, handleVoiceE2eeOffer));

  // ── Server Events ─────────────────────────────────────

  unsubs.push(
    ws.on(S.SERVER_RESTART, (payload) => {
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
    }),
  );

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
        setTransientError(payload.message || "You have been banned");
        ws.disconnect();
        clearAuth();
        return;
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
        return;
      }
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
