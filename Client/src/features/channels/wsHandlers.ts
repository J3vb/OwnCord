// Channel, role, member, presence and emoji WebSocket handlers — extracted
// from lib/dispatcher.ts, which keeps every socket subscription and calls
// these plain functions.
import { authStore, setAuth } from "../../stores/auth.store";
import {
  channelsStore,
  setChannels,
  setRoles,
  setCategories,
  setActiveChannel,
  removeChannel,
  addChannel,
  updateChannel,
  setMentionCount,
  setNsfwAcknowledged,
  noteChannelMessage,
} from "../../stores/channels.store";
import {
  setMembers,
  addMember,
  removeMember,
  updateMemberRole,
  updateMemberProfile,
  updatePresence,
  applyPresenceBatch,
  applyReadyActivities,
  applyReadyListening,
  membersStore,
  toMemberActivity,
  toMemberListening,
} from "../../stores/members.store";
import { updateVoiceUserProfile } from "../../stores/voice.store";
import {
  dmStore,
  setDmActivityLookup,
  setDmListeningLookup,
  updateDmParticipant,
  type DmUser,
} from "../../stores/dm.store";
import { emojiStore, setCustomEmoji } from "../../stores/emoji.store";
import { setStickers, stickersStore } from "../../stores/stickers.store";
import { uiStore } from "../../stores/ui.store";
import { getChannelMessages, markStickersDeleted } from "../../stores/messages.store";
import {
  isTextLikeChannel,
  type ChannelActivityEntry,
  type ReadyActivity,
  type ReadyListening,
} from "../../lib/types";
import { loadLastChannel } from "../../lib/prefs/lastChannel";
import {
  acceptReadState,
  failMarkUnread,
  forgetPendingMarkUnread,
  isChannelAway,
  isHeldUnread,
  markChannelRead,
  markChannelReadSeen,
  writeReadPointer,
} from "../../lib/read-state";
import {
  applyGameActivityPolicy,
  applyReadyCapabilities,
  gameActivityPolicyIsOff,
  hasReceivedReady,
  readPointerEnabled,
  stickersEnabled,
} from "../../lib/serverCapabilities";
import { showToast } from "../../lib/toast";
import {
  notifyChannelActivity,
  notifyMention,
  type ThreadNotifyContext,
} from "../../lib/notifications";
import {
  loadedThreadsStore,
  threadsStoreInUse,
  withThreadsStore,
} from "../../stores/threadsLoader";
import type { DispatchApi, Payload } from "../connection/dispatchContext";
import { log } from "../connection/dispatchContext";
import { connectText } from "../../i18n/connect";
import { registerSessionReset } from "../../lib/sessionRegistry";
import { WsErrorCode } from "@lib/protocolTypes";

/** The channel/role/member snapshot of `ready`. */
export function applyReadyChannels(payload: Payload<"ready">): void {
  setChannels(payload.channels);
  // Managers only; absent for everyone else and for older servers, which leaves
  // the list empty so the groups come from the channels alone.
  setCategories(payload.categories ?? []);
  setRoles(payload.roles ?? []);
  setMembers(payload.members);
}

/** The first text-like channel in sidebar order (D7): uncategorized rows
 *  first, then categories by (category_position, category_id), each by
 *  (position, id). An older server without category ids sorts by position. */
type ReadyChannel = Payload<"ready">["channels"][number];

function sidebarSortKey(ch: ReadyChannel): number[] {
  const cat = ch.category_id ?? 0;
  return cat === 0
    ? [0, 0, 0, ch.position, ch.id]
    : [1, ch.category_position ?? 0, cat, ch.position, ch.id];
}

function sortsBefore(a: number[], b: number[]): boolean {
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x < y;
  }
  return false;
}

function firstTextInSidebarOrder(channels: Payload<"ready">["channels"]): ReadyChannel | undefined {
  let best: ReadyChannel | undefined;
  let bestKey: number[] = [];
  for (const ch of channels) {
    if (!isTextLikeChannel(ch)) continue;
    const k = sidebarSortKey(ch);
    if (best === undefined || sortsBefore(k, bestKey)) {
      best = ch;
      bestKey = k;
    }
  }
  return best;
}

/**
 * The active-channel slice of `ready`: auto-select, or clear a channel that is
 * gone. Returns the channel markReadyActiveChannelRead should mark read.
 */
