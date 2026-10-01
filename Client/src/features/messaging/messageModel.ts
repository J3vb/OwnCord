// Message model for the messages store: the state and row types, the
// wire-to-store converters, the per-channel cap and the initial state —
// extracted from stores/messages.store.ts, which re-exports the types and
// stays the only import path consumers use.
import type {
  ChatMessagePayload,
  MessageUser,
  Attachment,
  ReactionSummary,
  MessageResponse,
} from "../../lib/types";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

/**
 * Delivery status of a message row.
 * - "sent": confirmed by the server (the default for every server-sourced row).
 * - "pending": optimistic local row awaiting the chat_send_ok ack.
 * - "failed": the send was rejected or dropped; the row offers retry.
 */
export type MessageStatus = "sent" | "pending" | "failed";

export interface Message {
  readonly id: number;
  readonly channelId: number;
  readonly user: MessageUser;
  readonly content: string;
  readonly replyTo: number | null;
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

export function chatPayloadToMessage(payload: ChatMessagePayload): Message {
  return {
    id: payload.id,
    channelId: payload.channel_id,
    user: payload.user,
    content: payload.content,
    replyTo: payload.reply_to,
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
  };
}

export function messageResponseToMessage(response: MessageResponse): Message {
  return {
    id: response.id,
    channelId: response.channel_id,
    user: response.user,
    content: response.content,
    replyTo: response.reply_to,
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
  detachedChannels: new Set(),
  loadWatermark: new Map(),
};
