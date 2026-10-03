// Chat message, reaction, typing and optimistic-send WebSocket handlers —
// extracted from lib/dispatcher.ts, which keeps every socket subscription and
// calls these plain functions.
import { authStore } from "../../stores/auth.store";
import { channelsStore, noteChannelMessage } from "../../stores/channels.store";
import {
  addMessage,
  updateReaction,
  rollbackReaction,
  confirmSend,
  markSendFailed,
  channelIdForSend,
  applyServerMessage,
  messagesStore,
  setMessages,
  setAroundMessages,
  getChannelMessages,
  invalidateLoadedMessageWindows,
  setChannelLoading,
  setChannelLoadError,
  isWindowDetached,
  editMessage,
  deleteMessage,
  bulkDeleteMessages,
  setMessagePinned,
} from "../../stores/messages.store";
import { setTyping, clearTyping } from "../../stores/members.store";
import {
  dmStore,
  reviseDmLastMessage,
  updateDmLastMessage,
  updateDmLastMessagePreview,
} from "../../stores/dm.store";
import { setUserBlockedByThem } from "../../stores/blocks.store";
import type { ConnectionState } from "../../lib/ws";
import { invalidateReactionUsers } from "./reactionUsers";
import { parseTimestamp } from "@lib/formatting";
import { notifyIncomingMessage } from "../../lib/notifications";
import { mentionsCurrentUser } from "../../lib/mentions";
import { showToast } from "../../lib/toast";
import { connectText } from "../../i18n/connect";
import { readingAnchor } from "./readingAnchor";
import {
  activatePendingMessages,
  acknowledgePendingMessage,
  pendingMessageBeforeRestore,
} from "../../lib/pendingMessages";
import type { DispatchApi, Payload, ReconnectClock } from "../connection/dispatchContext";
import { log } from "../connection/dispatchContext";

/**
 * OC-0024: serverClockSkewMs (see createReconnectClock) starts at 0 and is only
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

export function handleChatMessage(clock: ReconnectClock, payload: Payload<"chat_message">): void {
  if (payload.user.id === authStore.getState().user?.id) {
    acknowledgePendingMessage(payload.client_message_id);
  }
  log.debug("chat_message received", {
    id: payload.id,
    channelId: payload.channel_id,
    user: payload.user.username,
  });
  // DP-15: the sender's message landing clears their "is typing…" at once.
  // A no-op for an unknown typer (a reconnect replay burst carries no typing
  // state), and scoped to this channel + this sender so other typers stay.
  clearTyping(payload.channel_id, payload.user.id);
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
  // (they use dmStore), so noteChannelMessage is a no-op for DMs, but the
  // own-message guard is applied here for defence-in-depth.
  //
  // isReplayFrame is computed here (rather than only below, where the
  // notification gate uses it) because the mention badge needs it too —
  // see isMention.
  const isReplayFrame =
    clock.lastReconnectHandshakeAt !== null &&
    Date.now() - clock.lastReconnectHandshakeAt < REPLAY_GATE_WINDOW_MS &&
    parseTimestamp(payload.timestamp).getTime() <
      clock.lastReconnectHandshakeAt - clock.serverClockSkewMs;
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
  // P4-03: "active" only means "the reader is watching" while the window is
  // focused. A minimised or unfocused window shows nothing, so a message
  // landing in the active channel then must count like one in any other
  // channel (badge, taskbar, divider). document.hasFocus() is the same source
  // lib/notifications.ts uses, and the platform contracts say this focus check
  // needs no adapter; don't import isWindowFocused from lib/notifications,
  // which tests mock out.
  const isAway = isDetached || !document.hasFocus();

  if ((payload.channel_id !== activeId || isAway) && !isOwnMessage) {
    // noteChannelMessage skips the active channel by default —
    // evenIfActive (isAway here) is a no-op for a genuinely
    // non-active channel, since its internal guard only fires when
    // channelId IS the active one. It also guards both counters behind
    // payload.id vs. the channel's lastMessageId watermark (OC-0328), so
    // a message already reflected in a `ready` snapshot (delivered
    // between the server's registerNow and buildReady, then redelivered
    // as a queued chat_message) does not double-count.
    noteChannelMessage(payload.channel_id, payload.id, isMention, isAway);
  }

  // Update DM store last message if this message belongs to a DM channel.
  // Skip unread increment for own messages and the currently focused DM
  // — unless that DM's window is detached from the live tail (OC-0204),
  // the same exception the channel-level increment above makes.
  if (isDm) {
    const isDmActive = payload.channel_id === activeId && !isAway;
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
      // by DmSidebar) — noteChannelMessage above no-ops for DM ids, which
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
    clock.serverClockSkewMs = Date.now() - parseTimestamp(payload.timestamp).getTime();
  }
}

export function handleChatEdited(
  api: DispatchApi | undefined,
  payload: Payload<"chat_edited">,
): void {
  editMessage(payload);
  reviseDmLastMessage(payload.channel_id, payload.message_id, { lastMessage: payload.content });
  if (dmPreviewRefetches.has(payload.channel_id)) {
    reviseDmPreviewAfterDelete(api, payload.channel_id, []);
  }
}

export function handleChatDeleted(
  api: DispatchApi | undefined,
  payload: Payload<"chat_deleted">,
): void {
  deleteMessage(payload);
  reviseDmPreviewAfterDelete(api, payload.channel_id, [payload.message_id]);
}

export function handleChatBulkDeleted(
  api: DispatchApi | undefined,
  payload: Payload<"chat_bulk_deleted">,
): void {
  bulkDeleteMessages(payload);
  reviseDmPreviewAfterDelete(api, payload.channel_id, payload.ids);
}

/** The in-flight GET /dms refetch per DM channel: the preview id it was
 *  issued for, and the token of the only answer that may be applied. */