export function applyReadyActiveChannel(payload: Payload<"ready">): number | null {
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
  // A content view leaves no channel active on purpose; auto-selecting
  // one would close it.
  const viewOpen = uiStore.getState().activeView !== null;
  if (currentActive === null && !viewOpen && payload.channels.length > 0) {
    // Restore where the user left off rather than always jumping to the
    // first text channel. The stored id is a hint — ignore it when the channel
    // is gone or no longer visible. Selecting is not viewing, so neither this
    // nor the fallback clears the badge (clearUnread: false); the channel
    // clears only when actually mounted.
    const remembered = loadLastChannel();
    const rememberedVisible =
      remembered !== null && payload.channels.some((ch) => ch.id === remembered);
    if (rememberedVisible) {
      setActiveChannel(remembered, { clearUnread: false });
    } else {
      const firstText = firstTextInSidebarOrder(payload.channels);
      if (firstText !== undefined) {
        setActiveChannel(firstText.id, { clearUnread: false });
      }
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
  return activeChannelCleared ? null : currentActive;
}

/**
 * Mark the channel the user was already reading as read after `ready`.
 *
 * The server's read_states go stale while a channel stays focused
 * (channel_focus is sent once per mount, mark_read only from the context
 * menu), so a full-ready resync restates non-zero unread/mention counts for
 * the very channel the user is reading. Mark it read: this advances the
 * server read state and clears the local badges, for server channels and DMs
 * alike. Skipped on first connect (nothing was active yet) and when
 * applyReadyActiveChannel just cleared a channel that's gone — it returns
 * null for both.
 *
 * Only while the reader is actually watching — a focused window whose
 * loaded window is not detached. An unfocused or background resync restates
 * the messages missed while away, and clearing them here would silently mark
 * those unseen messages read (isChannelAway, lib/read-state.ts).
 */
export function markReadyActiveChannelRead(currentActive: number | null): void {
  // A forum holds no messages, so there is nothing in it to mark read.
  if (
    currentActive !== null &&
    channelsStore.getState().channels.get(currentActive)?.type === "forum"
  ) {
    return;
  }
  if (currentActive !== null && !isChannelAway(currentActive)) {
    // With a read pointer the ready-time mark is only what the reader saw, not
    // "everything": a resync that restated messages missed while the list was
    // not on screen must not mark them read. Without one, as it always was.
    if (readPointerEnabled()) markChannelReadSeen(currentActive);
    else markChannelRead(currentActive);
  }
}

/**
 * The capabilities slice of a full `ready`, applied first. A new `ready`
 * restates every pointer, so a Mark Unread still waiting for its answer from
 * the previous connection is forgotten rather than restored or toasted against
 * the new one.
 */
export function applyReadyReadPointer(payload: Payload<"ready">): void {
  applyReadyCapabilities(payload.capabilities);
  forgetPendingMarkUnread();
}

/**
 * read_state: the server moved this user's read pointer in a channel or DM and
 * says where it is now. It replaces the pointer, unread_count and mention_count
 * outright — and a channel or DM this client does not list is ignored, as is
 * anything before the first ready. The one exception to "outright" is the
 * channel the reader is watching: its badge stays at zero (as handleMentionCount
 * keeps it), because the reader is looking at it; the pointer is still stored.
 * The NEW line already in view does not move, as it follows the pointer the
 * channel was opened with.
 */
export function handleReadState(payload: Payload<"read_state">): void {
  if (!hasReceivedReady()) return;
  const id = payload.channel_id;
  const ch = channelsStore.getState().channels.get(id);
  if (ch === undefined && !dmStore.getState().channels.some((c) => c.channelId === id)) {
    // A followed thread's pointer moved (another device read it).
    if (threadsStoreInUse()) {
      withThreadsStore((m) =>
        m.applyFollowedReadState(id, {
          lastReadId: payload.last_read_message_id,
          unread: payload.unread_count,
          mentions: payload.mention_count,
        }),
      );
    }
    return;
  }
  if (!acceptReadState(id, payload.last_read_message_id)) return;
  // Not a channel just marked unread: that one keeps its counts, or the click
  // would leave no badge once the reader leaves.
  const watching =
    channelsStore.getState().activeChannelId === id && !isChannelAway(id) && !isHeldUnread(id);
  writeReadPointer(
    id,
    payload.last_read_message_id,
    watching
      ? { unread: 0, mention: 0 }
      : { unread: payload.unread_count, mention: payload.mention_count },
  );
}

/**
 * An error reply to a `mark_unread` the client sent. RATE_LIMITED and
 * NOT_FOUND say the click did nothing: tell the user, and put the pointer back
 * to where it was. Correlated by the frame id the server echoes, so an error
 * for any other frame, or for a request a new connection has replaced, is left
 * alone. Returns true when it consumed the frame.
 */
export function handleMarkUnreadError(payload: Payload<"error">, id: string | undefined): boolean {
  // Any refusal of this frame ends the request; only two have copy of their own.
  const notice =
    payload.code === WsErrorCode.RATE_LIMITED
      ? "rateLimited"
      : payload.code === WsErrorCode.NOT_FOUND
        ? "notFound"
        : "failed";
  return failMarkUnread(id, notice);
}

/** The custom-emoji slice of `ready`. */
export function applyReadyEmoji(api: DispatchApi | undefined): void {
  // Custom emoji are not in the ready payload (they are server-wide and
  // change rarely, so they do not belong in the per-session dump). Load
  // them once here; `emoji_update` keeps them fresh from then on. A
  // failure is non-fatal — unresolved shortcodes stay plain text.
  //
  // Snapshot the revision emojiStore was at right before issuing
  // this fetch, mirroring the blockedByMeRev guard above. The GET
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
}

/**
 * The custom-sticker slice of `ready`. Like emoji, the set is not in
 * the ready payload: load it once here, only on a server that advertises the
 * `stickers` capability (applyReadyCapabilities has already run), and let
 * `sticker_update` keep it fresh. A failure is non-fatal: the picker shows its
 * empty state until the next broadcast.
 *
 * The revision snapshot mirrors the emoji one: a `sticker_update` that lands
 * while this GET is in flight bumps it, and the stale reply is then dropped.
 */
export function applyReadyStickers(api: DispatchApi | undefined): void {
  if (!stickersEnabled() || api?.listStickers === undefined) return;
  const revAtFetch = stickersStore.getState().rev;
  api
    .listStickers()
    .then((list) => setStickers(list, revAtFetch))
    .catch((err) => log.warn("Failed to load custom stickers", { error: String(err) }));
}

/**
 * `ready.activities` and `ready.listening`: who plays what
 * and who listens to what right now. Applied after the roster and the DM list
 * are in, so it reaches both copies; a server without the key sends none, and
 * the members then play and listen to nothing.
 */
export function applyReadyGameActivities(payload: Payload<"ready">): void {
  applyGameActivityList(payload.activities ?? [], payload.listening ?? []);
}

/**
 * `game_activity_policy`: an admin turned game activity on or off.
 * The capability follows at once. Off also clears every shown game, so none
 * lingers if a clearing `presence` frame is dropped; on restates nothing,
 * since the games return with presence.
 */
export function handleGameActivityPolicy(payload: Payload<"game_activity_policy">): void {
  if (applyGameActivityPolicy(payload.enabled) && !payload.enabled) applyGameActivityList([], []);
}

/**
 * `auth_ok.game_activity_policy`: the same switch on every connect and resume.
 * A resume gets no `ready` and may have missed the frame while offline. An
 * older server states none, and the `ready` capability decides.
 */
export function applyAuthOkGameActivityPolicy(payload: Payload<"auth_ok">): void {
  if (payload.game_activity_policy !== undefined) {
    handleGameActivityPolicy(payload.game_activity_policy);
  }
}

/**
 * Who plays what, restated from `list`: the roster and the DM copies of it
 * both follow, and a DM opened from now on takes its people's games from the
 * members store.
 */
function applyGameActivityList(
  list: readonly ReadyActivity[],
  songs: readonly ReadyListening[],
): void {
  applyReadyActivities(list);
  applyReadyListening(songs);
  setDmActivityLookup((userId) => membersStore.getState().members.get(userId)?.activity);
  setDmListeningLookup((userId) => membersStore.getState().members.get(userId)?.listening);
  const byUser = new Map(list.map((a) => [a.user_id, toMemberActivity(a)]));
  const songByUser = new Map(songs.map((l) => [l.user_id, toMemberListening(l)]));
  const partners = new Set<number>();
  for (const c of dmStore.getState().channels) {
    partners.add(c.recipient.id);
    for (const p of c.participants) partners.add(p.id);
  }
  for (const id of partners) {
    updateDmParticipant(id, {
      activity: byUser.get(id) ?? null,
      listening: songByUser.get(id) ?? null,
    });
  }
}

export function handlePresence(payload: Payload<"presence">): void {
  // custom_status is passed through verbatim, undefined included: the
  // store treats "field absent" as "leave the text alone", which is what
  // an older server's presence event means.
  // activity follows the same rule: absent leaves the shown game alone.
  // While the server states game activity is off, a game on a frame that
  // outran the off frame is not shown.
  const off = gameActivityPolicyIsOff();
  const activity = off ? null : payload.activity;
  // The same switch covers the song.
  const listening = off ? null : payload.listening;
  updatePresence(
    payload.user_id,
    payload.status,
    payload.custom_status,
    undefined,
    activity,
    listening,
  );
  // dmStore keeps its own frozen copy of a DM partner's status for the
  // sidebar row (see buildDmConversations) — membersStore alone does not
  // reach it.
  updateDmParticipant(payload.user_id, {
    status: payload.status,
    ...(activity === undefined ? {} : { activity: toMemberActivity(activity) }),
    ...(listening === undefined ? {} : { listening: toMemberListening(listening) }),
  });
}

export function handlePresenceBatch(payload: Payload<"presence_batch">): void {
  const full = payload.full === true;
  // As in handlePresence: no game is shown while the server states it is off.
  const off = gameActivityPolicyIsOff();
  const updates = off
    ? payload.updates.map((u) => ({ ...u, activity: null, listening: null }))
    : payload.updates;
  applyPresenceBatch(updates, full);
  // Only DM partners need the dmStore copy (see handlePresence); a full
  // snapshot takes a partner it leaves out offline.
  const statuses = new Map(updates.map((u) => [u.user_id, u.status]));
  const activities = new Map(updates.map((u) => [u.user_id, u.activity]));
  const songs = new Map(updates.map((u) => [u.user_id, u.listening]));
  const partners = new Set<number>();
  for (const c of dmStore.getState().channels) {
    partners.add(c.recipient.id);
    for (const p of c.participants) partners.add(p.id);
  }
  for (const id of partners) {
    const listed = statuses.has(id);
    const status = statuses.get(id) ?? (full ? "offline" : undefined);
    if (status === undefined) continue;
    const activity = activities.get(id);
    const song = songs.get(id);
    // A partner the snapshot leaves out plays and listens to nothing; an entry
    // without the field (an older server) leaves what is shown alone.
    const patch: Partial<DmUser> = { status };
    if (!listed) {
      updateDmParticipant(id, { ...patch, activity: null, listening: null });
      continue;
    }
    updateDmParticipant(id, {
      ...patch,
      ...(activity === undefined ? {} : { activity: toMemberActivity(activity) }),
      ...(song === undefined ? {} : { listening: toMemberListening(song) }),
    });
  }
}

export function handleChannelCreate(payload: Payload<"channel_create">): void {
  addChannel(payload);
}

export function handleChannelUpdate(payload: Payload<"channel_update">): void {
  updateChannel(payload);
}

/** The manager's category list changed: replace what we hold. */
export function handleChannelCategories(payload: Payload<"channel_categories">): void {
  setCategories(payload.categories);
}

/** Another device of this account acknowledged or revoked a labelled channel. */
export function handleNsfwAck(payload: Payload<"nsfw_ack">): void {
  setNsfwAcknowledged(payload.channel_id, payload.acknowledged);
}

/**
 * A mention changed this user's badge in a channel. The server pushes
 * the reader's new total per user, raising it when a mention lands and lowering
 * it when a delete or purge reverses one; the channel is typically one this
 * client is not viewing, whose chat_message broadcast never arrives. The frame
 * is the only way such a change reaches the sidebar/taskbar badge live.
 *
 * Ignored for the active channel while the reader is present: a mention in the
 * channel on screen is already handled by its own chat_message (and, when that
 * window is detached from the live tail, counted there with the evenIfActive
 * escape hatch). Applying the server total here would paint a red badge on the
 * channel the user is reading — the badge the active-channel skip in
 * noteChannelMessage exists to prevent. While the reader is away (unfocused,
 * detached) the frame may only lower the badge, never raise it: raises still
 * come from the channel's own chat_message, so applying them would double
 * count, but a delete or purge that reverses a mention must reach the badge.
 * The frame carries an absolute total, not a delta, so a channel the reader
 * watched focused and then left would over-count mentions already seen; while
 * away, its own chat_message keeps counting live mentions. Ignored for a
 * DM-channel id too: a DM's badge lives in dmStore and its mention bump rides
 * the DM's own chat_message.
 *
 * For any other channel a raised total also fires notifyMention: nothing else
 * tells the reader, since chat_message only reaches the focused channel.
 */
export function handleMentionCount(payload: Payload<"mention_count">): void {
  const ch = channelsStore.getState().channels.get(payload.channel_id);
  if (ch === undefined) {
    if (threadsStoreInUse()) withThreadsStore((m) => handleThreadMentionCount(m, payload));
    return;
  }
  if (ch.type === "dm") return;
  if (payload.channel_id === channelsStore.getState().activeChannelId) {
    if (!isChannelAway(payload.channel_id)) return;
    setMentionCount(payload.channel_id, Math.min(ch.mentionCount, payload.count));
    return;
  }
  const previous = ch.mentionCount;
  setMentionCount(payload.channel_id, payload.count);
  // A raised total on a channel the reader is not viewing is a new mention that
  // no chat_message announced, so alert for it. A lowered or
  // unchanged total (delete, purge, repeat frame) is not a new mention. The
  // active channel never alerts here: its own chat_message already does.
  // A channel_activity entry for the mention alerts with the author and the
  // message instead, so this alert waits a moment for one.
  // A lowered total takes back the rises it reverses, pending alerts included.
  if (payload.count > previous) deferMentionAlert(payload.channel_id, payload.count - previous);
  else if (payload.count < previous)
    withdrawMentionAlert(payload.channel_id, previous - payload.count);
}

/** A followed thread's mention_count: the total repaints its row, a rise alerts like a channel's. */
function handleThreadMentionCount(
  m: NonNullable<ReturnType<typeof loadedThreadsStore>>,
  payload: Payload<"mention_count">,
): void {
  const previous = m.setFollowedMentions(payload.channel_id, payload.count);
  if (previous === undefined) return;
  if (payload.count > previous) deferMentionAlert(payload.channel_id, payload.count - previous);
  else if (payload.count < previous)
    withdrawMentionAlert(payload.channel_id, previous - payload.count);
}

/** Who an alert for `id` is for when `id` is a followed thread: its parent, name and whether it is open. */
function threadNotifyContext(id: number): ThreadNotifyContext | undefined {
  const m = loadedThreadsStore();
  const t = m?.getThread(id);
  if (m === null || t === undefined) return undefined;
  return {
    parentId: t.parent_id,
    name: t.name,
    watching: m.threadsStore.getState().focusedThreadId === id,
  };
}

/**
 * How long a mention_count alert waits for a channel_activity entry that
 * carries the mention, and how long a mention entry that came first waits for
 * its rise. The server flushes activity on a 1 s window and
 * resolves a flush within 2 s.
 */
export const MENTION_ALERT_GRACE_MS = 3000;

/** A channel's mention_count rises still waiting for an activity entry. */
interface PendingMentionAlert {
  readonly timer: ReturnType<typeof setTimeout>;
  /** Rises not yet matched by a mention entry. */
  owed: number;
}

const pendingMentionAlerts = new Map<number, PendingMentionAlert>();
/** Mention entries that arrived before their rise, with when, by channel. */
const activityCredits = new Map<number, number[]>();

/** Unexpired credits for `channelId`, oldest first. */
function liveCredits(channelId: number): number[] {
  const now = Date.now();
  const live = (activityCredits.get(channelId) ?? []).filter(
    (at) => now - at < MENTION_ALERT_GRACE_MS,
  );
  if (live.length === 0) activityCredits.delete(channelId);
  else activityCredits.set(channelId, live);
  return live;
}

/**
 * Alert for `rises` mention_count rises unless channel_activity announces
 * them. Each mention entry matches one rise, before or after it, so a second
 * mention whose entry never came (the server keeps only a window's newest
 * mentions, a dropped frame, a server without the frame) still alerts, one
 * grace window late.
 */
function deferMentionAlert(channelId: number, rises: number): void {
  const credits = liveCredits(channelId);
  const used = Math.min(credits.length, rises);
  if (used > 0) {
    credits.splice(0, used);
    if (credits.length === 0) activityCredits.delete(channelId);
  }
  const owed = rises - used;
  if (owed === 0) return;
  const pending = pendingMentionAlerts.get(channelId);
  if (pending !== undefined) {
    pending.owed += owed;
    return;
  }
  pendingMentionAlerts.set(channelId, {
    owed,
    timer: setTimeout(() => {
      pendingMentionAlerts.delete(channelId);
      const thread = threadNotifyContext(channelId);
      if (thread === undefined) notifyMention(channelId);
      else notifyMention(channelId, thread);
    }, MENTION_ALERT_GRACE_MS),
  });
}

/** Take back `count` rises a lowered total reversed (a delete or purge). */
function withdrawMentionAlert(channelId: number, count: number): void {
  const pending = pendingMentionAlerts.get(channelId);
  if (pending === undefined) return;
  pending.owed -= count;
  if (pending.owed <= 0) {
    clearTimeout(pending.timer);
    pendingMentionAlerts.delete(channelId);
  }
}

/** A mention entry alerted: it answers one pending rise, or one still to come. */
function matchMentionEntry(channelId: number): void {
  const pending = pendingMentionAlerts.get(channelId);
  if (pending === undefined) {
    activityCredits.set(channelId, [...liveCredits(channelId), Date.now()]);
    return;
  }
  pending.owed--;
  if (pending.owed <= 0) {
    clearTimeout(pending.timer);
    pendingMentionAlerts.delete(channelId);
  }
}

/** Drop pending mention alerts and what they were matched against. Run when
 *  the dispatcher is torn down. */
export function resetChannelActivity(): void {
  for (const pending of pendingMentionAlerts.values()) clearTimeout(pending.timer);
  pendingMentionAlerts.clear();
  activityCredits.clear();
}
// Mention alerts are keyed by this server's channel ids and fire on a timer;
// a server switch must not let one fire for the next server.
void registerSessionReset("channels:activity", resetChannelActivity, { phase: "cache" }); // app-lifetime

/** The newest confirmed message loaded for a channel; a pending send has id 0. */
function newestLoadedId(channelId: number): number {
  const rows = getChannelMessages(channelId);
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i]!.id > 0) return rows[i]!.id;
  }
  return 0;
}

