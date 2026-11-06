/**
 * The channel row model: the `Channel` shape and the pure builders that turn a
 * ready, channel_create or channel_update payload into one. No store access
 * here, so each builder is a function of its inputs; channels.store.ts is the
 * facade that holds the state and re-exports these names.
 */

import type {
  ReadyChannel,
  ChannelCreatePayload,
  ChannelUpdatePayload,
  ChannelType,
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
   * A voice channel that asks for a password on join. Only the flag is ever
   * held: the password is typed into the join dialog and never stored. Absent
   * reads as unprotected (an older server, a DM).
   */
  readonly passwordProtected?: boolean | undefined;
  /**
   * The server's AFK voice channel: idle members are moved here and it is
   * listen-only. Absent from older servers, which is read as false.
   */
  readonly afk?: boolean | undefined;
  /** A forum's tags and settings; absent on every other type. */
  readonly forum?: ForumSettings | undefined;
}

/** The ready payload's per-viewer verdicts; absent ones stay unknown. */
function readyPermissions(
  ch: ReadyChannel,
): Pick<
  Channel,
  "canModerateVoice" | "canMoveVoice" | "canDeleteOthers" | "canPin" | "canReact"
> & { readonly canSend: boolean } {
  return {
    // The current server always sends can_send; older servers omit it, in
    // which case we default permissive (no gating) rather than guessing.
    canSend: ch.can_send ?? true,
    canModerateVoice: ch.can_moderate_voice,
    canMoveVoice: ch.can_move_voice,
    canDeleteOthers: ch.can_delete_others,
    canPin: ch.can_pin,
    canReact: ch.can_react,
  };
}

/** The ready payload's flags and limits. Older servers omit these; "absent"
 *  reads as unflagged / unlimited, which is also what an unconfigured channel sends. */
function readyLimits(
  ch: ReadyChannel,
): Pick<
  Channel,
  | "slowMode"
  | "nsfw"
  | "isPrivate"
  | "nsfwAcknowledged"
  | "voiceMaxUsers"
  | "voiceMaxVideo"
  | "passwordProtected"
  | "afk"
  | "forum"
> {
  return {
    slowMode: ch.slow_mode ?? 0,
    nsfw: ch.nsfw ?? false,
    isPrivate: ch.private ?? false,
    nsfwAcknowledged: (ch.nsfw ?? false) && ch.nsfw_acknowledged === true,
    voiceMaxUsers: ch.voice_max_users ?? 0,
    voiceMaxVideo: ch.voice_max_video ?? 0,
    passwordProtected: ch.password_protected,
    afk: ch.afk ?? false,
    forum: ch.forum,
  };
}

function readyChannel(ch: ReadyChannel): Channel {
  return {
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
    ...readyPermissions(ch),
    ...readyLimits(ch),
  };
}

/** The ready payload's channels as channelsStore rows, keyed by id. */
export function readyChannelMap(channels: readonly ReadyChannel[]): Map<number, Channel> {
  const map = new Map<number, Channel>();
  for (const ch of channels) map.set(ch.id, readyChannel(ch));
  return map;
}

/** The per-user counters and pointer a re-sent channel_create must not reset. */
function carriedReadState(
  existing: Channel | undefined,
): Pick<Channel, "unreadCount" | "mentionCount" | "lastMessageId" | "lastReadMessageId"> {
  return {
    unreadCount: existing?.unreadCount ?? 0,
    mentionCount: existing?.mentionCount ?? 0,
    lastMessageId: existing?.lastMessageId ?? null,
    lastReadMessageId: existing?.lastReadMessageId,
  };
}

/** Every channel_create carries this viewer's own can_send, so a live
 *  role/override edit updates the composer without waiting for a reconnect.
 *  Older servers omit it — keep the existing verdict there, and default
 *  permissive for a genuinely new channel. The server enforces regardless.
 *  The other verdicts follow the same absent-means-unchanged rule; a new
 *  channel stays unknown. */
function mergedPermissions(
  channel: ChannelCreatePayload,
  existing: Channel | undefined,
): Pick<
  Channel,
  "canSend" | "canModerateVoice" | "canMoveVoice" | "canDeleteOthers" | "canPin" | "canReact"
