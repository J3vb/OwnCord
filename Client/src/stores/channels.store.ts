/**
 * Channels store — holds channel list, active channel, and unread counts.
 * Immutable state updates only.
 */

import { createStore } from "@lib/store";
import { registerSessionReset } from "@lib/sessionRegistry";
import { registerRoleIdLookup } from "@lib/roleLookup";
import { connectText } from "../i18n/connect";
import type {
  ReadyChannel,
  ReadyRole,
  ChannelCreatePayload,
  ChannelUpdatePayload,
  ChannelType,
  ChannelCategory,
  ForumSettings,
} from "@lib/types";

export interface Channel {
  readonly id: number;
  readonly name: string;
  readonly type: ChannelType;
  readonly category: string | null;
  /**
   * The id of the category the channel sits under, 0 when none.
   * Absent or 0 on an older server, which groups by `category` (the name).
   */
  readonly categoryId?: number | undefined;
  /** The category's place in the category order (0 when none or unknown). */
  readonly categoryPosition?: number | undefined;
  /** Channel topic ("" = none). */
  readonly topic: string;
  readonly position: number;
  readonly unreadCount: number;
  /**
   * Unread messages here that mention the current user (directly or via
   * @everyone/@here). Not capped like unreadCount, so it can exceed it; drives
   * the red mention badge, which outranks the plain unread badge.
   */
  readonly mentionCount: number;
  readonly lastMessageId: number | null;
  /**
   * The current user's read pointer: the last message they have read here
   * (0 = nothing). Undefined when the server never said (an older server), in
   * which case the NEW line stays count-based.
   */
  readonly lastReadMessageId?: number | undefined;
  /** Whether the current user may post here (drives the composer affordance). */
  readonly canSend: boolean;
  /**
   * Whether the current user may mute, deafen, move or disconnect voice
   * participants here, as the server computed it (ReadyChannel.can_moderate_voice).
   * Absent when the server never said, which offers no voice moderation.
   */
  readonly canModerateVoice?: boolean | undefined;
  /**
   * Whether the current user may move voice participants here at any rank
   * (ReadyChannel.can_move_voice, MOVE_MEMBERS). Independent of
   * canModerateVoice. Absent when the server never said.
   */
  readonly canMoveVoice?: boolean | undefined;
  /**
   * Whether the current user may delete others' messages / pin / react here,
   * as the server computed it. Undefined when the server never said (older
   * server): callers fall back to the role's MANAGE_MESSAGES for the first two
   * and to true for react — never to false.
   */
  readonly canDeleteOthers?: boolean | undefined;
  readonly canPin?: boolean | undefined;
  readonly canReact?: boolean | undefined;
  /** Per-channel cooldown in seconds (0 = off). Drives the composer countdown. */
  readonly slowMode: number;
  /**
   * Labelled age-restricted. The server withholds the channel's content from
   * anyone who has not acknowledged it; this client shows a consent
   * gate instead of the channel and marks the sidebar row.
   */
  readonly nsfw: boolean;
  /**
   * Hidden from @everyone by a permission override, visible to this viewer.
   * Marks the sidebar row with a lock. Older servers never send it: false.
   */
  readonly isPrivate: boolean;
  /**
   * The current account's own acknowledgement of the label, as the server
   * last confirmed it (ready, a 204 from the acknowledgement route, or
   * nsfw_ack). Absent or false means content stays gated; it is only ever
   * true while `nsfw` is, because the server drops acknowledgements when the
   * label is cleared.
   */
  readonly nsfwAcknowledged?: boolean;
  /**
   * Voice capacity limits (0 = unlimited). The server enforces both on join
   * (CHANNEL_FULL / VIDEO_LIMIT); these copies exist so the sidebar can show
   * "3/5" and the client never has to guess why a join was refused.
   */
  readonly voiceMaxUsers: number;
  readonly voiceMaxVideo: number;
  /**
   * The server's AFK voice channel: idle members are moved here and it is
   * listen-only. Absent from older servers, which is read as false.
   */
  readonly afk?: boolean | undefined;
  /** A forum's tags and settings; absent on every other type. */
  readonly forum?: ForumSettings | undefined;
}