const dmPreviewRefetches = new Map<number, { shown: number; token: number }>();
let dmPreviewRefetchToken = 0;

/** A DM whose preview showed a now-deleted message is blanked at once, then
 *  takes the server's last message from GET /dms. A delete in the channel
 *  while that is in flight reissues it; an answer newer than the preview is
 *  dropped, since its chat_message frame owns it. */
function reviseDmPreviewAfterDelete(
  api: DispatchApi | undefined,
  channelId: number,
  ids: readonly number[],
): void {
  const shown = dmStore.getState().channels.find((c) => c.channelId === channelId)?.lastMessageId;
  if (shown === undefined || shown === null) return;
  if (!ids.includes(shown) && dmPreviewRefetches.get(channelId)?.shown !== shown) return;
  reviseDmLastMessage(channelId, shown, { lastMessage: "" });
  const getDmChannels = api?.getDmChannels;
  if (getDmChannels === undefined) return;
  const token = ++dmPreviewRefetchToken;
  dmPreviewRefetches.set(channelId, { shown, token });
  const settle = (): boolean => {
    if (dmPreviewRefetches.get(channelId)?.token !== token) return false;
    dmPreviewRefetches.delete(channelId);
    return true;
  };
  getDmChannels().then(
    (r) => {
      if (!settle()) return;
      const p = r.dm_channels.find((d) => d.channel_id === channelId);
      if (p === undefined || (p.last_message_id !== null && p.last_message_id > shown)) return;
      reviseDmLastMessage(channelId, shown, {
        lastMessageId: p.last_message_id,
        lastMessage: p.last_message,
        lastMessageAt: p.last_message_at,
      });
    },
    (err: unknown) => {
      if (settle()) {
        log.warn("Failed to refetch a DM preview after a delete", { error: String(err) });
      }
    },
  );
}

/** A message was pinned or unpinned elsewhere — keep this client's row in
 *  sync (F5). An open pinned panel is a fetched snapshot and does not follow
 *  this until it is reopened. */
export function handleChatPinned(payload: Payload<"chat_pinned">): void {
  setMessagePinned(payload.channel_id, payload.message_id, payload.pinned);
}

