// Step 2.26 — WebSocket Dispatcher
// Wires WS client events to store updates.
// Each server message type maps to one or more store actions.

import type { WsClient } from "./ws";
import { authStore, setAuth, clearAuth } from "@stores/auth.store";
import { setTransientError } from "@stores/ui.store";
import {
  setChannels,
  setRoles,
  setActiveChannel,
  addChannel,
  updateChannel,
  removeChannel,
  incrementUnread,
} from "@stores/channels.store";
import { channelsStore } from "@stores/channels.store";
import {
  addMessage,
  editMessage,
  deleteMessage,
  updateReaction,
  confirmSend,
} from "@stores/messages.store";
import {
  setMembers,
  addMember,
  removeMember,
  updateMemberRole,
  updatePresence,
  setTyping,
} from "@stores/members.store";
import {
  setVoiceStates,
  updateVoiceState,
  removeVoiceUser,
  setVoiceConfig,
  setSpeakers,
  joinVoiceChannel,
  leaveVoiceChannel,
} from "@stores/voice.store";
import {
  dmStore,
  setDmChannels,
  addDmChannel,
  removeDmChannel,
  updateDmLastMessage,
  updateDmLastMessagePreview,
} from "@stores/dm.store";
import type { DmChannel } from "@stores/dm.store";
import type { DmChannelPayload } from "./types";
import { handleVoiceToken } from "@lib/livekitSession";
import { notifyIncomingMessage } from "./notifications";
import { createLogger } from "./logger";
import { ServerMessageType as S } from "./protocolTypes";

const log = createLogger("dispatcher");

/** Map a server DM channel payload to the client DmChannel type. */
function mapDmPayload(p: DmChannelPayload): DmChannel {
  return {
    channelId: p.channel_id,
    recipient: {
      id: p.recipient.id,
      username: p.recipient.username,
      avatar: p.recipient.avatar,
      status: p.recipient.status,
    },
    lastMessageId: p.last_message_id,
    lastMessage: p.last_message,
    lastMessageAt: p.last_message_at,
    unreadCount: p.unread_count,
  };
}

/** Unsubscribe all listeners. */
export type DispatcherCleanup = () => void;

/**
 * Wire a WsClient to all domain stores.
 * Returns a cleanup function that removes all listeners.
 */