/**
 * channel_activity: new messages in readable channels the reader is
 * not viewing, so their unread dot shows without waiting for the next `ready`.
 * Each entry bumps unread through noteChannelMessage, whose id watermark keeps
 * a message `ready` already counted from counting again. The mention flags are
 * never passed as a mention: mention_count owns the badge total. The active
 * channel is skipped (its own chat_message reaches it), and so are unknown
 * channels and DM ids. A message at or below the watermark, or below the
 * newest message already loaded for the channel (one the reader just read
 * there), neither counts nor alerts.
 *
 * An entry that carries a mention alerts with its author and message, so it
 * stands in for one of that channel's mention_count rises.
 */
export function handleChannelActivity(payload: Payload<"channel_activity">): void {
  const activeId = channelsStore.getState().activeChannelId;
  for (const entry of payload.channels) {
    if (entry.channel_id === activeId) continue;
    const ch = channelsStore.getState().channels.get(entry.channel_id);
    if (ch === undefined) {
      // Not a channel: a followed thread's hint (the server sends them to
      // followers only), or a DM's, which the thread store ignores.
      if (threadsStoreInUse()) withThreadsStore((m) => handleThreadActivity(m, entry));
      continue;
    }
    if (ch.type === "dm") continue;
    if (ch.lastMessageId !== null && entry.message_id <= ch.lastMessageId) continue;
    if (entry.message_id <= newestLoadedId(entry.channel_id)) continue;
    noteChannelMessage(entry.channel_id, entry.message_id, false);
    if (entry.mentions_you || entry.mentions_everyone) matchMentionEntry(entry.channel_id);
    notifyChannelActivity(entry);
  }
}