export function handleChatSendOk(
  api: DispatchApi | undefined,
  payload: Payload<"chat_send_ok">,
  id: string | undefined,
): void {
  acknowledgePendingMessage(payload.client_message_id);
  if (id) {
    // Resolve the channel before confirmSend: that call drops the
    // pendingSends entry and flips the row to "sent", destroying both
    // identities this lookup needs.
    const channelId = channelIdForSend(id, payload.client_message_id);
    confirmSend(id, payload.message_id, payload.timestamp, payload.client_message_id);
    // A deduplicated ack means the server already had the message, so no
    // chat_message broadcast follows to reconcile the row. The local copy
    // can be stale -- fetch the authoritative row and replace it in place.
    // The around endpoint 404s for a deleted message or one in another
    // channel, so a rejection here is only worth a log line.
    if (payload.deduplicated === true && channelId !== undefined && api?.getMessagesAround) {
      const getMessagesAround = api.getMessagesAround;
      const localRow = () =>
        messagesStore
          .getState()
          .messagesByChannel.get(channelId)
          ?.find((m) => m.id === payload.message_id);
      // The REST read is a snapshot; a chat_edited, chat_deleted or
      // reaction_update can land while it is in flight, and replacing the
      // row with the older snapshot would undo it (a deleted message is a
      // tombstone here, so it would come back). Store updates replace the
      // row object, so a changed reference means a newer frame won: read
      // again rather than apply. Three reads, then the frames stand.
      const reconcile = (readsLeft: number): void => {
        const before = localRow();
        getMessagesAround(channelId, payload.message_id)
          .then((resp) => {
            const row = resp.messages.find((m) => m.id === payload.message_id);
            if (!row) return;
            if (localRow() !== before) {
              if (readsLeft > 1) reconcile(readsLeft - 1);
              return;
            }
            applyServerMessage(row);
          })
          .catch((err) =>
            log.warn("Failed to reconcile a deduplicated send", { error: String(err) }),
          );
      };
      reconcile(3);
    }
  }
}

export function handleReactionUpdate(payload: Payload<"reaction_update">): void {
  const userId = authStore.getState().user?.id ?? 0;
  updateReaction(payload, userId);
  // The who-reacted tooltip caches the reactor list per message+emoji; any
  // add/remove on this message makes those lists stale.
  invalidateReactionUsers(payload.message_id);
}

export function handleTyping(payload: Payload<"typing">): void {
  setTyping(payload.channel_id, payload.user_id);
}

/** Fail every pending optimistic send and reaction once the socket leaves "connected". */
export function failPendingOnDisconnect(state: ConnectionState): void {
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
}

/** A local transport failure for a request id: fail its pending send, else roll back its reaction. */
export function handleSendFailure(id: string, code: string): void {
  if (messagesStore.getState().pendingSends.has(id)) {
    markSendFailed(id, code);
    return;
  }
  rollbackReaction(id);
}

/** The pending-message slice of `ready`: resume this user's queued sends. */
export function activateReadyPendingMessages(
  api: DispatchApi | undefined,
  payload: Payload<"ready">,
): void {
  const pendingUser = authStore.getState().user;
  if (api?.getConfig && pendingUser) {
    activatePendingMessages(
      { host: api.getConfig().host, userId: pendingUser.id },
      pendingUser,
      payload.capabilities?.message_deduplication === true,
      payload.capabilities?.message_retry_floor_ms,
    );
  }
}

