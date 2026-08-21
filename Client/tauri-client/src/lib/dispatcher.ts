// Step 2.26 — WebSocket Dispatcher
// Wires WS client events to store updates.
// Each server message type maps to one or more store actions.

import type { WsClient } from "./ws";
import { toConnectionStatus, setActiveChannelProvider } from "./ws";
import { authStore, setAuth, clearAuth, updateUser } from "@stores/auth.store";
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
  setMessages,
  invalidateLoadedMessageWindows,
  setChannelLoading,
  setChannelLoadError,
  isWindowDetached,
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
  updateVoiceUserProfile,
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
  clearDmUnread,
  updateDmLastMessage,
  updateDmLastMessagePreview,
  dmDisplayName,
  updateDmParticipant,
} from "@stores/dm.store";
import type { DmChannel } from "@stores/dm.store";
import {
  blocksStore,
  setBlockedByMe,
  setUserBlockedByThem,
  clearBlockedByThem,
} from "@stores/blocks.store";
import { emojiStore, setCustomEmoji } from "@stores/emoji.store";
import type { DmChannelPayload } from "./types";
import { isTextLikeChannel } from "./types";
import type { ApiClient } from "./api";
import { invalidateReactionUsers } from "@components/message-list/reaction-tooltip";
import { notifyIncomingMessage } from "./notifications";
import { mentionsCurrentUser } from "./mentions";
import { ensureIdentityKeyPublished } from "@lib/identity";
import { markChannelRead } from "./read-state";
import { createLogger } from "./logger";
import { showToast } from "./toast";
import { ServerMessageType as S } from "./protocolTypes";
// SidebarDmHelpers is page-level, but addDmToChannelsStore is the only
// place the DM->channelsStore mirror row is synthesized (selectDmConversation
// on open); the dm_channel_close fallback below needs the same synthesis for
// a DM it is activating that was never opened this session.
import { addDmToChannelsStore } from "@pages/main-page/SidebarDmHelpers";

const log = createLogger("dispatcher");

/**
 * OC-0024: serverClockSkewMs (see wireDispatcher) starts at 0 and is only
 * ever sampled from a frame the replay check itself already accepted as
 * live — so if the channel is quiet between login and the first reconnect,
 * the skew is never sampled, and a lagging/skewed server clock then makes
 * every genuinely live message look like a replay for as long as real
 * elapsed time takes to exceed the drift (which can be unbounded). A
 * replayed burst is delivered as a burst immediately after auth_ok, so cap
 * how long a frame can be classified as a replay by wall-clock distance from
 * the handshake as well as by timestamp — that bounds a cold (unsampled)
 * skew's worst case to this window instead of the whole drift, while still
 * covering the burst's actual delivery window with room to spare.
 */
const REPLAY_GATE_WINDOW_MS = 5_000;

/** Lazily import the LiveKit session module. livekit-client (~1.3 MB) is kept
 *  out of the entry chunk; voice handlers load it on first use. Once a voice
 *  flow has started the module is cached, so this resolves in a microtask. */
function livekitSession(): Promise<typeof import("@lib/livekitSession")> {
  return import("@lib/livekitSession");
}

/**
 * Honor a moderator's mute/deafen locally. Mute is also enforced at the SFU,
 * but deafen governs what WE play back, so the client is the only place it
 * can take effect (Server/ws/voice_moderation.go: "enforced by the target's
 * client honoring server_deafened"). Both apply through one lazy import so
 * the two effects cannot land in different ticks.
 *
 * Called from both the incremental VOICE_STATE path and the full-resync
 * READY path (a WS drop that outlives the LiveKit session can mean a
 * moderator mute/deafen issued while disconnected is only ever delivered via
 * `ready`'s voice_states, never a voice_state the client could have missed).
 * The `!voice.localMuted`/`!voice.localDeafened` guards make it safe to call
 * from either path — or both, on the same session — without redundantly
 * re-invoking the livekit calls once already applied.
 *
 * OC-0246: a moderator restriction must also be released once it is lifted.
 * `setMuted`/`setDeafened` deliberately send no voice_mute/voice_deafen frame
 * (unlike the user's own toggle), so nothing else ever un-applies a
 * moderator-imposed local mute/deafen — without this, the falling edge
 * (server_muted/server_deafened going back to false) left the client
 * permanently silent/deaf while every peer's roster, and the server's own
 * voice_states row, said otherwise. `prevServerMuted`/`prevServerDeafened`
 * scope the release to the exact frame the restriction was lifted on (a
 * falling edge), rather than to every voice_state that happens to show the
 * flag already false — the latter would risk undoing an in-flight optimistic
 * self-mute from an unrelated restated voice_state (e.g. a camera toggle).
 * `selfMuted`/`selfDeafened` are the row's own muted/deafened fields (never
 * touched by moderation, always kept in sync with the user's own toggle via
 * voice_mute/voice_deafen) — requiring them to also be false before
 * releasing means a genuine self-mute that happens to coincide with the
 * moderator's release is never clobbered.
 */