export interface ChannelsState {
  readonly channels: ReadonlyMap<number, Channel>;
  readonly activeChannelId: number | null;
  readonly roles: readonly ReadyRole[];
  /**
   * The full category list, ordered by (position, id). Only a viewer holding
   * MANAGE_CHANNELS is ever sent it (ready.categories and the
   * channel_categories event, written through the dispatcher); for everyone
   * else it stays empty and the groups come from the channels alone.
   */
  readonly categories: readonly ChannelCategory[];
}

const INITIAL_STATE: ChannelsState = {
  channels: new Map(),
  activeChannelId: null,
  roles: [],
  categories: [],
};

export const channelsStore = createStore<ChannelsState>(INITIAL_STATE);

// A server that sends no `role_ids` names the user's one role only; mention
// matching finds its id through the roster (registered here because
// lib/text/mentions sits below the stores).
registerRoleIdLookup((name) => {
  const lower = name.toLowerCase();
  return channelsStore.getState().roles.find((r) => r.name.toLowerCase() === lower)?.id;
});

/**
 * How many unread messages each channel had at the moment it was last opened.
 *
 * Opening a channel clears its badge immediately, which destroys the only
 * record of where the reader had got to — so the value is snapshotted here
 * first. MessageList reads it to place the "NEW" divider above the first
 * message the reader has not seen. Kept outside the store state because it is
 * not reactive: it is read once when the list mounts, and a subscriber firing
 * on it would just re-render the list for no visible change.
 */
const unreadOnOpen = new Map<number, number>();

/**
 * The read pointer each channel had when it was last opened — the same
 * snapshot as `unreadOnOpen`, for the same reason: the visit moves the live
 * pointer, and the NEW line has to stay where the reader had got to. Absent
 * (or undefined) means the server sent no pointer.
 */
const pointerOnOpen = new Map<number, number | undefined>();

/** The read pointer this channel had when it was last opened (undefined = none sent). */
export function getPointerOnOpen(channelId: number): number | undefined {
  return pointerOnOpen.get(channelId);
}

/** Unread count this channel had when it was last opened (0 = nothing new). */
export function getUnreadOnOpen(channelId: number): number {
  return unreadOnOpen.get(channelId) ?? 0;
}

/** Bulk set channels from the ready payload. Converts ReadyChannel[] to Map. */
export function setChannels(channels: readonly ReadyChannel[]): void {
  // A fresh ready payload restates unread from the server; any snapshot from
  // the previous connection describes a read position that no longer applies.
  unreadOnOpen.clear();
  pointerOnOpen.clear();
  const map = new Map<number, Channel>();
  for (const ch of channels) {
    map.set(ch.id, {
      id: ch.id,
      name: ch.name,
      type: ch.type,
      category: ch.category,
      categoryId: ch.category_id ?? 0,
      categoryPosition: ch.category_position ?? 0,
      topic: ch.topic ?? "",
      position: ch.position,
      unreadCount: ch.unread_count ?? 0,
      mentionCount: ch.mention_count ?? 0,
      lastMessageId: ch.last_message_id ?? null,
      lastReadMessageId: ch.last_read_message_id,
      // The current server always sends can_send; older servers omit it, in
      // which case we default permissive (no gating) rather than guessing.
      canSend: ch.can_send ?? true,
      canModerateVoice: ch.can_moderate_voice,
      canMoveVoice: ch.can_move_voice,
      canDeleteOthers: ch.can_delete_others,
      canPin: ch.can_pin,
      canReact: ch.can_react,
      slowMode: ch.slow_mode ?? 0,
      // Older servers omit these; "absent" reads as unflagged / unlimited,
      // which is also what an unconfigured channel sends.
      nsfw: ch.nsfw ?? false,
      isPrivate: ch.private ?? false,
      nsfwAcknowledged: (ch.nsfw ?? false) && ch.nsfw_acknowledged === true,
      voiceMaxUsers: ch.voice_max_users ?? 0,
      voiceMaxVideo: ch.voice_max_video ?? 0,
      afk: ch.afk ?? false,
      forum: ch.forum,
    });
  }
  channelsStore.setState((prev) => {
    // The ready payload never includes DM rows (those arrive via dm_channels
    // and are synthesized into this store on selection), so carry them across
    // the rebuild — destroying them would break call/profile actions for the
    // DM the user is currently viewing until they re-click it.
    for (const [id, ch] of prev.channels) {
      if (ch.type === "dm" && !map.has(id)) {
        map.set(id, ch);
      }
    }
    return { ...prev, channels: map };
  });
}

