// Server to client WebSocket payloads: typing, presence, channels, voice and direct messages.

import type { ChannelType, ForumSettings, UserStatus, VoiceQuality } from "./wireCommon";

/** The game a member is playing, as it rides `presence` and `activity_update`. */
export interface GameActivity {
  readonly name: string;
  /** Unix milliseconds the game started (the server clamps it to the last 24 h). */
  readonly started_at: number;
}

/** The song a member is listening to, as it rides `presence` and `listening_update`. */
export interface ListeningActivity {
  readonly title: string;
  /** May be empty. */
  readonly artist: string;
  /** The app that plays it ("Spotify"). */
  readonly player: string;
  /** Unix milliseconds the song would have started at (now minus the position). */
  readonly started_at: number;
  /** The song's length in milliseconds; 0 = unknown. */
  readonly duration_ms: number;
}

export interface TypingPayload {
  readonly channel_id: number;
  readonly user_id: number;
  readonly username: string;
}

export interface PresencePayload {
  readonly user_id: number;
  readonly status: UserStatus;
  /** The user's current custom status line. Always present on the wire
   *  (null = none), so a cleared text is distinguishable from an event that
   *  simply does not mention it. */
  readonly custom_status?: string | null;
  /** The game the user is playing. Always present on a server with
   *  `game_activity` (null = none); absent from an older one, where the store
   *  leaves the shown game alone. */
  readonly activity?: GameActivity | null;
  /** The song the user is listening to. Always present on a server
   *  with `listening_activity` (null = none); absent from an older one. */
  readonly listening?: ListeningActivity | null;
  /** True when the user is on the Android app. Absent means not: the server
   *  omits it when false. */
  readonly mobile?: boolean;
}

export interface ChannelCreatePayload {
  readonly id: number;
  readonly name: string;
  readonly type: ChannelType;
  readonly category: string | null;
  /** See ReadyChannel.category_id. */
  readonly category_id?: number;
  /** See ReadyChannel.category_position. */
  readonly category_position?: number;
  readonly topic?: string;
  /** See ReadyChannel.forum. */
  readonly forum?: ForumSettings;
  readonly position: number;
  readonly slow_mode?: number;
  /** See ReadyChannel.nsfw — the age-restriction label the server enforces. */
  readonly nsfw?: boolean;
  /** See ReadyChannel.private — absent means unchanged. */
  readonly private?: boolean;
  /** Voice capacity limits (0 = unlimited). See ReadyChannel. */
  readonly voice_max_users?: number;
  readonly voice_max_video?: number;
  /** See ReadyChannel.password_protected — absent means unchanged. */
  readonly password_protected?: boolean;
  /** See ReadyChannel.afk — absent means unchanged. */
  readonly afk?: boolean;
  /**
   * This viewer's composer affordance — see ReadyChannel.can_send.
   *
   * Every channel_create is addressed to one client — at channel creation
   * and when a role or override edit changes who may post
   * (RefreshChannelVisibility) — and carries this viewer's verdict. Older
   * servers sent a shared broadcast without it. Treat absent as "unchanged",
   * never as false.
   */
  readonly can_send?: boolean;
  /**
   * This viewer's voice-moderation affordance — see
   * ReadyChannel.can_moderate_voice. Same targeted-only, absent-means-
   * unchanged rules as can_send.
   */
  readonly can_moderate_voice?: boolean;
  /** This viewer's move affordance — see ReadyChannel.can_move_voice. Absent means unchanged. */
  readonly can_move_voice?: boolean;
  /** This viewer's message affordances — see ReadyChannel. Absent means unchanged. */
  readonly can_delete_others?: boolean;
  readonly can_pin?: boolean;
  readonly can_react?: boolean;
}

export interface ChannelUpdatePayload {
  readonly id: number;
  readonly name?: string;
  readonly topic?: string;
  /** See ReadyChannel.forum — absent means unchanged. */
  readonly forum?: ForumSettings;
  /**
   * The category the channel now sits under ("" = uncategorized). Moving a
   * channel between categories is an edit, so the broadcast carries it and
   * the sidebar regroups without a reconnect.
   */
  readonly category?: string | null;
  /** See ReadyChannel.category_id — absent means unchanged. */
  readonly category_id?: number;
  /** See ReadyChannel.category_position — absent means unchanged. */
  readonly category_position?: number;
  readonly position?: number;
  readonly slow_mode?: number;
  /** See ReadyChannel.nsfw — the age-restriction label the server enforces. */
  readonly nsfw?: boolean;
  /** See ReadyChannel.private — absent means unchanged. */
  readonly private?: boolean;
  /** Voice capacity limits (0 = unlimited). See ReadyChannel. */
  readonly voice_max_users?: number;
  readonly voice_max_video?: number;
  /** See ReadyChannel.password_protected — absent means unchanged. */
  readonly password_protected?: boolean;
  /** See ReadyChannel.afk — absent means unchanged. */
  readonly afk?: boolean;
}

