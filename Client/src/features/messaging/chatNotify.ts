// What a live chat message does beyond the store: unread and mention badges, DM previews, and the desktop notification (never for a reconnect's replayed burst).
import { noteChannelMessage } from "../../stores/channels.store";
import { updateDmLastMessage, updateDmLastMessagePreview } from "../../stores/dm.store";
import { blocksStore } from "../../stores/blocks.store";
import { parseTimestamp } from "@lib/text/formatting";
import { notifyIncomingMessage } from "../../lib/notifications";
import { mentionsCurrentUser } from "../../lib/text/mentions";
import { loadedThreadsStore } from "../../stores/threadsLoader";
import { noteAwayUnread } from "@lib/readState";
import "./mentionNameLookups";
import type { Payload, ReconnectClock } from "../connection/dispatchContext";

/**
 * serverClockSkewMs (see createReconnectClock) starts at 0 and is only
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

/**
 * Whether `payload` is one of a reconnect's replayed burst rather than a live
 * message. It is computed before the mention badge, which needs it too.
 */
export function isReplayedFrame(clock: ReconnectClock, payload: Payload<"chat_message">): boolean {
  return (
    clock.lastReconnectHandshakeAt !== null &&
    Date.now() - clock.lastReconnectHandshakeAt < REPLAY_GATE_WINDOW_MS &&
    parseTimestamp(payload.timestamp).getTime() <
      clock.lastReconnectHandshakeAt - clock.serverClockSkewMs
  );
}

/** Whether `payload` raises a mention badge for the current user. */
export function raisesMentionBadge(
  payload: Payload<"chat_message">,
  isReplayFrame: boolean,
): boolean {
  // highlightsCurrentUser (mentions.ts) treats @everyone and @here as one
  // bit, because the wire carries only one: mentions_everyone. But the
  // server's applyMentionCounts (mentions.go) narrows an @here fan-out to
  // readers who had a live connection at send time — a reader with none
  // never got read_states.mention_count bumped for a here-only mention.
  // The reconnect tier that delivers this replay burst never follows up
  // with a `ready` to correct a wrongly-raised badge, so a
  // here-only mention landing inside that burst must not raise one here
  // either. A direct mention, or an @here/@everyone frame delivered live,
  // is unaffected — mentions_here is only ever set alongside
  // mentions_everyone for an @here (never a plain @everyone) token.
  // A blocked author never raises one: the server leaves blockers out of its
  // mention counts, so the badge here must agree with the next `ready`.
  return (
    !blocksStore.getState().blockedByMe.has(payload.user.id) &&
    (mentionsCurrentUser(payload.content, {
      mentions: payload.mentions,
      mentionRoles: payload.mention_roles,
    }) ||
      (payload.mentions_everyone === true && !(payload.mentions_here === true && isReplayFrame)))
  );
}

/**
 * Increment channel-level unread for non-active, non-own-message
 * channels — OR for the active channel when its loaded window is
 * detached from the live tail. "Active" normally means "the
 * user is watching the live tail", which is why it is otherwise
 * excluded here, but a jump to an old permalink/reply/search hit can
 * leave the active channel showing a detached around-window
 * (messages.store's detachedChannels) — addMessage already refuses to
 * append a live broadcast onto that window, so without this a message
 * (an @mention included) that arrives while the user reads
 * back-history leaves no row AND no badge, with nothing to tell them
 * it ever arrived. Replayed frames increment unread counts like live
 * ones — the burst is exactly the messages missed while away (a
 * full-ready resume sends no burst at all; ready's unread_count values
 * are authoritative there). DM channel IDs are not in channelsStore
 * (they use dmStore), so noteChannelMessage is a no-op for DMs, but the
 * own-message guard is applied here for defence-in-depth.
 */
export function noteChannelUnread(
  payload: Payload<"chat_message">,
  activeId: number | null,
  isOwnMessage: boolean,
  isMention: boolean,
  isAway: boolean,
): void {
  if ((payload.channel_id === activeId && !isAway) || isOwnMessage) return;
  // noteChannelMessage skips the active channel by default —
  // evenIfActive (isAway here) is a no-op for a genuinely
  // non-active channel, since its internal guard only fires when
  // channelId IS the active one. It also guards both counters behind
  // payload.id vs. the channel's lastMessageId watermark, so
  // a message already reflected in a `ready` snapshot (delivered
  // between the server's registerNow and buildReady, then redelivered
  // as a queued chat_message) does not double-count.
  noteChannelMessage(payload.channel_id, payload.id, isMention, isAway);
  // Counted unread in the channel on screen: the reader was away, so after a
  // Mark Unread a later live arrival may release the hold (readState.ts).
  if (isAway && payload.channel_id === activeId) noteAwayUnread(payload.channel_id);
}

/**
 * Update the DM store's last message when the message belongs to a DM channel.
 * Skip unread increment for own messages and the currently focused DM
 * — unless that DM's window is detached from the live tail,
 * the same exception the channel-level increment makes.
 */
export function noteDmMessage(
  payload: Payload<"chat_message">,
  activeId: number | null,
  isOwnMessage: boolean,
  isMention: boolean,
  isAway: boolean,
): void {
  const isDmActive = payload.channel_id === activeId && !isAway;
  if (isOwnMessage || isDmActive) {
    // Update last message preview but don't increment unread count.
    updateDmLastMessagePreview(payload.channel_id, payload.id, payload.content, payload.timestamp);
    return;
  }
  // The DM badge reads dmStore's mentionCount (mute-immune, rendered
  // by DmSidebar) — noteChannelMessage above no-ops for DM ids, which
  // are absent from channelsStore. isMention is passed through so the
  // mention bump sits behind updateDmLastMessage's own message-id
  // guard — a separate unconditional increment here would
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

/**
 * Fire desktop notification, taskbar flash, and sound — but not for a
 * reconnect's replayed burst. No connection-state flag can gate this:
 * the server writes auth_ok before the burst, so by the time replayed
 * frames arrive the client is already "connected". A replay frame's
 * timestamp instead predates the reconnect handshake that preceded it,
 * unlike a genuinely new live message — compared in server-clock terms
 * (see serverClockSkewMs above) so a lagging or skewed server clock
 * cannot make a live message look like a replay.
 * The wall-clock window additionally bounds a cold (never-sampled)
 * skew's damage — see REPLAY_GATE_WINDOW_MS.
 */
export function notifyLiveMessage(clock: ReconnectClock, payload: Payload<"chat_message">): void {
  // A reply in a thread is judged by its parent channel: the parent's mute and
  // notification level apply, its name labels the popup, and a thread the
  // reader is watching beside the active channel is not worth a chime.
  const surface =
    loadedThreadsStore()?.authorityChannelId(payload.channel_id) ?? payload.channel_id;
  notifyIncomingMessage(
    surface === payload.channel_id ? payload : { ...payload, channel_id: surface },
  );
  // Refresh the skew estimate from this accepted-as-live frame so it
  // stays current for the next reconnect.
  clock.serverClockSkewMs = Date.now() - parseTimestamp(payload.timestamp).getTime();
}