/**
 * Replace the manager's category list wholesale (ready.categories or a
 * channel_categories frame), kept in the server's (position, id) order.
 */
export function setCategories(categories: readonly ChannelCategory[]): void {
  const sorted = categories.toSorted((a, b) => a.position - b.position || a.id - b.id);
  channelsStore.setState((prev) => ({ ...prev, categories: sorted }));
}

/** Bulk set roles from the ready payload. */
export function setRoles(roles: readonly ReadyRole[]): void {
  channelsStore.setState((prev) => ({ ...prev, roles }));
}

/**
 * Reset the entire store to its initial (empty) state — e.g. on logout.
 * Also clears unreadOnOpen: without this, setChannels' DM-row carry (above)
 * re-inserts the previous server's DM channel rows into the next server's
 * channel map on the next login, and a stale read-position snapshot from the
 * old server would otherwise leak into the new one.
 */
export function resetChannelsStore(): void {
  unreadOnOpen.clear();
  pointerOnOpen.clear();
  channelsStore.setState(() => INITIAL_STATE);
}
void registerSessionReset("channels:store", resetChannelsStore); // app-lifetime

/** Look up a role ID by name (case-insensitive). Returns undefined if not found. */
export function getRoleIdByName(name: string): number | undefined {
  const roles = channelsStore.getState().roles;
  const match = roles.find((r) => r.name.toLowerCase() === name.toLowerCase());
  return match?.id;
}

/** Add a single channel from a channel_create event. The server re-sends
 *  channel_create to still-visible clients on role/override edits, so the add
 *  must be idempotent: a re-add must preserve the existing row's per-user
 *  fields the frame does not carry instead of resetting them. */
export function addChannel(channel: ChannelCreatePayload): void {
  channelsStore.setState((prev) => {
    const existing = prev.channels.get(channel.id);
    const next = new Map(prev.channels);
    next.set(channel.id, {
      id: channel.id,
      name: channel.name,
      type: channel.type,
      category: channel.category,
      categoryId: channel.category_id ?? existing?.categoryId ?? 0,
      categoryPosition: channel.category_position ?? existing?.categoryPosition ?? 0,
      topic: channel.topic ?? "",
      position: channel.position,
      unreadCount: existing?.unreadCount ?? 0,
      mentionCount: existing?.mentionCount ?? 0,
      lastMessageId: existing?.lastMessageId ?? null,
      lastReadMessageId: existing?.lastReadMessageId,
      // Every channel_create carries this viewer's own can_send, so a live
      // role/override edit updates the composer without waiting for a
      // reconnect. Older servers omit it — keep the existing verdict there,
      // and default permissive for a genuinely new channel. The server
      // enforces regardless.
      canSend: channel.can_send ?? existing?.canSend ?? true,
      // Same targeted, absent-means-unchanged rule; a new channel stays unknown.
      canModerateVoice: channel.can_moderate_voice ?? existing?.canModerateVoice,
      canMoveVoice: channel.can_move_voice ?? existing?.canMoveVoice,
      canDeleteOthers: channel.can_delete_others ?? existing?.canDeleteOthers,
      canPin: channel.can_pin ?? existing?.canPin,
      canReact: channel.can_react ?? existing?.canReact,
      slowMode: channel.slow_mode ?? 0,
      nsfw: channel.nsfw ?? false,
      // A re-sent channel_create from an older server omits it: keep what we know.
      isPrivate: channel.private ?? existing?.isPrivate ?? false,
      // channel_create never carries the per-viewer acknowledgement; keep the
      // known one while the label stays on.
      nsfwAcknowledged: (channel.nsfw ?? false) && existing?.nsfwAcknowledged === true,
      voiceMaxUsers: channel.voice_max_users ?? 0,
      voiceMaxVideo: channel.voice_max_video ?? 0,
      afk: channel.afk ?? existing?.afk ?? false,
      forum: channel.forum ?? existing?.forum,
    });
    return { ...prev, channels: next };
  });
}