/** A followed thread's activity entry: counted on its row, then announced as its parent would. */
function handleThreadActivity(
  m: NonNullable<ReturnType<typeof loadedThreadsStore>>,
  entry: ChannelActivityEntry,
): void {
  if (!m.noteFollowedActivity(entry.channel_id, entry.message_id)) return;
  if (entry.mentions_you || entry.mentions_everyone) matchMentionEntry(entry.channel_id);
  notifyChannelActivity(entry, threadNotifyContext(entry.channel_id));
}

export function handleChannelDelete(payload: Payload<"channel_delete">): void {
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
    showToast(connectText("app.channelDeleted"), "info");
    log.info("Active channel deleted, redirected", { deletedId: payload.id });
  }
}

export function handleMemberJoin(payload: Payload<"member_join">): void {
  log.info("Member joined", { userId: payload.user.id, username: payload.user.username });
  addMember(payload);
}

export function handleMemberBan(payload: Payload<"member_ban">): void {
  log.info("Member banned", { userId: payload.user_id });
  removeMember(payload.user_id);
}

export function handleMemberUpdate(payload: Payload<"member_update">): void {
  log.info("Member role updated", { userId: payload.user_id, role: payload.role });
  updateMemberRole(payload.user_id, payload.role, payload.role_ids);

  // Keep authStore in sync when the signed-in user's own role changed —
  // every permission gate (canManageChannels, canViewAuditLog, ...) reads
  // authStore.user.role, not membersStore, so without this a promotion or
  // demotion of the current user would leave every affordance stale until
  // the socket reconnects (mirrors the USER_UPDATE self-branch below).
  const me = authStore.getState().user;
  if (me && payload.user_id === me.id) {
    // role_ids rides along so the held-role gates follow the echo too.
    // An absent list drops the old one, as updateMemberRole does.
    const { role_ids: _old, ...withoutIds } = me;
    authStore.setState((prev) => ({
      ...prev,
      user: {
        ...withoutIds,
        role: payload.role,
        ...(payload.role_ids === undefined ? {} : { role_ids: payload.role_ids }),
      },
    }));
  }
}

