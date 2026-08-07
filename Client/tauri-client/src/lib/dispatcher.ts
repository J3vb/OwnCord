// Step 2.26 — WebSocket Dispatcher
// Wires WS client events to store updates.
// Each server message type maps to one or more store actions.

import type { WsClient } from "./ws";
import { toConnectionStatus } from "./ws";
import { authStore, setAuth, clearAuth } from "@stores/auth.store";
import { setTransientError, setConnectionStatus } from "@stores/ui.store";
import {
  setChannels,
  setRoles,
  setActiveChannel,
  addChannel,
  updateChannel,
  removeChannel,
  incrementUnread,
  incrementMention,
} from "@stores/channels.store";
import { channelsStore } from "@stores/channels.store";
import {
  addMessage,
  editMessage,
  deleteMessage,
  bulkDeleteMessages,
  updateReaction,
  rollbackReaction,
  confirmSend,
  markSendFailed,
  messagesStore,
} from "@stores/messages.store";
import {
  setMembers,
  addMember,
  removeMember,
  updateMemberRole,
  updateMemberProfile,
  updatePresence,
  setTyping,
} from "@stores/members.store";
import {
  voiceStore,
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
  closeDmLocally,
  updateDmLastMessage,
  updateDmLastMessagePreview,
  incrementDmMention,
  dmDisplayName,
} from "@stores/dm.store";
import type { DmChannel } from "@stores/dm.store";
import { setBlockedByMe, setUserBlockedByThem, clearBlockedByThem } from "@stores/blocks.store";
import { setCustomEmoji } from "@stores/emoji.store";
import type { DmChannelPayload } from "./types";
import type { ApiClient } from "./api";
import { invalidateReactionUsers } from "@components/message-list/reaction-tooltip";
import { notifyIncomingMessage } from "./notifications";
import { highlightsCurrentUser } from "./mentions";
import { ensureIdentityKeyPublished } from "@lib/identity";
import { markChannelRead } from "./read-state";
import { createLogger } from "./logger";
import { showToast } from "./toast";
import { ServerMessageType as S } from "./protocolTypes";

const log = createLogger("dispatcher");

/** Lazily import the LiveKit session module. livekit-client (~1.3 MB) is kept
 *  out of the entry chunk; voice handlers load it on first use. Once a voice
 *  flow has started the module is cached, so this resolves in a microtask. */
function livekitSession(): Promise<typeof import("@lib/livekitSession")> {
  return import("@lib/livekitSession");
}

/** Map one DM participant from the wire shape to the store's. */
function mapDmUser(u: DmChannelPayload["recipient"]): DmChannel["recipient"] {
  return {
    id: u.id,
    username: u.username,
    avatar: u.avatar,
    status: u.status,
    displayName: u.display_name ?? "",
  };
}

/** Map a server DM channel payload to the client DmChannel type. */
function mapDmPayload(p: DmChannelPayload): DmChannel {
  // A pre-group server sends only `recipient`, which for it *is* the whole
  // membership — so the fallback is a one-element list rather than an empty
  // one, and every group-aware call site keeps working against an old server.
  const participants = (p.recipients ?? [p.recipient]).map(mapDmUser);
  return {
    channelId: p.channel_id,
    recipient: participants[0] ?? mapDmUser(p.recipient),
    participants,
    name: p.name ?? "",
    isGroup: p.is_group ?? false,
    lastMessageId: p.last_message_id,
    lastMessage: p.last_message,
    lastMessageAt: p.last_message_at,
    unreadCount: p.unread_count,
    mentionCount: p.mention_count ?? 0,
  };
}

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
 * present it is used to refresh DM block state (GET /blocks) on ready.
 */