/**
 * Apply a channel_update broadcast immutably.
 *
 * Every field is optional and an absent one is left alone rather than reset:
 * the payload from an older server carries fewer keys than this one knows
 * about, and treating "absent" as "cleared" would blank a channel's topic or
 * drop its NSFW flag on the first update after connecting.
 */
export function updateChannel(update: ChannelUpdatePayload): void {
  channelsStore.setState((prev) => {
    const existing = prev.channels.get(update.id);
    if (existing === undefined) {
      return prev;
    }
    const updated: Channel = {
      ...existing,
      ...(update.name !== undefined ? { name: update.name } : {}),
      ...(update.topic !== undefined ? { topic: update.topic } : {}),
      // "" is a real value here — it means "no category" — so only undefined
      // is treated as "not sent".
      ...(update.category !== undefined ? { category: update.category } : {}),
      ...(update.category_id !== undefined ? { categoryId: update.category_id } : {}),
      ...(update.category_position !== undefined
        ? { categoryPosition: update.category_position }
        : {}),
      ...(update.position !== undefined ? { position: update.position } : {}),
      ...(update.slow_mode !== undefined ? { slowMode: update.slow_mode } : {}),
      // Clearing the label deletes every acknowledgement server-side, so a
      // later relabel starts gated again.
      ...(update.nsfw !== undefined
        ? { nsfw: update.nsfw, nsfwAcknowledged: update.nsfw && existing.nsfwAcknowledged === true }
        : {}),
      ...(update.private !== undefined ? { isPrivate: update.private } : {}),
      ...(update.voice_max_users !== undefined ? { voiceMaxUsers: update.voice_max_users } : {}),
      ...(update.voice_max_video !== undefined ? { voiceMaxVideo: update.voice_max_video } : {}),
      ...(update.afk !== undefined ? { afk: update.afk } : {}),
      ...(update.forum !== undefined ? { forum: update.forum } : {}),
    };
    const next = new Map(prev.channels);
    next.set(update.id, updated);
    return { ...prev, channels: next };
  });
}

/**
 * Record the server-confirmed acknowledgement of a labelled channel.
 * Ignored for an unknown or unlabelled channel, which has nothing to consent to.
 */
export function setNsfwAcknowledged(id: number, acknowledged: boolean): void {
  channelsStore.setState((prev) => {
    const existing = prev.channels.get(id);
    if (existing === undefined || !existing.nsfw) return prev;
    if ((existing.nsfwAcknowledged === true) === acknowledged) return prev;
    const next = new Map(prev.channels);
    next.set(id, { ...existing, nsfwAcknowledged: acknowledged });
    return { ...prev, channels: next };
  });
}

/** Update a single channel's position immutably. */
export function updateChannelPosition(id: number, position: number): void {
  channelsStore.setState((prev) => {
    const existing = prev.channels.get(id);
    if (existing === undefined || existing.position === position) {
      return prev;
    }
    const updated: Channel = { ...existing, position };
    const next = new Map(prev.channels);
    next.set(id, updated);
    return { ...prev, channels: next };
  });
}

/** Remove a channel. Clears activeChannelId if it was the removed channel. */
export function removeChannel(id: number): void {
  channelsStore.setState((prev) => {
    const next = new Map(prev.channels);
    next.delete(id);
    return {
      ...prev,
      channels: next,
      activeChannelId: prev.activeChannelId === id ? null : prev.activeChannelId,
    };
  });
}

