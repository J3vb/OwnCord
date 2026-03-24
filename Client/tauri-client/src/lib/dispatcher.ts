// Step 2.26 — WebSocket Dispatcher
// Wires WS client events to store updates.
// Each server message type maps to one or more store actions.

import type { WsClient } from "./ws";
import { authStore, setAuth, clearAuth } from "@stores/auth.store";
import { setTransientError } from "@stores/ui.store";
import {
  setChannels,
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
import { handleVoiceToken } from "@lib/livekitSession";
import { notifyIncomingMessage } from "./notifications";
import { createLogger } from "./logger";

const log = createLogger("dispatcher");

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
    ws.on("auth_ok", (payload) => {
      setAuth(
        authStore.getState().token ?? "",
        payload.user,
        payload.server_name,
        payload.motd,
      );
    }),
  );

  unsubs.push(
    ws.on("auth_error", (payload) => {
      log.error("Auth failed", { message: payload.message });
      setTransientError(payload.message);
      clearAuth();
    }),
  );

  // ── Ready (initial state dump) ────────────────────────

  unsubs.push(
    ws.on("ready", (payload) => {
      setChannels(payload.channels);
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

      log.info("Ready payload applied", {
        channels: payload.channels.length,
        members: payload.members.length,
        voiceStates: payload.voice_states.length,
      });
    }),
  );

  // ── Chat Messages ─────────────────────────────────────

  unsubs.push(
    ws.on("chat_message", (payload) => {
      log.debug("chat_message received", {
        id: payload.id,
        channelId: payload.channel_id,
        user: payload.user.username,
      });
      addMessage(payload);
      // Increment unread for non-active channels
      const activeId = channelsStore.select(
        (s) => s.activeChannelId,
      );
      if (payload.channel_id !== activeId) {
        incrementUnread(payload.channel_id);
      }
      // Fire desktop notification, taskbar flash, and sound
      notifyIncomingMessage(payload);
    }),
  );

  unsubs.push(
    ws.on("chat_edited", (payload) => {
      editMessage(payload);
    }),
  );

  unsubs.push(
    ws.on("chat_deleted", (payload) => {
      deleteMessage(payload);
    }),
  );

  unsubs.push(
    ws.on("chat_send_ok", (payload, id) => {
      if (id) {
        confirmSend(id, payload.message_id, payload.timestamp);
      }
    }),
  );

  // ── Reactions ───────────────────────────────────────────

  unsubs.push(
    ws.on("reaction_update", (payload) => {
      const userId = authStore.getState().user?.id ?? 0;
      updateReaction(payload, userId);
    }),
  );

  // ── Typing ────────────────────────────────────────────

  unsubs.push(
    ws.on("typing", (payload) => {
      setTyping(payload.channel_id, payload.user_id);
    }),
  );

  // ── Presence ──────────────────────────────────────────

  unsubs.push(
    ws.on("presence", (payload) => {
      updatePresence(payload.user_id, payload.status);
    }),
  );

  // ── Channels ──────────────────────────────────────────

  unsubs.push(
    ws.on("channel_create", (payload) => {
      addChannel(payload);
    }),
  );

  unsubs.push(
    ws.on("channel_update", (payload) => {
      updateChannel(payload);
    }),
  );

  unsubs.push(
    ws.on("channel_delete", (payload) => {
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
    ws.on("member_join", (payload) => {
      log.info("Member joined", { userId: payload.user.id, username: payload.user.username });
      addMember(payload);
    }),
  );

  unsubs.push(
    ws.on("member_leave", (payload) => {
      log.info("Member left", { userId: payload.user_id });
      removeMember(payload.user_id);
    }),
  );

  unsubs.push(
    ws.on("member_ban", (payload) => {
      log.info("Member banned", { userId: payload.user_id });
      removeMember(payload.user_id);
    }),
  );

  unsubs.push(
    ws.on("member_update", (payload) => {
      log.info("Member role updated", { userId: payload.user_id, role: payload.role });
      updateMemberRole(payload.user_id, payload.role);
    }),
  );

  // ── Voice ─────────────────────────────────────────────

  unsubs.push(
    ws.on("voice_state", (payload) => {
      updateVoiceState(payload);
      // Auto-join voice channel if the event is for the current user
      const currentUserId = authStore.getState().user?.id ?? 0;
      if (payload.user_id === currentUserId) {
        joinVoiceChannel(payload.channel_id);
      }
    }),
  );

  unsubs.push(
    ws.on("voice_leave", (payload) => {
      removeVoiceUser(payload);
      // Clear local voice state if the current user was removed (kick/disconnect)
      const currentUserId = authStore.getState().user?.id ?? 0;
      if (payload.user_id === currentUserId) {
        leaveVoiceChannel();
      }
    }),
  );

  unsubs.push(
    ws.on("voice_config", (payload) => {
      setVoiceConfig(payload);
    }),
  );

  unsubs.push(
    ws.on("voice_speakers", (payload) => {
      setSpeakers(payload);
    }),
  );

  unsubs.push(
    ws.on("voice_token", (payload) => {
      void handleVoiceToken(payload.token, payload.url, payload.channel_id, payload.direct_url);
    }),
  );

  // ── Server Events ─────────────────────────────────────

  unsubs.push(
    ws.on("server_restart", (payload) => {
      log.warn("Server restarting", {
        reason: payload.reason,
        delaySeconds: payload.delay_seconds,
      });
      setTransientError(`Server is restarting: ${payload.reason ?? "maintenance"}`);
    }),
  );

  unsubs.push(
    ws.on("error", (payload) => {
      log.error("Server error", {
        code: payload.code,
        message: payload.message,
      });
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