function enforceModeratorAudioState(
  serverMuted: boolean,
  serverDeafened: boolean,
  prevServerMuted: boolean,
  prevServerDeafened: boolean,
  selfMuted: boolean,
  selfDeafened: boolean,
): void {
  const voice = voiceStore.getState();
  const applyDeafen = serverDeafened && !voice.localDeafened;
  const applyMute = serverMuted && !voice.localMuted;
  const releaseMute = prevServerMuted && !serverMuted && voice.localMuted && !selfMuted;
  const releaseDeafen =
    prevServerDeafened && !serverDeafened && voice.localDeafened && !selfDeafened;
  if (applyDeafen || applyMute || releaseMute || releaseDeafen) {
    void livekitSession().then(({ setDeafened, setMuted }) => {
      if (applyDeafen) setDeafened(true);
      if (applyMute) setMuted(true);
      if (releaseMute) setMuted(false);
      if (releaseDeafen) setDeafened(false);
    });
  }
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
 * present it is used to refresh DM block state (GET /blocks) on ready, and to
 * refetch the active channel's history after a full-ready resync.
 */
export function wireDispatcher(
  ws: WsClient,
  api?: Pick<ApiClient, "listBlocks"> &
    Partial<Pick<ApiClient, "updateProfile" | "getConfig" | "listEmoji" | "getMessages">>,
): DispatcherCleanup {
  const unsubs: Array<() => void> = [];

  // A second (or later) auth_ok/ready in this call's lifetime is always a
  // reconnect: wireDispatcher is called once per login (main.ts's
  // wirePostAuth), and every automatic reconnect fires its events through
  // these same long-lived listeners. Closure-scoped so a fresh login (a new
  // wireDispatcher call) always starts clean.
  let hasAuthenticatedBefore = false;
  let hasReceivedReadyBefore = false;
  // Set from the second-or-later auth_ok — the reconnect handshake time, in
  // THIS CLIENT's clock. A chat_message replay frame the transport delivers
  // after it is timestamped *before* it; a genuinely live message is
  // timestamped after. But payload.timestamp is the SERVER's created_at, in
  // the SERVER's clock — comparing it to this anchor directly mixes clock
  // domains, so the comparison below shifts the anchor into server time
  // using serverClockSkewMs first (see its declaration below).
  let lastReconnectHandshakeAt: number | null = null;
  // Running estimate of (this client's clock) minus (the server's clock),
  // sampled from the most recently accepted live chat_message (Date.now() at
  // receipt minus that frame's own server timestamp). A self-hosted server
  // routinely runs without NTP or with a skewed TZ/clock, and comparing its
  // timestamps against lastReconnectHandshakeAt without this correction means
  // a lagging server clock makes every genuinely live message look like a
  // replay for the whole drift window after every reconnect — and with
  // persistent skew that never recovers. Network latency between the
  // server's send and this receipt biases the estimate positive, which nudges
  // the boundary computed below slightly EARLY relative to the server's true
  // clock; that is the safe direction — a missed replay suppression is at
  // worst a duplicate notification, while a false replay classification
  // silently drops one.
  let serverClockSkewMs = 0;

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
      if (hasAuthenticatedBefore) {
        lastReconnectHandshakeAt = Date.now();
      }
      hasAuthenticatedBefore = true;
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
      // OC-0201: snapshot the current voice channel's peer roster BEFORE the
      // wholesale replace below, so the reconciliation branch further down
      // can tell who left while the socket was down. Must run before
      // setVoiceStates() overwrites voiceUsers with the fresh payload.
      const prevVoiceChannelId = voiceStore.getState().currentChannelId;
      const prevVoicePeerIds =
        prevVoiceChannelId !== null
          ? new Set(voiceStore.getState().voiceUsers.get(prevVoiceChannelId)?.keys() ?? [])
          : new Set<number>();
      // OC-0246: same reasoning as the VOICE_STATE handler — snapshot the
      // pre-resync moderator flags before setVoiceStates() overwrites them,
      // so a moderator restriction lifted while we were disconnected (and
      // still applied locally from before the drop) is released here too.
      const prevSelfServerMuted = voiceStore.getState().localServerMuted ?? false;
      const prevSelfServerDeafened = voiceStore.getState().localServerDeafened ?? false;

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
      const selfVoiceState =
        currentUserId !== 0
          ? payload.voice_states.find((vs) => vs.user_id === currentUserId)
          : undefined;
      const voiceSessionActive = voiceStore.getState().voiceStatus !== "idle";
      if (selfVoiceState !== undefined && !voiceSessionActive) {
        log.warn("Stale voice state detected in ready payload — sending voice_leave");
        ws.send({ type: "voice_leave", payload: {} });
        leaveVoiceChannel();
      } else if (selfVoiceState !== undefined) {
        // A LiveKit session survived a WS drop that outlived it (nothing
        // tears voice down on a socket drop alone) — OC-0014: this full
        // resync is the only place a moderator mute/deafen issued while we
        // were disconnected ever reaches us, since the mustFullResync tier
        // that produced this `ready` never replays the voice_state that
        // would otherwise have carried it.
        enforceModeratorAudioState(
          selfVoiceState.server_muted === true,
          selfVoiceState.server_deafened === true,
          prevSelfServerMuted,
          prevSelfServerDeafened,
          selfVoiceState.muted,
          selfVoiceState.deafened,
        );

        // OC-0201: same gap, for E2EE. A full resync never replays the
        // voice_leave for anyone who departed our voice channel during the
        // outage — handleParticipantLeft (the only path that prunes a
        // departed peer's key, rotates for membership forward secrecy, and
        // re-runs the lowest-uid key-holder election) is otherwise only ever
        // driven by a live voice_leave frame. Without this, a departed peer
        // keeps a working room key indefinitely, and a client the server
        // just elected key holder on reconnect (Server/ws hub.go
        // registerNow -> updateKeyHolder) never self-elects. Only reconcile
        // when the resync's self voice state is for the SAME channel the
        // snapshot above was taken from — a channel change is out of scope
        // here and comparing rosters across two different channels would
        // misfire.
        if (prevVoiceChannelId === selfVoiceState.channel_id) {
          const currentVoicePeerIds = new Set(
            payload.voice_states
              .filter((vs) => vs.channel_id === selfVoiceState.channel_id)
              .map((vs) => vs.user_id),
          );
          for (const uid of prevVoicePeerIds) {
            if (uid === currentUserId || currentVoicePeerIds.has(uid)) continue;
            void livekitSession().then(({ handleParticipantLeft }) => handleParticipantLeft(uid));
          }
        }
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
        const firstText = payload.channels.find((ch) => isTextLikeChannel(ch));
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

      // A second (or later) `ready` in this dispatcher's lifetime only ever
      // arrives from a full-ready resync (Server/ws/serve.go: a fresh connect
      // and a full resync are the only paths that send `ready` at all — a
      // successful seq-based replay reconnect does not), and that tier never
      // replays missed chat_message frames. Every channel this session had
      // already loaded would otherwise keep a permanent, silent hole in its
      // history — invalidate them and refetch the one actually on screen.
      if (hasReceivedReadyBefore) {
        const activeAfterReady = channelsStore.select((s) => s.activeChannelId);
        const getMessages = api?.getMessages;
        // Only invalidate when the refetch below can actually happen — api is
        // a Partial<...>, so getMessages may be absent, and there may be no
        // resolvable active channel to refetch. Dropping every loaded window
        // with nothing able to reload it would leave a mounted MessageList
        // showing only carried-through pending rows until the user navigates
        // away and back.
        if (activeAfterReady !== null && getMessages !== undefined) {
          // Mark the active channel loading BEFORE invalidating its window —
          // invalidate drops its rows synchronously, and if historyLoadState
          // is left idle for even one microtask, MessageList's "no rows +
          // idle" empty-state branch renders the channel as genuinely empty
          // for the whole in-flight refetch instead of showing the in-region
          // spinner (OC-0007).
          setChannelLoading(activeAfterReady);
          invalidateLoadedMessageWindows();
          getMessages(activeAfterReady, { limit: 50 })
            .then((resp) => {
              // OC-0203: the user can switch (or the active channel can be
              // cleared) while this fetch is in flight. Writing the snapshot
              // unconditionally would re-add a channel the user already left
              // to loadedChannels with a pre-resync-era snapshot —
              // MessageController.loadMessages then short-circuits on
              // isChannelLoaded() forever, so the hole this whole resync
              // block exists to close becomes permanent instead. Only the
              // channel still on screen when the response lands may accept
              // it.
              if (channelsStore.select((s) => s.activeChannelId) !== activeAfterReady) return;
              setMessages(activeAfterReady, resp.messages, resp.has_more);
            })
            .catch((err) => {
              log.warn("Failed to reload message history after resync", { error: String(err) });
              // Same staleness guard as the .then above — a rejection for a
              // channel the user already left must not flag it load-errored;
              // that channel's own mount/retry path owns its state now.
              if (channelsStore.select((s) => s.activeChannelId) !== activeAfterReady) return;
              // The invalidate above already dropped this channel's window,
              // so a silent catch would leave a mounted MessageList showing
              // its "no messages yet" welcome state — indistinguishable from
              // a genuinely empty channel. Route through the same
              // historyLoadState the normal load path uses so the region
              // shows the inline error + Retry instead (MessageController's
              // loadMessages, wired to the Retry button, re-fetches because
              // invalidate also cleared "loaded").
              setChannelLoadError(activeAfterReady);
            });
        }
      }
      hasReceivedReadyBefore = true;

      // Populate DM channels from the ready payload. The server always sends
      // the field, so an empty array is an authoritative "no open DMs" (all
      // closed/left on another device) and must clear ghosts from dmStore —
      // skipping it would let a stale DM survive every reconnect.
      const dmPayloads = payload.dm_channels ?? [];
      setDmChannels(dmPayloads.map(mapDmPayload));

      // The channels-store mirror row for a DM (synthesized on open by
      // addDmToChannelsStore) is deliberately carried across setChannels'
      // rebuild above, because the ready payload never includes DM rows at
      // all — but that means a DM closed elsewhere while this client was
      // offline keeps a phantom row here (closeDmLocally fixes this exact
      // shape for the live dm_channel_close path; this is its ready-time
      // equivalent), and a DM read elsewhere keeps a stale unread/mention
      // count (incrementUnread/incrementMention bump the mirror in parallel
      // with dmStore once it exists, but only dmStore is restated above).
      // Reconcile every dm-typed row against the just-restated payload.
      channelsStore.setState((prev) => {
        const dmById = new Map(dmPayloads.map((d) => [d.channel_id, d]));
        const nextChannels = new Map(prev.channels);
        let changed = false;
        for (const [id, ch] of prev.channels) {
          if (ch.type !== "dm") continue;
          const dm = dmById.get(id);
          if (dm === undefined) {
            nextChannels.delete(id);
            changed = true;
            continue;
          }
          const mentionCount = dm.mention_count ?? 0;
          if (ch.unreadCount !== dm.unread_count || ch.mentionCount !== mentionCount) {
            nextChannels.set(id, { ...ch, unreadCount: dm.unread_count, mentionCount });
            changed = true;
          }
        }
        return changed ? { ...prev, channels: nextChannels } : prev;
      });

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
        // OC-0218: snapshot the revision blocksStore was at right before
        // issuing this fetch. If the user blocks/unblocks someone (via
        // SidebarMemberSection's onToggleBlock -> setUserBlockedByMe) while
        // this GET is in flight, that per-user delta bumps the revision;
        // setBlockedByMe then sees the mismatch and skips applying this
        // reply instead of clobbering the fresher local truth with a stale
        // full-set snapshot.
        const blockedByMeRevAtFetch = blocksStore.getState().blockedByMeRev ?? 0;
        api
          .listBlocks()
          .then((r) => setBlockedByMe(r.blocked_user_ids, blockedByMeRevAtFetch))
          .catch((err) => log.warn("Failed to load block list", { error: String(err) }));
      }

      // Custom emoji are not in the ready payload (they are server-wide and
      // change rarely, so they do not belong in the per-session dump). Load
      // them once here; `emoji_update` keeps them fresh from then on. A
      // failure is non-fatal — unresolved shortcodes stay plain text.
      //
      // OC-0251: snapshot the revision emojiStore was at right before issuing
      // this fetch, mirroring the OC-0218 blockedByMeRev guard above. The GET
      // travels over a separate HTTP connection while an `emoji_update` can
      // arrive on the already-open socket — if one lands (bumping the
      // revision) while this GET is in flight, setCustomEmoji sees the
      // mismatch and skips applying this reply instead of clobbering the
      // fresher broadcast with a stale full-set snapshot.
      if (api?.listEmoji !== undefined) {
        const emojiRevAtFetch = emojiStore.getState().rev ?? 0;
        api
          .listEmoji()
          .then((list) => setCustomEmoji(list, emojiRevAtFetch))
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
          // Synthesize the channelsStore mirror row before activating: it is
          // only ever created by addDmToChannelsStore (on open, via
          // selectDmConversation), so a DM present in dmStore from `ready`
          // but never opened this session has none — without this,
          // activating it lands on an id ChannelController can't resolve and
          // blanks the chat area with no way to recover.
          addDmToChannelsStore(remaining[0]!);
          // A DM's unread badge lives in dmStore, not the channelsStore
          // mirror — setActiveChannel only zeroes the latter. Every other
          // "open this DM" path (selectDmConversation, navigateToChannel,
          // markChannelRead) pairs activation with clearDmUnread for exactly
          // this reason; without it here the badge on the DM we're about to
          // treat as active survives forever (new messages take the
          // isDmActive branch below and never increment it back).
          clearDmUnread(remaining[0]!.channelId);
          setActiveChannel(remaining[0]!.channelId);
          return;
        }
        const firstText = [...channelsStore.getState().channels.values()]
          .filter((ch) => isTextLikeChannel(ch))
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

      // Increment channel-level unread for non-active, non-own-message
      // channels — OR for the active channel when its loaded window is
      // detached from the live tail (OC-0204). "Active" normally means "the
      // user is watching the live tail", which is why it is otherwise
      // excluded here, but a jump to an old permalink/reply/search hit can
      // leave the active channel showing a detached around-window
      // (messages.store's detachedChannels) — addMessage already refuses to
      // append a live broadcast onto that window, so without this a message
      // (an @mention included) that arrives while the user reads
      // back-history leaves no row AND no badge, with nothing to tell them
      // it ever arrived. Replayed frames increment unread counts like live
      // ones — the burst is exactly the messages missed while away (a
      // full-ready resume sends no burst at all; ready's unread_count values
      // are authoritative there). DM channel IDs are not in channelsStore
      // (they use dmStore), so incrementUnread is a no-op for DMs, but the
      // own-message guard is applied here for defence-in-depth.
      //
      // isReplayFrame is computed here (rather than only below, where the
      // notification gate uses it) because the mention badge needs it too —
      // see isMention.
      const isReplayFrame =
        lastReconnectHandshakeAt !== null &&
        Date.now() - lastReconnectHandshakeAt < REPLAY_GATE_WINDOW_MS &&
        Date.parse(payload.timestamp) < lastReconnectHandshakeAt - serverClockSkewMs;
      // highlightsCurrentUser (mentions.ts) treats @everyone and @here as one
      // bit, because the wire carries only one: mentions_everyone. But the
      // server's applyMentionCounts (mentions.go) narrows an @here fan-out to
      // readers who had a live connection at send time — a reader with none
      // never got read_states.mention_count bumped for a here-only mention.
      // The reconnect tier that delivers this replay burst never follows up
      // with a `ready` to correct a wrongly-raised badge (OC-0271), so a
      // here-only mention landing inside that burst must not raise one here
      // either. A direct mention, or an @here/@everyone frame delivered live,
      // is unaffected — mentions_here is only ever set alongside
      // mentions_everyone for an @here (never a plain @everyone) token.
      const isMention =
        mentionsCurrentUser(payload.content, { mentions: payload.mentions }) ||
        (payload.mentions_everyone === true && !(payload.mentions_here === true && isReplayFrame));
      const isDetached = isWindowDetached(payload.channel_id);

      if ((payload.channel_id !== activeId || isDetached) && !isOwnMessage) {
        // incrementUnread/incrementMention skip the active channel by
        // default — evenIfActive (isDetached here) is a no-op for a
        // genuinely non-active channel, since their internal guard only
        // fires when channelId IS the active one.
        incrementUnread(payload.channel_id, isDetached);
        // A mention is an unread too — the mention badge just outranks it.
        if (isMention) {
          incrementMention(payload.channel_id, isDetached);
        }
      }

      // Update DM store last message if this message belongs to a DM channel.
      // Skip unread increment for own messages and the currently focused DM
      // — unless that DM's window is detached from the live tail (OC-0204),
      // the same exception the channel-level increment above makes.
      if (isDm) {
        const isDmActive = payload.channel_id === activeId && !isDetached;
        if (isOwnMessage || isDmActive) {
          // Update last message preview but don't increment unread count.
          updateDmLastMessagePreview(
            payload.channel_id,
            payload.id,
            payload.content,
            payload.timestamp,
          );
        } else {
          // The DM badge reads dmStore's mentionCount (mute-immune, rendered
          // by DmSidebar) — incrementMention above no-ops for DM ids, which
          // are absent from channelsStore. isMention is passed through so the
          // mention bump sits behind updateDmLastMessage's own message-id
          // guard (OC-0242) — a separate unconditional increment here would
          // double-count a mention redelivered between registerNow and
          // buildReady, since lastMessageId has already advanced by the time
          // any such follow-up call could check it.
          updateDmLastMessage(
            payload.channel_id,
            payload.id,
            payload.content,
            payload.timestamp,
            isMention,
          );
        }
      }

      // Fire desktop notification, taskbar flash, and sound — but not for a
      // reconnect's replayed burst. No connection-state flag can gate this:
      // the server writes auth_ok before the burst, so by the time replayed
      // frames arrive the client is already "connected". A replay frame's
      // timestamp instead predates the reconnect handshake that preceded it,
      // unlike a genuinely new live message — compared in server-clock terms
      // (see serverClockSkewMs above) so a lagging or skewed server clock
      // cannot make a live message look like a replay.
      // The wall-clock window additionally bounds a cold (never-sampled)
      // skew's damage — see REPLAY_GATE_WINDOW_MS. (isReplayFrame itself is
      // computed above, alongside isMention, which needs it too.)
      if (!isReplayFrame) {
        notifyIncomingMessage(payload);
        // Refresh the skew estimate from this accepted-as-live frame so it
        // stays current for the next reconnect.
        serverClockSkewMs = Date.now() - Date.parse(payload.timestamp);
      }
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
      // dmStore keeps its own frozen copy of a DM partner's status for the
      // sidebar row (see buildDmConversations) — membersStore alone does not
      // reach it.
      updateDmParticipant(payload.user_id, { status: payload.status });
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
          .filter((ch) => isTextLikeChannel(ch))
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

      // Keep authStore in sync when the signed-in user's own role changed —
      // every permission gate (canManageChannels, canViewAuditLog, ...) reads
      // authStore.user.role, not membersStore, so without this a promotion or
      // demotion of the current user would leave every affordance stale until
      // the socket reconnects (mirrors the USER_UPDATE self-branch below).
      const me = authStore.getState().user;
      if (me && payload.user_id === me.id) {
        updateUser({ role: payload.role });
      }
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
      // Same reasoning as PRESENCE above: dmStore's copy of a DM partner's
      // username/avatar/displayName is otherwise never refreshed. DmUser's
      // avatar/displayName are non-nullable ("" = unset), so null (cleared)
      // maps to "". display_name absent means "leave the nickname alone" —
      // an older or partial payload must not blank it, exactly as
      // updateMemberProfile above.
      updateDmParticipant(payload.user_id, {
        username: payload.username,
        avatar: payload.avatar ?? "",
        ...(payload.display_name === undefined ? {} : { displayName: payload.display_name ?? "" }),
      });
      // voiceStore.voiceUsers is the third store holding a frozen username
      // copy (see updateVoiceUserProfile's doc comment) — without this, a
      // rename leaves the voice roster showing the old name for the rest of
      // the call.
      updateVoiceUserProfile(payload.user_id, { username: payload.username });

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
      // Auto-join voice channel if the event is for the current user
      const currentUserId = authStore.getState().user?.id ?? 0;
      const isSelf = payload.user_id === currentUserId;
      // OC-0246: snapshot the pre-update moderator flags before updateVoiceState
      // overwrites them, so enforceModeratorAudioState can detect a falling
      // edge (a restriction that WAS in effect and is now lifted) rather than
      // only ever seeing the post-update state.
      const prevServerMuted = isSelf ? (voiceStore.getState().localServerMuted ?? false) : false;
      const prevServerDeafened = isSelf
        ? (voiceStore.getState().localServerDeafened ?? false)
        : false;
      updateVoiceState(payload);
      if (!isSelf) return;
      joinVoiceChannel(payload.channel_id);
      enforceModeratorAudioState(
        payload.server_muted === true,
        payload.server_deafened === true,
        prevServerMuted,
        prevServerDeafened,
        payload.muted,
        payload.deafened,
      );
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
      // OC-0031: this can arrive well after the kick already tore the
      // session down at the SFU (queued behind a backed-up outbound send
      // buffer) — by the time it's delivered the user may have already
      // rejoined this channel or another. Guard on channel match, same as
      // the sibling VOICE_LEAVE handler below (shouldTeardownSession) — a
      // stale frame for a channel already left must not kill a newer join.
      // Read the store before leaveVoiceChannel() below clears
      // currentChannelId.
      //
      // OC-0033: on the ordinary kick path, the server sends voice_leave to
      // the leaver (finishVoiceLeave) BEFORE handleVoiceModKickV2 sends this
      // voice_disconnected, so the sibling VOICE_LEAVE handler has typically
      // already nulled currentChannelId by the time this arrives. That's not
      // the OC-0031 staleness (a rejoin into a *different* channel) — treat
      // a cleared store as not-stale so the kick reason still gets shown.
      const cur = voiceStore.getState().currentChannelId;
      const stale = cur !== null && cur !== payload.channel_id;
      if (stale) {
        log.info("Ignoring stale voice_disconnected for a channel already left", {
          channelId: payload.channel_id,
        });
        return;
      }
      log.info("Disconnected from voice by a moderator", { channelId: payload.channel_id });
      void livekitSession().then(({ leaveVoice }) => leaveVoice(false));
      leaveVoiceChannel();
      showToast(payload.reason || "You were disconnected from voice", "error");
    }),
  );

  unsubs.push(
    ws.on(S.VOICE_LEAVE, (payload) => {
      // OC-0239: snapshot the roster BEFORE removeVoiceUser() below mutates
      // it. handleParticipantLeft's own stale-leave guard (OC-0213, "is this
      // peer still listed as present?") reads the SAME store — if it read
      // that after removeVoiceUser() already deleted the user, the check
      // would always see them as absent and could never tell a stale,
      // superseded-rejoin leave from a genuine departure, permanently
      // retiring a peer who never actually left. Pass this pre-mutation
      // snapshot through explicitly instead of relying on the post-mutation
      // store state.
      const stillInRoster =
        voiceStore.getState().voiceUsers.get(payload.channel_id)?.has(payload.user_id) ?? false;
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
        void handleParticipantLeft(payload.user_id, stillInRoster);
        if (shouldTeardownSession) void leaveVoice(false);
      });
      // Clear local voice state only for the same channel-match case as the
      // LiveKit teardown above. A channel switch optimistically moves the
      // store's currentChannelId to the NEW channel before the server
      // responds (VoiceCallbacks.onVoiceJoin); the server always leaves the
      // OLD channel first, so an unconditional clear here would blank the
      // store back to null on every switch — hiding the whole voice widget
      // (including its leave/mute controls) until a later voice_state
      // happens to restore it, or forever if the switch then fails
      // server-side.
      if (shouldTeardownSession) {
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
      // Same reasoning applies to optimistic reaction toggles: a reaction
      // frame already handed to a dying socket can never deliver its
      // chat_send_ok/error either, so roll back every pending toggle instead
      // of leaving a permanently wrong pill and a stale pendingReactions
      // entry that could later consume an unrelated self-echo.
      for (const id of Array.from(messagesStore.getState().pendingReactions?.keys() ?? [])) {
        rollbackReaction(id);
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
      // OC-0224: the sidebar/widget optimistically writes currentChannelId
      // before the server answers voice_join (VoiceCallbacks.onVoiceJoin,
      // voiceStatus="joining"). A first-time join refusal earns no
      // voice_leave (there was no previous channel to leave), so nothing
      // else ever clears that optimistic state — setVoiceStatus("idle") only
      // runs inside LiveKitSession.leaveVoice(). handleVoiceJoin can refuse
      // for CHANNEL_FULL, VOICE_ERROR, FORBIDDEN, NOT_FOUND, BAD_REQUEST,
      // RATE_LIMITED, ALREADY_JOINED, or INTERNAL — this used to only roll
      // back CHANNEL_FULL, leaving the sidebar keyed on a channel with no
      // LiveKit session for every other refusal. voice_join's error replies
      // carry no envelope id to correlate against (Server/ws/voice_join.go
      // always answers with buildErrorMsg, never buildErrorMsgWithID), so —
      // unlike the pendingSends/pendingReactions correlation above — this
      // can't be scoped to "the refusal that answered this specific join";
      // it runs once, ahead of every code-specific branch below, for any
      // error that lands while a join is outstanding. A channel *switch*
      // refusal hits the same guard: the self voice_leave for the OLD
      // channel that precedes it no longer resets voiceStatus (OC-0015 —
      // that voice_leave's channel no longer matches the already-updated
      // currentChannelId, so it must not tear down the NEW channel's
      // optimistic state either), so voiceStatus is still "joining" when
      // this error lands and the guard clears it here instead. A plain
      // store rollback is safe for an already-established session (never
      // "joining") and for a first-time join refusal (no prior session to
      // tear down) — but a channel *switch* refused at precheck (RATE_LIMITED,
      // FORBIDDEN, NOT_FOUND, archived-channel BAD_REQUEST) never reaches
      // voiceJoinLeaveCurrent server-side, so no voice_leave is broadcast and
      // the OLD channel's LiveKit room is still connected (mic still
      // published) while the store already points at the NEW channel
      // (OC-0193). isVoiceSessionActive() distinguishes that live-or-in-flight
      // case from the first-time-join refusal; tearing it down here also
      // sends voice_leave so the server/SFU state matches the now-cleared
      // store. OC-0249: isVoiceConnected() (Room !== null) reads false for
      // the entire "connecting" state — the very state a join is in while
      // voiceStatus is "joining" and connectAndSetup() still awaits
      // createRoom()/resolveLiveKitUrl() — so an unrelated error landing in
      // that window used to roll back only the store while the connect
      // attempt ran to completion unseen (hot mic, no UI). isVoiceSessionActive()
      // also covers "connecting"/"reconnecting", and leaveVoice() itself
      // already tolerates a null Room, aborting the in-flight attempt at its
      // next checkpoint.
      if (voiceStore.getState().voiceStatus === "joining") {
        void livekitSession().then(({ isVoiceSessionActive, leaveVoice }) => {
          if (isVoiceSessionActive()) leaveVoice(true);
        });
        leaveVoiceChannel();
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
        // DB write. Without this rollback the already-published track keeps
        // streaming to everyone while voice_state says camera/screenshare is
        // off. voice_controls.go routes both a refused voice_camera AND a
        // refused voice_screenshare enable through the same shared
        // enableVideoSlot cap check, so this code is not camera-specific —
        // correlate by envelope id, exactly like the generic rollback below,
        // instead of assuming it's always the camera. A bare VIDEO_LIMIT with
        // no id (older server / no correlation available) still falls back
        // to the camera, the only kind this branch used to handle.
        if (id !== undefined) {
          void import("@lib/screenShare").then(({ rollbackPendingVideo }) => {
            const kind = rollbackPendingVideo(id);
            // undefined means this id no longer correlates to anything
            // pending (superseded by a later enable of the same kind) — the
            // refusal is stale and there is nothing to roll back. It must
            // never be treated as "it was the camera".
            if (kind === undefined) return;
            void livekitSession().then(({ disableCamera, disableScreenshare }) =>
              kind === "screen" ? disableScreenshare() : disableCamera(),
            );
          });
        } else {
          void livekitSession().then(({ disableCamera }) => disableCamera());
        }
        return;
      }
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

      // A server refusal of a voice_camera/voice_screenshare enable other
      // than VIDEO_LIMIT (FORBIDDEN, RATE_LIMITED, INTERNAL, ...): roll back
      // the already-published track, or it keeps streaming to every peer
      // while the store says it's off. Correlated by envelope id — exactly
      // like pendingSends/pendingReactions above — so an unrelated
      // FORBIDDEN/RATE_LIMITED on some other action never touches video
      // state. screenShare.ts pulls in livekit-client at module scope, so —
      // like livekitSession() above — it's loaded lazily here too, at its
      // one call site in this file.
      if (id !== undefined) {
        void import("@lib/screenShare").then(({ rollbackPendingVideo }) => {
          const kind = rollbackPendingVideo(id);
          if (kind === undefined) return;
          void livekitSession().then(({ disableCamera, disableScreenshare }) =>
            kind === "camera" ? disableCamera() : disableScreenshare(),
          );
        });
      }
    }),
  );

  return () => {
    for (const unsub of unsubs) {
      unsub();
    }
  };
}
