/**
 * The message list's public contract: the options a host passes to
 * `createMessageList` and the component handle it gets back.
 */
import type { MountableComponent } from "@lib/text/safeRender";
import type { PollOutcome } from "./pollSend";

export interface MessageListOptions {
  readonly channelId: number;
  readonly channelName: string;
  readonly channelType?: string;
  readonly currentUserId: number;
  /** May return a promise (e.g. the underlying fetch); MessageList clears its
   *  loadingOlder latch once it settles, success or failure. */
  readonly onScrollTop: () => void | Promise<void>;
  /**
   * Load the page of messages below a window detached from the live tail
   * (after a jump to an old message). Fired near the bottom of a detached
   * window only; may return a promise, which clears the in-flight latch once
   * it settles. The page that reaches the newest message reattaches the
   * window through the store. No paging below the window without it.
   */
  readonly onScrollBottom?: () => void | Promise<void>;
  readonly onReplyClick: (messageId: number) => void;
  readonly onEditClick: (messageId: number) => void;
  /**
   * Save the inline editor's text (cleaned, non-empty, within the limit).
   * True closes the editor; false keeps it open with the text (offline).
   */
  readonly onEditSave: (messageId: number, content: string) => boolean;
  /** Save with the text cleared: the host offers to delete the message. */
  readonly onEmptyEdit: (messageId: number) => void;
  /** The inline editor closed while it held focus: hand focus back (the composer). */
  readonly onEditEnd?: () => void;
  readonly onDeleteClick: (messageId: number, shiftKey: boolean) => void;
  readonly onReactionClick: (messageId: number, emoji: string) => void;
  readonly onPinClick: (messageId: number, channelId: number, currentlyPinned: boolean) => void;
  /** Report someone else's message or one of its attachments. No button without it. */
  readonly onReportClick?: (messageId: number) => void;
  /** Opens the Forward picker for a message. Absent, the menu offers no Forward. */
  readonly onForwardClick?: (messageId: number) => void;
  /** Set the viewer's whole selection on a poll (`[]` removes the vote); absent disables voting. */
  readonly onPollVote?: (
    messageId: number,
    answerIds: readonly number[],
  ) => Promise<PollOutcome<unknown>>;
  /** End a poll now; absent hides End poll. */
  readonly onPollEnd?: (messageId: number) => Promise<PollOutcome<unknown>>;
  /** Opens the Create Thread dialog for a message. Absent, the menu offers no Create Thread. */
  readonly onCreateThreadClick?: (messageId: number) => void;
  /** Opens a thread's side panel (the starter chip). Absent, the chip is inert text. */
  readonly onOpenThread?: (threadId: number) => void;
  /** Retry a failed optimistic send (by its correlation id). */
  readonly onRetry?: (correlationId: string) => void;
  /** Discard a failed optimistic send without retrying. */
  readonly onDeleteDraft?: (correlationId: string) => void;
  /** The upload strip of a send queued behind its files (3A-9), for the row with this
   *  correlation id; null when the row has none. `signal` ends with the row's render. */
  readonly renderUploadStrip?: (correlationId: string, signal: AbortSignal) => HTMLElement | null;
  /** Retry a failed first-page history fetch. */
  readonly onRetryLoad?: () => void;
  /**
   * Jump to another message in this channel — the reply bar above a reply, and
   * any other in-row affordance. May target a message outside the loaded
   * window; the handler is expected to fetch the around-window in that case.
   */
  readonly onJumpToMessage?: (messageId: number) => void;
  /**
   * Leave a detached around-window and reload the live tail. Wired to the
   * "Jump to Present" pill, which only appears while the window is detached.
   */
  readonly onJumpToPresent?: () => void;
  /** Send the 👋 reply to a welcome row. Absent, the row has no Wave button. */
  readonly onWave?: (messageId: number) => boolean;
  /** Open the pinned-messages panel ("pinned messages" link of a pin row). It never closes an open panel. */
  readonly onOpenPins?: () => void;
  /** Join the DM call a live call log row stands for. No Join button without it. */
  readonly onJoinCall?: (channelId: number) => void;
}

export type MessageListComponent = MountableComponent & {
  /** Scroll to a message by ID. Returns false if the message is not in the loaded window. */
  scrollToMessage(messageId: number): boolean;
  /** Escape: mark the channel read, drop the unread bar and go back to the
   *  newest messages (a detached window jumps to the present). */
  markReadAndJumpToPresent(): void;
  /** PageUp/PageDown from the message box: scroll one page; 1 is down. */
  scrollPage(direction: 1 | -1): void;
  /**
   * Open the inline editor in your own sent message's row, with `text` (default
   * the message's current content). False when the message is not loaded, not
   * yours or not sent. The editor itself arrives a moment later (lazy chunk).
   */
  /** Open the inline editor on one of your sent messages. `focus: false`
   *  restores it quietly (no focus, no scrolling) for a late failed save. */
  startEdit(messageId: number, text?: string, opts?: { readonly focus?: boolean }): boolean;
  /** Close the open inline editor, discarding its text. */
  cancelEdit(): void;
  /** True while an inline editor is open (or loading) in this list. */
  isEditing(): boolean;
  /** Tint the row the composer's reply bar answers; null clears it. */
  setReplyTarget(messageId: number | null): void;
};