/** The message-window slice of `ready`: after a full-ready resync, refetch the active channel. */
export function applyReadyMessageResync(api: DispatchApi | undefined, clock: ReconnectClock): void {
  // A second (or later) `ready` in this dispatcher's lifetime only ever
  // arrives from a full-ready resync (Server/ws/serve.go: a fresh connect
  // and a full resync are the only paths that send `ready` at all — a
  // successful seq-based replay reconnect does not), and that tier never
  // replays missed chat_message frames. Every channel this session had
  // already loaded would otherwise keep a permanent, silent hole in its
  // history — invalidate them and refetch the one actually on screen.
  if (clock.hasReceivedReadyBefore) {
    const activeAfterReady = channelsStore.select((s) => s.activeChannelId);
    const getMessages = api?.getMessages;
    // Only invalidate when the refetch below can actually happen — api is
    // a Partial<...>, so getMessages may be absent, and there may be no
    // resolvable active channel to refetch. A channel marked not loaded with
    // nothing able to reload it would take live broadcasts onto a window
    // that may have a hole in it.
    if (activeAfterReady !== null && getMessages !== undefined) {
      const getMessagesAround = api?.getMessagesAround;
      // P2-T4: every loaded row stays on screen, and the refetch splices into
      // the window. A reader back in history (a detached window) is refetched
      // around the message at the top of the list, so it stays where it is;
      // with no list showing it, the tail is refetched instead.
      const anchor = isWindowDetached(activeAfterReady) ? readingAnchor(activeAfterReady) : null;
      // Mark the active channel loading BEFORE invalidating: it records the
      // watermark the splice checks the page against, and a channel with no
      // rows shows the in-region spinner instead of reading as a genuinely
      // empty channel for the whole refetch (OC-0007).
      setChannelLoading(activeAfterReady);
      invalidateLoadedMessageWindows();
      // OC-0203: the user can switch (or the active channel can be cleared)
      // while the fetch is in flight. Writing the page unconditionally would
      // re-add a channel the user already left to loadedChannels with a
      // pre-resync-era page — MessageController.loadMessages then
      // short-circuits on isChannelLoaded() forever, so the hole this whole
      // resync block exists to close becomes permanent instead. Only the
      // channel still on screen when the response lands may accept it.
      const stillActive = (): boolean =>
        channelsStore.select((s) => s.activeChannelId) === activeAfterReady;
      const refetch: Promise<void> =
        anchor !== null && getMessagesAround !== undefined
          ? getMessagesAround(activeAfterReady, anchor, { limit: 50 }).then((resp) => {
              if (!stillActive()) return;
              setAroundMessages(
                activeAfterReady,
                resp.messages,
                resp.has_more_before,
                resp.has_more_after,
                true,
              );
            })
          : getMessages(activeAfterReady, { limit: 50 }).then((resp) => {
              if (!stillActive()) return;
              setMessages(
                activeAfterReady,
                resp.messages,
                resp.has_more,
                true,
                readingAnchor(activeAfterReady),
              );
            });
      refetch.catch((err: unknown) => {
        log.warn("Failed to reload message history after resync", { error: String(err) });
        // Same staleness guard as above — a rejection for a channel the user
        // already left must not flag it load-errored; that channel's own
        // mount/retry path owns its state now.
        if (!stillActive()) return;
        // An empty channel shows the inline error + Retry (MessageController's
        // loadMessages re-fetches because invalidate cleared "loaded"). Rows
        // still on screen hide that region, so say it with a toast, as the
        // normal load path does; the error detaches them, so "Jump to
        // Present" refetches and no live row lands across the gap.
        setChannelLoadError(activeAfterReady);
        if (getChannelMessages(activeAfterReady).length > 0) {
          showToast(connectText("app.loadHistoryFailed"), "error");
        }
      });
    }
  }
  clock.hasReceivedReadyBefore = true;
}

/**
 * The pending-send and pending-reaction branches of `error`. Returns true when
 * the frame answered one of them and the error chain must stop.
 */
export function handleMessagingError(payload: Payload<"error">, id: string | undefined): boolean {
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
    // OC-0476: a resent pre-restore id the server holds no receipt for is
    // refused as BAD_REQUEST; say the server was restored, keeping the text.
    // The toast lives here, with the connect catalog, to keep MainPage small.
    const { pendingSends, messagesByChannel } = messagesStore.getState();
    const clientMessageId = messagesByChannel
      .get(pendingSends.get(id) ?? 0)
      ?.find((m) => m.correlationId === id)?.clientMessageId;
    const beforeRestore =
      payload.code === "BAD_REQUEST" &&
      clientMessageId !== undefined &&
      pendingMessageBeforeRestore(clientMessageId);
    if (beforeRestore) showToast(connectText("app.sendBeforeRestore"), "error");
    markSendFailed(id, beforeRestore ? "BEFORE_RESTORE" : payload.code);
    return true;
  }
  // A failed optimistic reaction toggle: the pill reverting is the
  // feedback the spec asks for (ux/messaging §5) — no toast on top.
  if (id !== undefined && rollbackReaction(id)) {
    return true;
  }
  return false;
}
