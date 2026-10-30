// Message model for the messages store: the state and row types, the
// wire-to-store converters, the per-channel cap and the initial state —
// extracted from stores/messages.store.ts, which re-exports the types and
// stays the only import path consumers use.
import type {
  CallInfo,
  GroupEventInfo,
  ForwardInfo,
  PollInfo,
  PollView,
  MessageStickerInfo,
  ThreadInfo,
  ChatMessagePayload,
  MessageUser,
  Attachment,
  ReactionSummary,
  ReferencedMessage,
  MessageResponse,
  ImportedAuthor,
} from "../../lib/types";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

/**
 * Delivery status of a message row.
 * - "sent": confirmed by the server (the default for every server-sourced row).
 * - "pending": optimistic local row awaiting the chat_send_ok ack.
 * - "failed": the send was rejected or dropped; the row offers retry.
 * - "uploading": a queued send waiting for its files (3A-9). Never in
 *   `pendingSends`, so a disconnect sweep and the content-only echo match leave
 *   it alone; the controller turns it into a pending row when the files land.
 */
export type MessageStatus = "sent" | "pending" | "failed" | "uploading";

export interface Message {
  readonly id: number;
  readonly channelId: number;
  readonly user: MessageUser;
  readonly content: string;
  readonly replyTo: number | null;
  /** Server snippet of the reply parent, for a parent outside the loaded window. */
  readonly referencedMessage?: ReferencedMessage | null;
  readonly attachments: readonly Attachment[];
  readonly reactions: readonly ReactionSummary[];
  readonly pinned: boolean;
  readonly editedAt: string | null;
  readonly deleted: boolean;
  readonly timestamp: string;
  /** Delivery status. Server-sourced rows are always "sent". */
  readonly status: MessageStatus;
  /**
   * Correlation id for an optimistic row, matching the id echoed on
   * chat_send_ok / error. Null once reconciled or for server-sourced rows.
   */
  readonly correlationId: string | null;
  /** Stable logical send identity; transport correlation changes on each retry. */
  readonly clientMessageId?: string;
  /** Error code when status === "failed" (e.g. "SLOW_MODE", "FORBIDDEN"). */
  readonly errorCode: string | null;
  /**
   * Server-resolved mentioned user IDs. Optional so the many inline Message
   * fixtures need not restate it; undefined means "the server didn't say",
   * which sends rendering down the local @token resolution path.
   */
  readonly mentions?: readonly number[];
  /** Whether an honoured @everyone/@here is present. Optional, as above. */
  readonly mentionsEveryone?: boolean;
  /** Server-resolved mentioned role IDs. Optional, as above. */
  readonly mentionRoles?: readonly number[];
  /** "call" for a server-written DM call log row; absent for an ordinary message. */
  readonly kind?: string;
  /** The call a `kind: "call"` row stands for; the render source, never `content`. */
  readonly call?: CallInfo;
  /** The payload of a group DM system row (`kind` group_*); the render source, never `content`. */
  readonly groupEvent?: GroupEventInfo;
  /** Set on a forwarded message: the snapshot's source, never an author. */
  readonly forward?: ForwardInfo;
  /** Set on a poll message: the card's source, kept in version order by pollState.ts. */
  readonly poll?: PollView;
  /** Set on a sticker message: the image's source, or just the name once it is deleted. */
  readonly sticker?: MessageStickerInfo;
  /** Set on a thread's starter message; threadsStore holds the live state. */
  readonly thread?: ThreadInfo;
  /** Set on an imported message: the Discord author shown in place of `user`. */
  readonly importedAuthor?: ImportedAuthor;
}

/** A reaction toggle applied optimistically, awaiting its server echo. Keyed
 *  by the WS envelope id so an error reply (or local transport failure) can
 *  roll back exactly this toggle — the same correlation scheme pendingSends
 *  uses for optimistic message rows. */
export interface PendingReaction {
  readonly channelId: number;
  readonly messageId: number;
  readonly emoji: string;
  readonly action: "add" | "remove";
}

