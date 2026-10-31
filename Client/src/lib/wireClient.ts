// Client to server WebSocket payloads.

import type { GameActivity, ListeningActivity, ThreadInfo } from "./wireServer";
import type { UserStatus } from "./wireCommon";

// -----------------------------------------------------------------------------
// Client → Server Payloads
// -----------------------------------------------------------------------------

export interface AuthPayload {
  readonly token: string;
  readonly last_seq?: number;
  /** The wire epoch this client speaks — always `PROTOCOL_EPOCH`. */
  readonly epoch: number;
  /**
   * The channel this client had open when it disconnected, sent only on a
   * resume (`last_seq > 0`).
   *
   * Lets the server restore the ChannelTopic subscription during the handshake
   * instead of leaving the socket unsubscribed until the post-`auth_ok`
   * `channel_focus` round trip lands — messages broadcast in that window would
   * otherwise reach nobody on this connection and could never be re-requested,
   * since the client only reports `max(seq)`. The server re-checks read
   * permission before honouring it. Omitted when unknown.
   */
  readonly active_channel_id?: number;
  /**
   * What this client can render, declared once per connection. The
   * server withholds anything not declared, so an older client never sees it.
   */
  readonly features?: readonly string[];
  /**
   * This device's identity public key (base64, the format PATCH /users/me
   * takes). The server attaches it to the voice E2EE announces this connection
   * sends, so peers verify against the announcing device's own key. Omitted
   * when the key is unavailable or for an older client.
   */
  readonly identity_public_key?: string;
}

export interface ChatSendPayload {
  readonly client_message_id?: string;
  readonly channel_id: number;
  readonly content: string;
  readonly reply_to: number | null;
  /** With reply_to, whether the reply mentions the parent's author (3A-12). */
  readonly reply_ping?: boolean;
  readonly attachments: readonly string[];
  /** Sends a custom sticker: needs `client_message_id`, no text, no attachments. */
  readonly sticker_id?: number;
}

/** Create a forum post and its opening message in one step. */
export interface ForumPostCreatePayload {
  readonly channel_id: number;
  readonly name: string;
  readonly content: string;
  readonly attachments: readonly string[];
  readonly tag_ids: readonly number[];
  readonly client_message_id: string;
}

/** forum_post_create_ok: `thread` is absent on a deduplicated answer to a caller who lost the forum. */
export interface ForumPostCreateOkPayload {
  readonly thread?: ThreadInfo;
  readonly message_id: number;
  readonly client_message_id?: string;
  readonly deduplicated?: boolean;
  readonly skipped_attachment_ids?: readonly string[];
}

/** Copy one message into one channel or DM; `client_message_id` is required. */
export interface ChatForwardPayload {
  readonly client_message_id: string;
  readonly channel_id: number;
  readonly message_id: number;
}

/** One answer of a new poll; `emoji` is optional. */
export interface PollCreateAnswer {
  readonly text: string;
  readonly emoji?: string;
}

/** Post a poll as a message; `client_message_id` is required. */
export interface PollCreatePayload {
  readonly client_message_id: string;
  readonly channel_id: number;
  readonly question: string;
  readonly answers: readonly PollCreateAnswer[];
  readonly duration_hours: number;
  readonly allow_multiselect: boolean;
}

/** Set the sender's whole selection on a poll; `[]` removes the vote. */
export interface PollVotePayload {
  readonly message_id: number;
  readonly answer_ids: readonly number[];
}

export interface PollEndPayload {
  readonly message_id: number;
}

export interface ChatEditPayload {
  readonly message_id: number;
  readonly content: string;
}

export interface ChatDeletePayload {
  readonly message_id: number;
}

export interface ReactionAddPayload {
  readonly message_id: number;
  readonly emoji: string;
}

export interface ReactionRemovePayload {
  readonly message_id: number;
  readonly emoji: string;
}

export interface TypingStartPayload {
  readonly channel_id: number;
}

export interface ChannelFocusPayload {
  readonly channel_id: number;
  /**
   * false = focus and subscribe without marking the channel read (only with
   * the `read_pointer` capability). Absent means true, as for older clients.
   */
  readonly read?: boolean;
}

/**
 * mark_read — advance the read state for a channel the user is *not* viewing.
 * Same shape as channel_focus, deliberately a different message: focus also
 * rebinds the connection's focused channel, which would be wrong here.
 */
export interface MarkReadPayload {
  readonly channel_id: number;
  /**
   * Read up to this message (forward only, only with the `read_pointer`
   * capability). Absent marks the channel read at its latest message.
   */
  readonly message_id?: number;
}

/**
 * mark_unread — move the read pointer to just before `message_id`, so that
 * message and everything after it is unread again (`read_pointer` capability).
 */
export interface MarkUnreadPayload {
  readonly channel_id: number;
  readonly message_id: number;
}

/**
 * read_state — the caller's read pointer for one channel or DM after a
 * `mark_read` or `mark_unread` was accepted. Targeted, unsequenced and never
 * replayed; replaces the pointer and both counts outright.
 */
export interface ReadStatePayload {
  readonly channel_id: number;
  readonly last_read_message_id: number;
  readonly unread_count: number;
  readonly mention_count: number;
}

export interface PresenceUpdatePayload {
  readonly status: UserStatus;
  /** Omitted = leave the stored text alone (what the auto-idle timer sends);
   *  "" = clear it. */
  readonly custom_status?: string;
  /** Whole seconds (60..604800) after which the server clears the custom
   *  status. Only valid with a non-empty `custom_status`; omitted = no expiry. */
  readonly custom_status_expires_in?: number;
}

/** Client→Server: the game being played, or null once it stops. */
export interface ActivityUpdatePayload {
  readonly activity: GameActivity | null;
}

/** Client→Server: the song being listened to, or null once it stops. */
export interface ListeningUpdatePayload {
  readonly listening: ListeningActivity | null;
}

export interface VoiceJoinPayload {
  readonly channel_id: number;
  /** Set on the user's own join; automatic rejoins (reconnect, voice_moved) omit it. */
  readonly user_initiated?: boolean;
  /** The channel's password, sent once by the user for a protected channel; never stored. */
  readonly password?: string;
}

/** Client → Server: leave current voice channel (no payload needed). */
export type VoiceLeaveClientPayload = Record<string, never>;

export interface VoiceMutePayload {
  readonly muted: boolean;
}

export interface VoiceDeafenPayload {
  readonly deafened: boolean;
}

export interface VoiceCameraPayload {
  readonly enabled: boolean;
}

export interface VoiceScreensharePayload {
  readonly enabled: boolean;
}

/** Client -> Server: moderator sets another user's server mute. channel_id is
 *  the channel the moderator sees them in; the server refuses a mismatch. */
export interface VoiceModMutePayload {
  readonly channel_id: number;
  readonly user_id: number;
  readonly muted: boolean;
}

export interface VoiceModDeafenPayload {
  readonly channel_id: number;
  readonly user_id: number;
  readonly deafened: boolean;
}

export interface VoiceModMovePayload {
  readonly user_id: number;
  readonly to_channel_id: number;
}

export interface VoiceModKickPayload {
  readonly user_id: number;
}