/** nsfw_ack — the caller acknowledged or revoked a labelled channel on another device. */
export interface NsfwAckPayload {
  readonly channel_id: number;
  readonly acknowledged: boolean;
}

export interface ChannelDeletePayload {
  readonly id: number;
}

export interface VoiceStatePayload {
  readonly channel_id: number;
  readonly user_id: number;
  readonly username: string;
  readonly muted: boolean;
  readonly deafened: boolean;
  readonly speaking: boolean;
  readonly camera: boolean;
  readonly screenshare: boolean;
  /** Moderator-imposed; the user cannot lift these themselves. Optional so an
   *  older server's payload still parses. */
  readonly server_muted?: boolean;
  readonly server_deafened?: boolean;
}

/** Server -> Client: the server moved this client to another voice channel,
 *  by a moderator (no `reason`) or the AFK sweep (`reason: "afk"`). */
export interface VoiceMovedPayload {
  readonly to_channel_id: number;
  readonly reason?: "afk";
  /** The moderator who made the move; absent for the AFK sweep and on older servers. */
  readonly by_user_id?: number;
}

/** Server -> Client: a moderator removed this client from voice. */
export interface VoiceDisconnectedPayload {
  readonly channel_id: number;
  readonly reason: string;
}

export interface VoiceLeavePayload {
  readonly channel_id: number;
  readonly user_id: number;
}

/** CRITICAL: uses threshold_mode, NOT mode. */
export interface VoiceConfigPayload {
  readonly channel_id: number;
  readonly quality: VoiceQuality;
  readonly bitrate: number;
  readonly threshold_mode: string;
  readonly mixing_threshold: number;
  readonly top_speakers: number;
  readonly max_users: number;
}

/** Argument shape for `voice.store.setSpeakers` — fed by LiveKit's
 *  ActiveSpeakersChanged, not by a wire message.
 *  CRITICAL: uses threshold_mode, NOT mode. */
export interface VoiceSpeakersPayload {
  readonly channel_id: number;
  readonly speakers: readonly number[];
  readonly threshold_mode?: string;
}

export interface VoiceTokenPayload {
  readonly channel_id: number;
  readonly token: string;
  readonly url: string;
  readonly direct_url?: string;
  readonly is_key_holder?: boolean;
}

/**
 * `game_activity_policy` — an admin turned game activity on or off for the
 * server. Unsequenced and not replayed; `auth_ok` carries the same
 * value on every connect and resume.
 */
export interface GameActivityPolicyPayload {
  readonly enabled: boolean;
}

/**
 * `video_bitrate_cap` — an admin saved the server's video upload cap. Bits per
 * second for one person's camera and screen share together; 0 means no cap.
 * Unsequenced and not replayed; `auth_ok` carries the same value on every
 * connect and resume.
 */
export interface VideoBitrateCapPayload {
  readonly max_video_bitrate: number;
}

// -----------------------------------------------------------------------------
// DM Payloads (Server → Client)
// -----------------------------------------------------------------------------

/** DM recipient object in DM channel payloads. */
export interface DmRecipient {
  readonly id: number;
  readonly username: string;
  readonly avatar: string;
  readonly status: string;
  /** Chosen nickname, "" when unset. Absent from pre-phase-6 servers. */
  readonly display_name?: string;
  /** True when this person is on the Android app. Absent = not. */
  readonly mobile?: boolean;
}

/** DM channel object in ready payload and dm_channel_open event. */
export interface DmChannelPayload {
  readonly channel_id: number;
  /**
   * The other participant of a 1:1 DM. Retained for backward compatibility;
   * for a group it carries the first of `recipients` so an older payload
   * shape still renders something. Prefer `recipients`.
   */
  readonly recipient: DmRecipient;
  /**
   * Every participant except the current user. Absent from pre-group servers,
   * where `recipient` is the whole membership.
   */
  readonly recipients?: readonly DmRecipient[];
  /** Optional group name. "" (or absent) for a 1:1 DM. */
  readonly name?: string;
  /** True for a group DM. Absent from pre-group servers, which had none. */
  readonly is_group?: boolean;
  /**
   * The group's owner (user id). Groups only, and only from a server with
   * group DM member management; its absence on a group means member management is unavailable.
   */
  readonly owner_id?: number;
  /**
   * The group's icon: "/api/v1/files/{id}", or "" for none. Absent from a
   * server without group icons; absent and "" both mean no icon.
   */
  readonly icon?: string;
  readonly last_message_id: number | null;
  readonly last_message: string;
  readonly last_message_at: string;
  readonly unread_count: number;
  /**
   * Unread messages in this DM that mention the current user. Absent from
   * older servers, which shipped no DM mention state at all — treat as 0.
   */
  readonly mention_count?: number;
  /**
   * The caller's read pointer in this DM (see ReadyChannel). Only the ready and
   * GET /dms entries carry it; dm_channel_open frames omit it.
   */
  readonly last_read_message_id?: number;
}