/**
 * Set the active channel by id (or null to deselect). Clears the unread and
 * mention counts for the activated channel — the server's channel_focus does
 * the same server-side, so the badges must not survive the visit locally.
 *
 * `clearUnread: false` selects without zeroing the badge: the ready-time
 * auto-select (and the last-channel restore) is not the user opening the
 * channel, so a channel they never looked at keeps its unread count until it
 * is actually mounted. The `unreadOnOpen` snapshot is taken either way, so the
 * NEW divider still lands above the first unseen message on the real visit.
 */
export function setActiveChannel(id: number | null, options?: { clearUnread?: boolean }): void {
  // Snapshot before clearing — this is the last moment the reader's position is
  // knowable (see unreadOnOpen). Done outside setState so the updater stays a
  // pure function of previous state.
  if (id !== null) {
    unreadOnOpen.set(id, channelsStore.getState().channels.get(id)?.unreadCount ?? 0);
    pointerOnOpen.set(id, channelsStore.getState().channels.get(id)?.lastReadMessageId);
  }
  const clear = options?.clearUnread ?? true;
  channelsStore.setState((prev) => {
    if (id === null) {
      return { ...prev, activeChannelId: null };
    }
    const existing = prev.channels.get(id);
    if (
      !clear ||
      existing === undefined ||
      (existing.unreadCount === 0 && existing.mentionCount === 0)
    ) {
      return { ...prev, activeChannelId: id };
    }
    const updated: Channel = { ...existing, unreadCount: 0, mentionCount: 0 };
    const next = new Map(prev.channels);
    next.set(id, updated);
    return { ...prev, activeChannelId: id, channels: next };
  });
}

/** Get the currently active Channel object, or null. */
export function getActiveChannel(): Channel | null {
  return channelsStore.select((s) => {
    if (s.activeChannelId === null) {
      return null;
    }
    return s.channels.get(s.activeChannelId) ?? null;
  });
}

/**
 * The group key (and name) of the synthetic group an uncategorized VOICE
 * channel falls back to.
 *
 * A voice channel groups under whatever category it has — there is no magic
 * name that makes a category "the voice one". Only a voice channel with no
 * category at all needs somewhere to go, and mixing it into the unnamed group
 * next to uncategorized text channels reads as a bug, so it gets this group.
 */
// i18n-exempt: stable group key, not rendered directly; groupLabel() maps it to the channel.voiceCategory catalog entry
export const UNCATEGORIZED_VOICE_CATEGORY = "Voice";

/**
 * A category as a menu or dialog names it. `id` is 0 for "no category" and for
 * a name-only category from a server that sends no ids; `name` is "" for none.
 */
export interface CategoryRef {
  readonly id: number;
  readonly name: string;
}

/** Filed under no category. */
export const NO_CATEGORY: CategoryRef = { id: 0, name: "" };

/** The group key of a real category. Collapse state is keyed by it. */
export function categoryKey(categoryId: number): string {
  return `cat:${categoryId}`;
}

/**
 * One group of the channel list. `key` is stable across a rename: `cat:<id>`
 * for a real category, the category name for a channel from a server that
 * sends no ids (the older-server fallback), `UNCATEGORIZED_VOICE_CATEGORY` for
 * the synthetic voice group and null for uncategorized text.
 */
export interface CategoryGroup {
  readonly key: string | null;
  /** The raw header name; null for uncategorized text. */
  readonly name: string | null;
  /** The category's id; 0 for every group that is not a real category. */
  readonly categoryId: number;
  readonly channels: readonly Channel[];
}

/** The header text for a group; the synthetic voice group reads through the catalog. */
export function groupLabel(group: Pick<CategoryGroup, "key" | "name">): string {
  return group.key === UNCATEGORIZED_VOICE_CATEGORY && group.name === UNCATEGORIZED_VOICE_CATEGORY
    ? connectText("channel.voiceCategory")
    : (group.name ?? "");
}

/** The group key a channel is displayed under. */
function keyOfChannel(channel: Channel): string | null {
  if ((channel.categoryId ?? 0) > 0) return categoryKey(channel.categoryId ?? 0);
  if (channel.category !== null && channel.category !== "") return channel.category;
  return channel.type === "voice" ? UNCATEGORIZED_VOICE_CATEGORY : null;
}