> {
  return {
    canSend: channel.can_send ?? existing?.canSend ?? true,
    canModerateVoice: channel.can_moderate_voice ?? existing?.canModerateVoice,
    canMoveVoice: channel.can_move_voice ?? existing?.canMoveVoice,
    canDeleteOthers: channel.can_delete_others ?? existing?.canDeleteOthers,
    canPin: channel.can_pin ?? existing?.canPin,
    canReact: channel.can_react ?? existing?.canReact,
  };
}

/** The flags and limits of a channel_create. A re-sent frame from an older
 *  server omits `private`: keep what we know. The frame never carries the
 *  per-viewer acknowledgement; keep the known one while the label stays on. */
function mergedLimits(
  channel: ChannelCreatePayload,
  existing: Channel | undefined,
): Pick<
  Channel,
  "slowMode" | "nsfw" | "isPrivate" | "nsfwAcknowledged" | "voiceMaxUsers" | "voiceMaxVideo"
> {
  return {
    slowMode: channel.slow_mode ?? 0,
    nsfw: channel.nsfw ?? false,
    isPrivate: channel.private ?? existing?.isPrivate ?? false,
    nsfwAcknowledged: (channel.nsfw ?? false) && existing?.nsfwAcknowledged === true,
    voiceMaxUsers: channel.voice_max_users ?? 0,
    voiceMaxVideo: channel.voice_max_video ?? 0,
  };
}

function mergedKind(
  channel: ChannelCreatePayload,
  existing: Channel | undefined,
): Pick<Channel, "passwordProtected" | "afk" | "forum"> {
  return {
    passwordProtected: channel.password_protected ?? existing?.passwordProtected,
    afk: channel.afk ?? existing?.afk ?? false,
    forum: channel.forum ?? existing?.forum,
  };
}

/** The row a channel_create produces. The server re-sends channel_create to
 *  still-visible clients on role/override edits, so it is idempotent: a re-add
 *  preserves the existing row's per-user fields the frame does not carry
 *  instead of resetting them. */
export function channelFromCreate(
  channel: ChannelCreatePayload,
  existing: Channel | undefined,
): Channel {
  return {
    id: channel.id,
    name: channel.name,
    type: channel.type,
    category: channel.category,
    categoryId: channel.category_id ?? existing?.categoryId ?? 0,
    categoryPosition: channel.category_position ?? existing?.categoryPosition ?? 0,
    topic: channel.topic ?? "",
    position: channel.position,
    ...carriedReadState(existing),
    ...mergedPermissions(channel, existing),
    ...mergedLimits(channel, existing),
    ...mergedKind(channel, existing),
  };
}

function placementPatch(update: ChannelUpdatePayload): Partial<Channel> {
  return {
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
  };
}

function limitsPatch(update: ChannelUpdatePayload, existing: Channel): Partial<Channel> {
  return {
    ...(update.slow_mode !== undefined ? { slowMode: update.slow_mode } : {}),
    // Clearing the label deletes every acknowledgement server-side, so a
    // later relabel starts gated again.
    ...(update.nsfw !== undefined
      ? { nsfw: update.nsfw, nsfwAcknowledged: update.nsfw && existing.nsfwAcknowledged === true }
      : {}),
    ...(update.private !== undefined ? { isPrivate: update.private } : {}),
    ...(update.voice_max_users !== undefined ? { voiceMaxUsers: update.voice_max_users } : {}),
    ...(update.voice_max_video !== undefined ? { voiceMaxVideo: update.voice_max_video } : {}),
    ...(update.password_protected !== undefined
      ? { passwordProtected: update.password_protected }
      : {}),
    ...(update.afk !== undefined ? { afk: update.afk } : {}),
    ...(update.forum !== undefined ? { forum: update.forum } : {}),
  };
}

/**
 * The row a channel_update produces.
 *
 * Every field is optional and an absent one is left alone rather than reset:
 * the payload from an older server carries fewer keys than this one knows
 * about, and treating "absent" as "cleared" would blank a channel's topic or
 * drop its NSFW flag on the first update after connecting.
 */
export function channelFromUpdate(existing: Channel, update: ChannelUpdatePayload): Channel {
  return { ...existing, ...placementPatch(update), ...limitsPatch(update, existing) };
}