export interface MessagesState {
  /** Messages per channel: channelId -> ordered array of Message */
  readonly messagesByChannel: ReadonlyMap<number, readonly Message[]>;
  /** Pending send confirmations: correlationId -> channelId */
  readonly pendingSends: ReadonlyMap<string, number>;
  /** Optimistic reaction toggles awaiting their echo: correlationId -> toggle.
   *  The store always sets it; optional only so the many inline MessagesState
   *  test fixtures need not restate it. */
  readonly pendingReactions?: ReadonlyMap<string, PendingReaction>;
  /** Whether we've loaded initial messages for a channel */
  readonly loadedChannels: ReadonlySet<number>;
  /** Whether more messages exist above for a channel */
  readonly hasMore: ReadonlyMap<number, boolean>;
  /**
   * First-page history fetch state per channel. Absent entry = idle (loaded or
   * never requested) — the message region then renders normally/empty.
   */
  readonly historyLoadState: ReadonlyMap<number, "loading" | "error">;
  /**
   * Channels whose last older-page fetch (scrolling up) failed, so the list
   * shows an inline Retry at its top. Set on a failure, cleared when a page
   * lands, when the window is replaced, or when the channel is mounted again.
   * The store always sets it; optional only so the many inline MessagesState
   * test fixtures need not restate it.
   */
  readonly olderLoadFailed?: ReadonlySet<number>;
  /**
   * channelId -> count of pin/unpin changes seen (setMessagePinned), bumped even
   * when the message is not loaded. The open pinned panel watches its channel's
   * entry to know its fetched list went stale (a chat_pinned names only the
   * message). Optional like the fields above so inline fixtures need not set it.
   */
  readonly pinRevision?: ReadonlyMap<number, number>;
  /** messageId -> count of pin/unpin changes seen for that message. */
  readonly messagePinRevision?: ReadonlyMap<number, number>;
  /**
   * Channels whose loaded window is an around-window detached from the live
   * tail: newer messages exist on the server below what is rendered. While a
   * channel is here the list shows a "Jump to Present" pill and incoming
   * broadcasts are *not* appended — they belong below the window, and
   * appending them would fake continuity across a gap.
   */
  readonly detachedChannels: ReadonlySet<number>;
  /**
   * channelId -> highest message id present the moment a history fetch was
   * started (setChannelLoading), consumed and cleared by the matching
   * setMessages. Lets setMessages tell "no messages arrived after the
   * snapshot was taken" apart from "the snapshot itself was empty" — an
   * empty page's own maxSnapshotId is 0, which without this watermark floor
   * would make every pre-existing "sent" row look newer than the snapshot and
   * survive forever, even when the channel was genuinely emptied by a purge.
   * The store always sets it; optional only so the many inline MessagesState
   * test fixtures need not restate it.
   */
  readonly loadWatermark?: ReadonlyMap<number, number>;
}

// -----------------------------------------------------------------------------
// Helpers: convert wire types to store types
// -----------------------------------------------------------------------------

/** The wire block as the client holds it: `me` is current as of the block's own version. */
function toPollView(poll: PollInfo): PollView {
  return { ...poll, selfVersion: poll.results.version };
}

export function chatPayloadToMessage(payload: ChatMessagePayload): Message {
  return {
    id: payload.id,
    channelId: payload.channel_id,
    user: payload.user,
    content: payload.content,
    replyTo: payload.reply_to,
    ...(payload.referenced_message !== undefined && {
      referencedMessage: payload.referenced_message,
    }),
    attachments: payload.attachments,
    reactions: [],
    pinned: false,
    editedAt: null,
    deleted: false,
    timestamp: payload.timestamp,
    status: "sent",
    correlationId: null,
    clientMessageId: payload.client_message_id,
    errorCode: null,
    mentions: payload.mentions,
    mentionsEveryone: payload.mentions_everyone,
    ...(payload.mention_roles !== undefined && { mentionRoles: payload.mention_roles }),
    ...(payload.kind !== undefined && { kind: payload.kind }),
    ...(payload.call !== undefined && { call: payload.call }),
    ...(payload.group_event !== undefined && { groupEvent: payload.group_event }),
    ...(payload.forward !== undefined && { forward: payload.forward }),
    ...(payload.poll !== undefined && { poll: toPollView(payload.poll) }),
    ...(payload.sticker !== undefined && { sticker: payload.sticker }),
    ...(payload.thread !== undefined && { thread: payload.thread }),
  };
}

export function messageResponseToMessage(response: MessageResponse): Message {
  return {
    id: response.id,
    channelId: response.channel_id,
    user: response.user,
    content: response.content,
    replyTo: response.reply_to,
    ...(response.referenced_message !== undefined && {
      referencedMessage: response.referenced_message,
    }),
    attachments: response.attachments,
    reactions: response.reactions,
    pinned: response.pinned,
    editedAt: response.edited_at,
    deleted: response.deleted,
    timestamp: response.timestamp,
    status: "sent",
    correlationId: null,
    errorCode: null,
    mentions: response.mentions,
    mentionsEveryone: response.mentions_everyone,
    ...(response.mention_roles !== undefined && { mentionRoles: response.mention_roles }),
    ...(response.kind !== undefined && { kind: response.kind }),
    ...(response.call !== undefined && { call: response.call }),
    ...(response.group_event !== undefined && { groupEvent: response.group_event }),
    ...(response.forward !== undefined && { forward: response.forward }),
    ...(response.poll !== undefined && { poll: toPollView(response.poll) }),
    ...(response.sticker !== undefined && { sticker: response.sticker }),
    ...(response.thread !== undefined && { thread: response.thread }),
    ...(response.imported_author !== undefined && { importedAuthor: response.imported_author }),
  };
}

/** Maximum messages retained per channel. Oldest messages are evicted when exceeded. */
export const MAX_MESSAGES_PER_CHANNEL = 500;

// -----------------------------------------------------------------------------
// Initial state
// -----------------------------------------------------------------------------

export const INITIAL_STATE: MessagesState = {
  messagesByChannel: new Map(),
  pendingSends: new Map(),
  pendingReactions: new Map(),
  loadedChannels: new Set(),
  hasMore: new Map(),
  historyLoadState: new Map(),
  olderLoadFailed: new Set(),
  pinRevision: new Map(),
  messagePinRevision: new Map(),
  detachedChannels: new Set(),
  loadWatermark: new Map(),
};