/** The category header a channel is displayed under (its group key). */
export function displayCategoryOf(channel: Channel): string | null {
  return keyOfChannel(channel);
}

/**
 * The position a new channel needs to land at the bottom of the group it will
 * be shown under: one past the highest position among the channels displayed
 * in that group (the synthetic "Voice" group counts uncategorized voice
 * channels; `categoryId` 0 is uncategorized). A group with no channels yet sorts
 * at the bottom of the whole list. The server stores a provided position as
 * given and a create with none sends 0, which lands at the top.
 */
export function nextPositionInCategory(categoryId: number, type: Channel["type"]): number {
  return nextPositionInGroup(categoryId > 0 ? categoryKey(categoryId) : voiceFallback(type));
}

function voiceFallback(type: Channel["type"]): string | null {
  return type === "voice" ? UNCATEGORIZED_VOICE_CATEGORY : null;
}

/** `nextPositionInCategory` for a legacy (name-keyed) group on a server without ids. */
export function nextPositionInCategoryNamed(category: string, type: Channel["type"]): number {
  return nextPositionInGroup(category === "" ? voiceFallback(type) : category);
}

function nextPositionInGroup(target: string | null): number {
  return channelsStore.select((s) => {
    let groupMax = -1;
    let allMax = -1;
    for (const channel of s.channels.values()) {
      if (channel.type === "dm") continue;
      if (channel.position > allMax) allMax = channel.position;
      if (keyOfChannel(channel) === target && channel.position > groupMax) {
        groupMax = channel.position;
      }
    }
    return (groupMax >= 0 ? groupMax : allMax) + 1;
  });
}

/**
 * The categories a channel can be filed under, in sidebar order, for the
 * create/edit pickers: the real ones (from the manager's list and from the
 * channels) plus, on a server that sends no ids, the free-text names in use.
 */
export interface KnownCategory {
  /** 0 for a legacy name-only category. */
  readonly id: number;
  readonly name: string;
}

export function getKnownCategories(categories: readonly ChannelCategory[]): KnownCategory[] {
  return channelsStore.select((s) =>
    categoryGroups(s.channels, categories)
      .filter((g) => g.name !== null && g.key !== UNCATEGORIZED_VOICE_CATEGORY)
      .map((g) => ({ id: g.categoryId, name: g.name ?? "" })),
  );
}

/**
 * Group channels by category in sidebar order (D7): uncategorized text first,
 * then the synthetic Voice group, then categories by (category position, id),
 * then any name-only categories from a server that sends no ids, in the order
 * of their first channel. Channels inside a group are sorted by (position, id)
 * — the server's `ORDER BY position, id` — with text-type channels before
 * voice (N23).
 *
 * `categories` is the manager's list (callers pass `visibleCategories()`, which is
 * empty once the viewer has lost MANAGE_CHANNELS): it adds the categories with no channel
 * and is authoritative for the name and position of the ones that have some.
 * A non-manager passes none, and a channel whose category the list never named
 * still draws its group from the channel's own category fields.
 */