// Roles changed server-side (created, edited, deleted or reordered). The
// payload is the whole list, so the store is replaced rather than patched —
// name colors, the member-list groups and every permission-gated affordance
// re-derive from it without a reconnect.
export function handleRolesUpdate(payload: Payload<"roles_update">): void {
  log.info("Roles updated", { count: payload.roles?.length ?? 0 });
  setRoles(payload.roles ?? []);
}

// Custom emoji changed server-side (uploaded or deleted). Whole set, like
// roles_update: the store is replaced so a deleted emoji stops rendering in
// messages, pickers and reaction pills without a reconnect.
export function handleEmojiUpdate(payload: Payload<"emoji_update">): void {
  log.info("Custom emoji updated", { count: payload.emoji?.length ?? 0 });
  setCustomEmoji(payload.emoji ?? []);
}

// Custom stickers changed server-side (uploaded, renamed or deleted). Whole
// set, like emoji_update: a sticker deleted while a picker is open drops out of
// its grid, and a stale id can no longer be sent from the next open.
export function handleStickerUpdate(payload: Payload<"sticker_update">): void {
  log.info("Custom stickers updated", { count: payload.stickers?.length ?? 0 });
  const stickers = payload.stickers ?? [];
  setStickers(stickers);
  // Messages already on screen still name the removed sticker: turn them into
  // "Deleted sticker" rows (never fetching the image again).
  markStickersDeleted(new Set(stickers.map((s) => s.id)));
}

export function handleUserUpdate(payload: Payload<"user_update">): void {
  log.info("User profile updated", { userId: payload.user_id, username: payload.username });
  updateMemberProfile(payload.user_id, {
    username: payload.username,
    avatar: payload.avatar,
    displayName: payload.display_name,
    identityPublicKey: payload.identity_public_key,
    about: payload.about,
    banner: payload.banner,
    banner_color: payload.banner_color,
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
        // Absent (an older server) keeps the stored banner; null clears it.
        ...(payload.banner === undefined ? {} : { banner: payload.banner }),
        ...(payload.banner_color === undefined ? {} : { banner_color: payload.banner_color }),
      },
      authStore.getState().serverName ?? "",
      authStore.getState().motd ?? "",
    );
  }
}
