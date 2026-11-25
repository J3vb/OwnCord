/**
 * The DM list's shape: a DM's people, the DM itself and the store state.
 * dm.store.ts is the facade that holds the state and re-exports the types.
 */

export interface DmUser {
  readonly id: number;
  readonly username: string;
  readonly avatar: string;
  readonly status: string;
  /** On the Android app, copied from presence like `status`. Undefined = not. */
  readonly mobile?: boolean;
  /** Nickname to render instead of `username`. "" = unset. */
  readonly displayName?: string;
  /** The game this person is playing, copied from presence like
   *  `status`. Null or undefined = none. */
  readonly activity?: { readonly name: string; readonly startedAt: number } | null;
  /** The song this person is listening to, copied from presence like
   *  `activity`. Null or undefined = none. */
  readonly listening?: {
    readonly title: string;
    readonly artist: string;
    readonly player: string;
    readonly startedAt: number;
    readonly durationMs: number;
  } | null;
}

export interface DmChannel {
  readonly channelId: number;
  /**
   * The other participant of a 1:1 DM. For a group it is the first of
   * `participants`; anything that must be correct for groups reads
   * `participants` instead. Kept because most 1:1 call sites want exactly one
   * user and would otherwise all index into an array.
   */
  readonly recipient: DmUser;
  /** Everyone in the DM except the current user. Never empty for a live DM. */
  readonly participants: readonly DmUser[];
  /** Optional group name. "" for a 1:1 DM and for an unnamed group. */
  readonly name: string;
  /** True for a group DM (3+ participants at creation). */
  readonly isGroup: boolean;
  /**
   * The group's owner (user id). Present only for a group on a server with
   * member management; its absence is the feature-detection signal
   * that hides Add People, Remove and Make Group Owner.
   */
  readonly ownerId?: number;
  /** The group's icon file path; "" or absent for none. */
  readonly icon?: string;
  readonly lastMessageId: number | null;
  /**
   * The current user's read pointer in this DM (see Channel.lastReadMessageId).
   * Undefined when the server never said.
   */
  readonly lastReadMessageId?: number | undefined;
  readonly lastMessage: string;
  readonly lastMessageAt: string;
  readonly unreadCount: number;
  /**
   * Unread messages in this DM that mention the current user. Kept independent
   * of unreadCount so the red mention badge can outrank the plain one, exactly
   * as it does for channels.
   */
  readonly mentionCount: number;
}

export interface DmState {
  readonly channels: readonly DmChannel[];
}