export function wireDispatcher(ws: WsClient): DispatcherCleanup {
  const unsubs: Array<() => void> = [];

  // ── Auth ──────────────────────────────────────────────

  unsubs.push(
    ws.on(S.AUTH_OK, (payload) => {
      setAuth(
        authStore.getState().token ?? "",
        payload.user,
        payload.server_name,
        payload.motd,
      );
    }),
  );

  unsubs.push(
    ws.on(S.AUTH_ERROR, (payload) => {
      log.error("Auth failed", { message: payload.message });
      setTransientError(payload.message);
      clearAuth();
    }),
  );

  // ── Ready (initial state dump) ────────────────────────

  unsubs.push(
    ws.on(S.READY, (payload) => {
      setChannels(payload.channels);
      setRoles(payload.roles ?? []);
      setMembers(payload.members);
      setVoiceStates(payload.voice_states);

      // Auto-select the first text channel if none is active
      const currentActive = channelsStore.select((s) => s.activeChannelId);
      if (currentActive === null && payload.channels.length > 0) {
        const firstText = payload.channels.find((ch) => ch.type === "text");
        if (firstText !== undefined) {
          setActiveChannel(firstText.id);
        }
      }

      // Populate DM channels if present in the ready payload
      const dmPayloads = payload.dm_channels ?? [];
      if (dmPayloads.length > 0) {
        setDmChannels(dmPayloads.map(mapDmPayload));
      }

      log.info("Ready payload applied", {
        channels: payload.channels.length,
        members: payload.members.length,
        voiceStates: payload.voice_states.length,
        dmChannels: dmPayloads.length,
      });
    }),
  );

  // ── DM Channels ─────────────────────────────────────

  unsubs.push(
    ws.on(S.DM_CHANNEL_OPEN, (payload) => {
      log.info("DM channel opened", { channelId: payload.channel_id });
      addDmChannel(mapDmPayload(payload));
    }),
  );

  unsubs.push(
    ws.on(S.DM_CHANNEL_CLOSE, (payload) => {
      log.info("DM channel closed", { channelId: payload.channel_id });
      removeDmChannel(payload.channel_id);
    }),
  );

  // ── Chat Messages ─────────────────────────────────────

  unsubs.push(
    ws.on(S.CHAT_MESSAGE, (payload) => {
      log.debug("chat_message received", {
        id: payload.id,
        channelId: payload.channel_id,
        user: payload.user.username,
      });
      addMessage(payload);
      const activeId = channelsStore.select(
        (s) => s.activeChannelId,
      );

      // Check if this is a DM channel and whether the message is from self.
      const dmChannels = dmStore.getState().channels;
      const isDm = dmChannels.some((c) => c.channelId === payload.channel_id);
      const currentUserId = authStore.getState().user?.id ?? null;
      const isOwnMessage = currentUserId !== null && payload.user.id === currentUserId;

      // Increment channel-level unread for non-active, non-own-message channels.
      // Skip during reconnection replay to avoid inflating counts — the
      // server's ready payload already contains accurate unread_count values.
      // DM channel IDs are not in channelsStore (they use dmStore), so
      // incrementUnread is a no-op for DMs, but the own-message guard is
      // applied here for defence-in-depth.
      if (payload.channel_id !== activeId && !isOwnMessage && !ws.isReplaying()) {
        incrementUnread(payload.channel_id);
      }

      // Update DM store last message if this message belongs to a DM channel.
      // Skip unread increment for own messages, currently focused DM, and replay.
      if (isDm) {
        const isDmActive = payload.channel_id === activeId;
        if (isOwnMessage || isDmActive || ws.isReplaying()) {
          // Update last message preview but don't increment unread count.
          updateDmLastMessagePreview(
            payload.channel_id,
            payload.id,
            payload.content,
            payload.timestamp,
          );
        } else {
          updateDmLastMessage(
            payload.channel_id,
            payload.id,
            payload.content,
            payload.timestamp,
          );
        }
      }

      // Fire desktop notification, taskbar flash, and sound
      notifyIncomingMessage(payload);
    }),
  );

  unsubs.push(
    ws.on(S.CHAT_EDITED, (payload) => {
      editMessage(payload);
    }),
  );

  unsubs.push(
    ws.on(S.CHAT_DELETED, (payload) => {
      deleteMessage(payload);
    }),
  );

  unsubs.push(
    ws.on(S.CHAT_SEND_OK, (payload, id) => {
      if (id) {
        confirmSend(id, payload.message_id, payload.timestamp);
      }
    }),
  );

  // ── Reactions ───────────────────────────────────────────

  unsubs.push(
    ws.on(S.REACTION_UPDATE, (payload) => {
      const userId = authStore.getState().user?.id ?? 0;
      updateReaction(payload, userId);
    }),
  );

  // ── Typing ────────────────────────────────────────────

  unsubs.push(
    ws.on(S.TYPING, (payload) => {
      setTyping(payload.channel_id, payload.user_id);
    }),
  );

  // ── Presence ──────────────────────────────────────────

  unsubs.push(
    ws.on(S.PRESENCE, (payload) => {
      updatePresence(payload.user_id, payload.status);
    }),
  );

  // ── Channels ──────────────────────────────────────────

  unsubs.push(
    ws.on(S.CHANNEL_CREATE, (payload) => {
      addChannel(payload);
    }),
  );

  unsubs.push(
    ws.on(S.CHANNEL_UPDATE, (payload) => {
      updateChannel(payload);
    }),
  );

  unsubs.push(
    ws.on(S.CHANNEL_DELETE, (payload) => {
      // If the deleted channel is the active one, redirect to the first text channel.
      const activeId = channelsStore.select((s) => s.activeChannelId);
      removeChannel(payload.id);
      if (payload.id === activeId) {
        const remaining = channelsStore.select((s) => s.channels);
        const sorted = [...remaining.values()]
          .filter((ch) => ch.type === "text")
          .sort((a, b) => a.position - b.position);
        const firstTextId = sorted.length > 0 ? sorted[0]!.id : null;
        setActiveChannel(firstTextId);
        log.info("Active channel deleted, redirected", { deletedId: payload.id });
      }
    }),
  );

  // ── Members ───────────────────────────────────────────

  unsubs.push(
    ws.on(S.MEMBER_JOIN, (payload) => {
      log.info("Member joined", { userId: payload.user.id, username: payload.user.username });
      addMember(payload);
    }),
  );

  unsubs.push(
    ws.on(S.MEMBER_LEAVE, (payload) => {
      log.info("Member left", { userId: payload.user_id });
      removeMember(payload.user_id);
    }),
  );

  unsubs.push(
    ws.on(S.MEMBER_BAN, (payload) => {
      log.info("Member banned", { userId: payload.user_id });
      removeMember(payload.user_id);
    }),
  );

  unsubs.push(
    ws.on(S.MEMBER_UPDATE, (payload) => {
      log.info("Member role updated", { userId: payload.user_id, role: payload.role });
      updateMemberRole(payload.user_id, payload.role);
    }),
  );

  // ── Voice ─────────────────────────────────────────────

  unsubs.push(
    ws.on(S.VOICE_STATE, (payload) => {
      updateVoiceState(payload);
      // Auto-join voice channel if the event is for the current user
      const currentUserId = authStore.getState().user?.id ?? 0;
      if (payload.user_id === currentUserId) {
        joinVoiceChannel(payload.channel_id);
      }
    }),
  );

  unsubs.push(
    ws.on(S.VOICE_LEAVE, (payload) => {
      removeVoiceUser(payload);
      // Clear local voice state if the current user was removed (kick/disconnect)
      const currentUserId = authStore.getState().user?.id ?? 0;
      if (payload.user_id === currentUserId) {
        leaveVoiceChannel();
      }
    }),
  );

  unsubs.push(
    ws.on(S.VOICE_CONFIG, (payload) => {
      setVoiceConfig(payload);
    }),
  );

  unsubs.push(
    ws.on(S.VOICE_SPEAKERS, (payload) => {
      setSpeakers(payload);
    }),
  );

  unsubs.push(
    ws.on(S.VOICE_TOKEN, (payload) => {
      void handleVoiceToken(payload.token, payload.url, payload.channel_id, payload.direct_url);
    }),
  );

  // ── Server Events ─────────────────────────────────────

  unsubs.push(
    ws.on(S.SERVER_RESTART, (payload) => {
      log.warn("Server restarting", {
        reason: payload.reason,
        delaySeconds: payload.delay_seconds,
      });
      setTransientError(`Server is restarting: ${payload.reason ?? "maintenance"}`);
    }),
  );

  unsubs.push(
    ws.on(S.ERROR, (payload) => {
      log.error("Server error", {
        code: payload.code,
        message: payload.message,
      });
      if (payload.code === "BANNED") {
        // Banned users must not reconnect — show error and force logout.
        setTransientError(payload.message || "You have been banned");
        clearAuth();
        return;
      }
      if (payload.code === "RATE_LIMITED" || payload.code === "FORBIDDEN") {
        setTransientError(payload.message || "Server error");
      }
    }),
  );

  return () => {
    for (const unsub of unsubs) {
      unsub();
    }
  };
}