export function wireDispatcher(
  ws: WsClient,
  api?: Pick<ApiClient, "listBlocks"> &
    Partial<Pick<ApiClient, "updateProfile" | "getConfig" | "listEmoji">>,
): DispatcherCleanup {
  const unsubs: Array<() => void> = [];

  // ── Auth ──────────────────────────────────────────────

  unsubs.push(
    ws.on(S.AUTH_OK, (payload) => {
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

      // Defense-in-depth: if the ready payload shows us in a voice channel
      // but we have no LiveKit session (e.g. after F5 reload), send
      // voice_leave to clean up the stale state. The server should have
      // already cleaned this up, but this handles edge cases.
      //
      // livekitSession is lazily imported, so instead of the synchronous
      // isVoiceConnected() the check reads the voice store's lifecycle
      // status: "idle" means no live or pending LiveKit session (a fresh
      // reload always starts idle — exactly the stale case), while any other
      // status means livekitSession is driving a session right now.
      const currentUserId = authStore.getState().user?.id ?? 0;
      const inVoicePerReady =
        currentUserId !== 0 && payload.voice_states.some((vs) => vs.user_id === currentUserId);
      const voiceSessionActive = voiceStore.getState().voiceStatus !== "idle";
      if (inVoicePerReady && !voiceSessionActive) {
        log.warn("Stale voice state detected in ready payload — sending voice_leave");
        ws.send({ type: "voice_leave", payload: {} });
        leaveVoiceChannel();
      }

      // F3: publish our long-term identity public key so peers can pin+verify
      // us in voice. Idempotent (no PATCH when the server copy already matches)
      // and fire-and-forget — never block the ready flow. Username is required
      // by the server's profile update, so it rides along with the key.
      const self = payload.members.find((m) => m.id === currentUserId);
      const host = api?.getConfig?.().host;
      if (self !== undefined && currentUserId !== 0 && host && api?.updateProfile) {
        const updateProfile = api.updateProfile;
        void ensureIdentityKeyPublished(
          host,
          self.username,
          self.identity_public_key ?? null,
          (data) => updateProfile(data),
        );
      }

      // Auto-select the first text channel if none is active; clear it when
      // the channel this session was viewing is gone from the fresh snapshot
      // (deleted, or a DM closed elsewhere while this client was offline) so
      // the activeChannelId subscriber actually fires and tears down the
      // stale message list/composer instead of leaving them mounted against
      // a channel the server no longer recognizes. Checked against the raw
      // payload (not the synthesized channelsStore row) so a still-open DM
      // that was never locally synthesized this session isn't wrongly
      // cleared.
      const currentActive = channelsStore.select((s) => s.activeChannelId);
      // Set only when the branch below clears a channel that was active
      // before this ready — distinct from "no channel was active", which
      // must NOT mark-read whatever the auto-select branch just picked.
      let activeChannelCleared = false;
      if (currentActive === null && payload.channels.length > 0) {
        const firstText = payload.channels.find((ch) => ch.type === "text");
        if (firstText !== undefined) {
          setActiveChannel(firstText.id);
        }
      } else if (currentActive !== null) {
        const stillPresent =
          payload.channels.some((ch) => ch.id === currentActive) ||
          (payload.dm_channels ?? []).some((dm) => dm.channel_id === currentActive);
        if (!stillPresent) {
          setActiveChannel(null);
          activeChannelCleared = true;
        }
      }

      // Populate DM channels from the ready payload. The server always sends
      // the field, so an empty array is an authoritative "no open DMs" (all
      // closed/left on another device) and must clear ghosts from dmStore —
      // skipping it would let a stale DM survive every reconnect.
      const dmPayloads = payload.dm_channels ?? [];
      setDmChannels(dmPayloads.map(mapDmPayload));

      // The server's read_states go stale while a channel stays focused
      // (channel_focus is sent once per mount, mark_read only from the context
      // menu), so a full-ready resync restates non-zero unread/mention counts
      // for the very channel the user is reading. Mark it read: this advances
      // the server read state and clears the local badges, for server channels
      // and DMs alike. Skipped on first connect (nothing was active yet) and
      // when the block above just cleared a channel that's gone.
      if (currentActive !== null && !activeChannelCleared) {
        markChannelRead(currentActive);
      }

      // Refresh DM block state (channels-members-dms.md §3.2). "Being blocked"
      // is only known from a refused send, so it's stale after a reconnect —
      // clear it and re-fetch our own outgoing blocks authoritatively.
      clearBlockedByThem();
      if (api !== undefined) {
        api
          .listBlocks()
          .then((r) => setBlockedByMe(r.blocked_user_ids))
          .catch((err) => log.warn("Failed to load block list", { error: String(err) }));
      }

      // Custom emoji are not in the ready payload (they are server-wide and
      // change rarely, so they do not belong in the per-session dump). Load
      // them once here; `emoji_update` keeps them fresh from then on. A
      // failure is non-fatal — unresolved shortcodes stay plain text.
      if (api?.listEmoji !== undefined) {
        api
          .listEmoji()
          .then((list) => setCustomEmoji(list))
          .catch((err) => log.warn("Failed to load custom emoji", { error: String(err) }));
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
      const dm = mapDmPayload(payload);
      addDmChannel(dm);

      // A DM's channels-store row is synthesised from the DM store, and this
      // event is also how a *membership* change arrives (group renamed, member
      // left). Without this the chat header would keep the name the DM had
      // when it was first opened, until the user navigated away and back.
      channelsStore.setState((prev) => {
        const existing = prev.channels.get(dm.channelId);
        const name = dmDisplayName(dm);
        if (existing === undefined || existing.name === name) return prev;
        const next = new Map(prev.channels);
        next.set(dm.channelId, { ...existing, name });
        return { ...prev, channels: next };
      });
    }),
  );

  unsubs.push(
    ws.on(S.DM_CHANNEL_CLOSE, (payload) => {
      log.info("DM channel closed", { channelId: payload.channel_id });
      // Delivered to a device that never ran the local close flow (closed
      // from another signed-in device) — unlike the sidebar's closeOrLeaveDm,
      // there is no "channel visited before this DM" to restore, so fall
      // back to another open DM, else the first text channel.
      closeDmLocally(payload.channel_id, () => {
        const remaining = dmStore.getState().channels;
        if (remaining.length > 0) {
          setActiveChannel(remaining[0]!.channelId);
          return;
        }
        const firstText = [...channelsStore.getState().channels.values()]
          .filter((ch) => ch.type === "text")
          .toSorted((a, b) => a.position - b.position)[0];
        setActiveChannel(firstText?.id ?? null);
      });
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
      const activeId = channelsStore.select((s) => s.activeChannelId);

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
      const isMention = highlightsCurrentUser(payload.content, {
        mentions: payload.mentions,
        mentionsEveryone: payload.mentions_everyone,
      });

      if (payload.channel_id !== activeId && !isOwnMessage && !ws.isReplaying()) {
        incrementUnread(payload.channel_id);
        // A mention is an unread too — the mention badge just outranks it.
        if (isMention) {
          incrementMention(payload.channel_id);
        }
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
          updateDmLastMessage(payload.channel_id, payload.id, payload.content, payload.timestamp);
          // The DM badge reads dmStore's mentionCount (mute-immune, rendered
          // by DmSidebar) — incrementMention above no-ops for DM ids, which
          // are absent from channelsStore. Same guards as the unread bump.
          if (isMention) {
            incrementDmMention(payload.channel_id);
          }
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
    ws.on(S.CHAT_BULK_DELETED, (payload) => {
      bulkDeleteMessages(payload);
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
      // The who-reacted tooltip caches the reactor list per message+emoji; any
      // add/remove on this message makes those lists stale.
      invalidateReactionUsers(payload.message_id);
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
      // custom_status is passed through verbatim, undefined included: the
      // store treats "field absent" as "leave the text alone", which is what
      // an older server's presence event means.
      updatePresence(payload.user_id, payload.status, payload.custom_status);
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
          .toSorted((a, b) => a.position - b.position);
        const firstTextId = sorted.length > 0 ? sorted[0]!.id : null;
        setActiveChannel(firstTextId);
        // The redirect alone reads as the app spontaneously changing channels;
        // say why (ux/channels-members-dms §1.2).
        showToast("This channel was deleted", "info");
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

  // Roles changed server-side (created, edited, deleted or reordered). The
  // payload is the whole list, so the store is replaced rather than patched —
  // name colors, the member-list groups and every permission-gated affordance
  // re-derive from it without a reconnect.
  unsubs.push(
    ws.on(S.ROLES_UPDATE, (payload) => {
      log.info("Roles updated", { count: payload.roles?.length ?? 0 });
      setRoles(payload.roles ?? []);
    }),
  );

  // Custom emoji changed server-side (uploaded or deleted). Whole set, like
  // roles_update: the store is replaced so a deleted emoji stops rendering in
  // messages, pickers and reaction pills without a reconnect.
  unsubs.push(
    ws.on(S.EMOJI_UPDATE, (payload) => {
      log.info("Custom emoji updated", { count: payload.emoji?.length ?? 0 });
      setCustomEmoji(payload.emoji ?? []);
    }),
  );

  unsubs.push(
    ws.on(S.USER_UPDATE, (payload) => {
      log.info("User profile updated", { userId: payload.user_id, username: payload.username });
      updateMemberProfile(payload.user_id, {
        username: payload.username,
        avatar: payload.avatar,
        displayName: payload.display_name,
        identityPublicKey: payload.identity_public_key,
      });

      // Update auth store if the current user changed their own profile.
      const currentUser = authStore.getState().user;
      if (currentUser && payload.user_id === currentUser.id) {
        setAuth(
          authStore.getState().token ?? "",
          {
            ...currentUser,
            username: payload.username,
            avatar: payload.avatar,
            display_name: payload.display_name,
            about: payload.about,
          },
          authStore.getState().serverName ?? "",
          authStore.getState().motd ?? "",
        );
      }
    }),
  );

  // ── Voice ─────────────────────────────────────────────

  unsubs.push(
    ws.on(S.VOICE_STATE, (payload) => {
      updateVoiceState(payload);
      // Auto-join voice channel if the event is for the current user
      const currentUserId = authStore.getState().user?.id ?? 0;
      if (payload.user_id !== currentUserId) return;
      joinVoiceChannel(payload.channel_id);
      // Honor a moderator's mute/deafen locally. Mute is also enforced at the
      // SFU, but deafen governs what WE play back, so the client is the only
      // place it can take effect. Both apply through one lazy import so the
      // two effects cannot land in different ticks.
      const voice = voiceStore.getState();
      const applyDeafen = payload.server_deafened === true && !voice.localDeafened;
      const applyMute = payload.server_muted === true && !voice.localMuted;
      if (applyDeafen || applyMute) {
        void livekitSession().then(({ setDeafened, setMuted }) => {
          if (applyDeafen) setDeafened(true);
          if (applyMute) setMuted(true);
        });
      }
    }),
  );

  // A moderator moved this client: tear the media session down and re-join the
  // destination through the ordinary join path (the server already removed us
  // from the old room and broadcast voice_leave).
  unsubs.push(
    ws.on(S.VOICE_MOVED, (payload) => {
      log.info("Moved to another voice channel by a moderator", {
        toChannelId: payload.to_channel_id,
      });
      void livekitSession().then(({ leaveVoice }) => {
        leaveVoice(false);
        leaveVoiceChannel();
        joinVoiceChannel(payload.to_channel_id);
        ws.send({ type: "voice_join", payload: { channel_id: payload.to_channel_id } });
      });
    }),
  );

  // A moderator disconnected this client from voice. voice_leave has already
  // cleared the store; this only surfaces the reason.
  unsubs.push(
    ws.on(S.VOICE_DISCONNECTED, (payload) => {
      log.info("Disconnected from voice by a moderator", { channelId: payload.channel_id });
      void livekitSession().then(({ leaveVoice }) => leaveVoice(false));
      leaveVoiceChannel();
      showToast(payload.reason || "You were disconnected from voice", "error");
    }),
  );

  unsubs.push(
    ws.on(S.VOICE_LEAVE, (payload) => {
      removeVoiceUser(payload);
      const currentUserId = authStore.getState().user?.id ?? 0;
      const isSelf = payload.user_id === currentUserId;
      // A server-initiated eviction (revocation sweep, channel delete) has no
      // companion teardown message — this voice_leave IS the signal that
      // drives our own LiveKit/E2EE teardown, or mic publish and key material
      // stay live while the UI shows not-in-voice. Guard on channel match: a
      // late-arriving voice_leave for a channel we already left (and rejoined
      // elsewhere) must not kill a newer join. Read the store before
      // leaveVoiceChannel() below clears currentChannelId.
      const shouldTeardownSession =
        isSelf && voiceStore.getState().currentChannelId === payload.channel_id;
      // Notify E2EE state machine so key holder can rotate the room key, and
      // (when applicable) tear down the media session — both through one lazy
      // import so the two effects cannot land in different ticks.
      void livekitSession().then(({ handleParticipantLeft, leaveVoice }) => {
        void handleParticipantLeft(payload.user_id);
        if (shouldTeardownSession) void leaveVoice(false);
      });
      // Clear local voice state if the current user was removed (kick/disconnect)
      if (isSelf) {
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
      void livekitSession().then(({ handleVoiceToken }) =>
        handleVoiceToken(
          payload.token,
          payload.url,
          payload.channel_id,
          payload.direct_url,
          payload.is_key_holder,
        ),
      );
    }),
  );

  // ── Voice E2EE (client-side ECDH key exchange) ────────

  unsubs.push(
    ws.on(S.VOICE_E2EE_ANNOUNCE, (payload) => {
      void livekitSession().then(({ handleE2EEAnnounce }) =>
        handleE2EEAnnounce(payload.user_id, payload.public_key, payload.signature),
      );
    }),
  );

  unsubs.push(
    ws.on(S.VOICE_E2EE_OFFER, (payload) => {
      void livekitSession().then(({ handleE2EEOffer }) =>
        handleE2EEOffer(payload.from_user_id, payload.encrypted_key, payload.iv),
      );
    }),
  );

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
  unsubs.push(
    ws.onStateChange((state) => {
      if (state !== "reconnecting" && state !== "disconnected") return;
      // Snapshot the ids: markSendFailed deletes from pendingSends, so
      // iterating the live Map's keys would mutate during iteration.
      for (const id of Array.from(messagesStore.getState().pendingSends.keys())) {
        markSendFailed(id, "OFFLINE");
      }
    }),
  );

  unsubs.push(
    ws.onSendFailure((id, code) => {
      if (messagesStore.getState().pendingSends.has(id)) {
        markSendFailed(id, code);
        return;
      }
      rollbackReaction(id);
    }),
  );

  unsubs.push(
    ws.on(S.ERROR, (payload, id) => {
      log.error("Server error", {
        code: payload.code,
        message: payload.message,
        id,
      });
      if (payload.code === "BANNED") {
        // Banned users must not reconnect — show error and force logout.
        setTransientError(payload.message || "You have been banned");
        clearAuth();
        return;
      }
      // If the error carries the request id of a pending optimistic send, mark
      // that specific row failed (with retry) instead of a global toast. This
      // covers SLOW_MODE, FORBIDDEN, RATE_LIMITED, BAD_REQUEST, etc. on send.
      if (id && messagesStore.getState().pendingSends.has(id)) {
        // A FORBIDDEN on a DM send is the server's generic block refusal
        // (ErrBlocked → FORBIDDEN, bidirectional). Gate the composer with the
        // neutral "being blocked" reason; blocks.store precedence still shows
        // the explicit reason if we are the blocker. Read the channel before
        // markSendFailed clears the pending row.
        if (payload.code === "FORBIDDEN") {
          const chId = messagesStore.getState().pendingSends.get(id);
          const dm =
            chId === undefined
              ? undefined
              : dmStore.getState().channels.find((c) => c.channelId === chId);
          // Block gating is a 1:1-only rule (server exempts group DMs from
          // block checks entirely — a group FORBIDDEN means something else,
          // e.g. stale membership). recipient is just participants[0] for a
          // group, so flagging it there would gate an unrelated 1:1 DM.
          if (dm !== undefined && !dm.isGroup) setUserBlockedByThem(dm.recipient.id, true);
        }
        markSendFailed(id, payload.code);
        return;
      }
      // A failed optimistic reaction toggle: the pill reverting is the
      // feedback the spec asks for (ux/messaging §5) — no toast on top.
      if (id !== undefined && rollbackReaction(id)) {
        return;
      }
      // Voice capacity refusals. The server owns the limits (voice_max_users /
      // voice_max_video) and refuses the join or the camera; the client never
      // pre-blocks the click, because its copy of the participant list can lag
      // and a refusal it invented would be uncorrectable. So the only job here
      // is to say what happened — without this the click was a silent no-op
      // with an explanation buried in the log.
      if (payload.code === "CHANNEL_FULL") {
        showToast(payload.message || "That voice channel is full", "error");
        return;
      }
      if (payload.code === "VIDEO_LIMIT") {
        showToast(payload.message || "That voice channel has reached its video limit", "error");
        // max_video has no SFU-level enforcement — the server only refuses the
        // DB write. Without this rollback the already-published camera track
        // keeps streaming to everyone while voice_state says camera=false.
        void livekitSession().then(({ disableCamera }) => disableCamera());
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