export function categoryGroups(
  channels: ReadonlyMap<number, Channel>,
  categories: readonly ChannelCategory[] = [],
): CategoryGroup[] {
  type Draft = {
    key: string | null;
    name: string | null;
    categoryId: number;
    rank: number;
    sortPosition: number;
    order: number;
    channels: Channel[];
  };
  const sorted = [...channels.values()]
    // DM channels are shown in the DM sidebar, not the channel list
    .filter((channel) => channel.type !== "dm")
    .toSorted((a, b) => a.position - b.position || a.id - b.id);
  const drafts = new Map<string | null, Draft>();
  const draftFor = (key: string | null, make: () => Omit<Draft, "order" | "channels">): Draft => {
    const found = drafts.get(key);
    if (found !== undefined) return found;
    const draft: Draft = { ...make(), order: drafts.size, channels: [] };
    drafts.set(key, draft);
    return draft;
  };
  for (const channel of sorted) {
    const key = keyOfChannel(channel);
    const id = channel.categoryId ?? 0;
    const draft = draftFor(key, () => {
      if (key === null) return { key, name: null, categoryId: 0, rank: 0, sortPosition: 0 };
      if (key === UNCATEGORIZED_VOICE_CATEGORY && id <= 0 && (channel.category ?? "") === "") {
        return { key, name: key, categoryId: 0, rank: 1, sortPosition: 0 };
      }
      if (id > 0) {
        return {
          key,
          name: channel.category ?? "",
          categoryId: id,
          rank: 2,
          sortPosition: channel.categoryPosition ?? 0,
        };
      }
      return { key, name: key, categoryId: 0, rank: 3, sortPosition: 0 };
    });
    draft.channels.push(channel);
  }
  for (const category of categories) {
    const draft = draftFor(categoryKey(category.id), () => ({
      key: categoryKey(category.id),
      name: category.name,
      categoryId: category.id,
      rank: 2,
      sortPosition: category.position,
    }));
    draft.name = category.name;
    draft.sortPosition = category.position;
  }
  return [...drafts.values()]
    .toSorted(
      (a, b) =>
        a.rank - b.rank ||
        (a.rank === 2 ? a.sortPosition - b.sortPosition || a.categoryId - b.categoryId : 0) ||
        a.order - b.order,
    )
    .map((draft) => ({
      key: draft.key,
      name: draft.name,
      categoryId: draft.categoryId,
      // Text-type channels (text, announcement) come before voice inside each
      // group, each kind keeping its position order (a stable partition).
      channels: draft.channels.toSorted(
        (a, b) => Number(a.type === "voice") - Number(b.type === "voice"),
      ),
    }));
}

/** The groups keyed by `CategoryGroup.key`, in sidebar order. */
export function getChannelsByCategory(
  categories: readonly ChannelCategory[],
): Map<string | null, readonly Channel[]> {
  return channelsStore.select((s) => groupChannelsByCategory(s.channels, categories));
}

/** `getChannelsByCategory` over a channel map the caller already holds. */
export function groupChannelsByCategory(
  channels: ReadonlyMap<number, Channel>,
  categories: readonly ChannelCategory[],
): Map<string | null, readonly Channel[]> {
  return new Map(categoryGroups(channels, categories).map((g) => [g.key, g.channels]));
}

/**
 * Increment unread count for a channel, unless it is the active channel.
 *
 * `evenIfActive` opts out of that skip: "active" normally means
 * "the user is watching the live tail" — the reason a badge would be
 * redundant there — but the active channel's loaded window can be detached
 * from the live tail (a jump to an old permalink/reply/search hit), in which
 * case the message is genuinely unseen and must still count. Callers own
 * deciding when that applies; this still always skips an unknown channel id.
 */
export function incrementUnread(channelId: number, evenIfActive = false): void {
  channelsStore.setState((prev) => {
    if (prev.activeChannelId === channelId && !evenIfActive) {
      return prev;
    }
    const existing = prev.channels.get(channelId);
    if (existing === undefined) {
      return prev;
    }
    const updated: Channel = {
      ...existing,
      unreadCount: existing.unreadCount + 1,
    };
    const next = new Map(prev.channels);
    next.set(channelId, updated);
    return { ...prev, channels: next };
  });
}

/**
 * Increment the mention count for a channel, unless it is the active channel.
 * Callers also call incrementUnread — a mention is always an unread too, and
 * the two counters are kept independent so the badge can outrank.
 *
 * `evenIfActive` mirrors incrementUnread's escape hatch — see its doc for why.
 */
export function incrementMention(channelId: number, evenIfActive = false): void {
  channelsStore.setState((prev) => {
    if (prev.activeChannelId === channelId && !evenIfActive) {
      return prev;
    }
    const existing = prev.channels.get(channelId);
    if (existing === undefined) {
      return prev;
    }
    const updated: Channel = {
      ...existing,
      mentionCount: existing.mentionCount + 1,
    };
    const next = new Map(prev.channels);
    next.set(channelId, updated);
    return { ...prev, channels: next };
  });
}

/**
 * Record an incoming channel message: bumps unread (and mention, when
 * `isMention`) unless `messageId` is already reflected in the channel's
 * watermark — mirrors dm.store's `updateDmLastMessage`.
 *
 * A message delivered between the server's registerNow and
 * buildReady is both counted in `ready`'s snapshot (unread_count/
 * last_message_id already advanced) AND redelivered as a queued
 * chat_message once the socket drains. Both counters must sit behind the
 * SAME watermark read in one setState — splitting the guard across
 * incrementUnread/incrementMention can't work, since the first call would
 * already have advanced lastMessageId before the second one checked it.
 *
 * `evenIfActive` mirrors incrementUnread's escape hatch — see its doc.
 */
export function noteChannelMessage(
  channelId: number,
  messageId: number,
  isMention: boolean,
  evenIfActive = false,
): void {
  channelsStore.setState((prev) => {
    if (prev.activeChannelId === channelId && !evenIfActive) {
      return prev;
    }
    const existing = prev.channels.get(channelId);
    if (existing === undefined) {
      return prev;
    }
    const isReplay = existing.lastMessageId !== null && messageId <= existing.lastMessageId;
    if (isReplay) {
      return prev;
    }
    const updated: Channel = {
      ...existing,
      unreadCount: existing.unreadCount + 1,
      mentionCount: isMention ? existing.mentionCount + 1 : existing.mentionCount,
      lastMessageId: messageId,
    };
    const next = new Map(prev.channels);
    next.set(channelId, updated);
    return { ...prev, channels: next };
  });
}

/**
 * Set a channel's mention count from the server's authoritative total.
 * A mention that lands in a channel the user is not viewing never reaches this
 * client through the channel topic, so the server pushes a per-user
 * `mention_count` frame with the new total instead. Replacing rather than
 * incrementing keeps the count convergent across a lost or duplicated frame.
 *
 * `unreadCount` is deliberately untouched: the frame says nothing about it, and
 * a guild channel's taskbar/tray badge counts only mentions anyway. A no-op for
 * a channel this client does not know, so a stale frame cannot invent a row.
 */
export function setMentionCount(channelId: number, count: number): void {
  channelsStore.setState((prev) => {
    const existing = prev.channels.get(channelId);
    if (existing === undefined || existing.mentionCount === count) {
      return prev;
    }
    const updated: Channel = { ...existing, mentionCount: count };
    const next = new Map(prev.channels);
    next.set(channelId, updated);
    return { ...prev, channels: next };
  });
}

/** Clear the unread and mention counts for a channel — they clear together. */
export function clearUnread(channelId: number): void {
  channelsStore.setState((prev) => {
    const existing = prev.channels.get(channelId);
    if (existing === undefined) {
      return prev;
    }
    const updated: Channel = {
      ...existing,
      unreadCount: 0,
      mentionCount: 0,
    };
    const next = new Map(prev.channels);
    next.set(channelId, updated);
    return { ...prev, channels: next };
  });
}

/**
 * Set a channel's read pointer, and optionally its counts, outright (the
 * optimistic move of a mark, or the server's `read_state`). A no-op for a
 * channel this client does not know.
 */
export function setReadPointer(
  channelId: number,
  pointer: number | undefined,
  counts?: { readonly unread: number; readonly mention: number },
): void {
  channelsStore.setState((prev) => {
    const existing = prev.channels.get(channelId);
    if (existing === undefined) return prev;
    const map = new Map(prev.channels);
    map.set(channelId, {
      ...existing,
      lastReadMessageId: pointer,
      ...(counts && { unreadCount: counts.unread, mentionCount: counts.mention }),
    });
    return { ...prev, channels: map };
  });
}

/** Whether `channelId` is the server's AFK voice channel. */
export function isAfkChannel(channelId: number | null): boolean {
  return channelId !== null && channelsStore.getState().channels.get(channelId)?.afk === true;
}
