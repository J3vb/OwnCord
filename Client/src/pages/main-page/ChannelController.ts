/**
 * ChannelController — channel switching, component mount/destroy lifecycle.
 * Creates and manages MessageList, TypingIndicator, and MessageInput per channel.
 * Extracted from MainPage to reduce god-object coupling and enable unit testing.
 */

import { channelMediaEnabled } from "@lib/serverCapabilities";
import { clearChildren, createElement, setText } from "@lib/dom";
import { isServerRowKind } from "@lib/text/messageKind";
import { createConfirmModal } from "../../features/dialogs/confirmModal";
import { createLogger } from "@lib/logger";
import type { MountableComponent } from "@lib/text/safeRender";
import type { WsClient } from "@lib/ws";
import { ApiClientError, type ApiClient } from "@lib/api";
import type { ChannelType, VoiceUploadMeta } from "@lib/types";
import { createMessageList } from "@components/MessageList";
import { NAVIGATION_DESTINATIONS } from "../../features/navigation/destinations";
import { bindGifFavoritesApi } from "@stores/gifFavorites.store";
import { setInlineImageDecorator } from "@components/message-list/media";
import { WAVE_CONTENT } from "@components/message-list/welcomeRows";
import { gifFavoriteStar } from "@components/message-list/gifFavoriteStar";
import type { MessageListComponent } from "@components/MessageList";
import { createMessageInput } from "@components/MessageInput";
import type {
  ComposerDraft,
  MessageInputComponent,
  QueuedAttachment,
  ReplyTarget,
  SentAttachment,
} from "@components/MessageInput";
import { endPoll, votePoll } from "../../features/messaging/pollSend";
import { clearReactionUsersCache } from "../../features/messaging/reactionUsers";
import { loadSendQueue, preloadSendQueue } from "../../features/messaging/sendQueue-loader";
import type { SendQueueModule } from "../../features/messaging/sendQueue-loader";
import type { QueuedSend, QueueDeps } from "../../features/messaging/sendQueue";
import { createTypingIndicator } from "@components/TypingIndicator";
import { nsfwConsentRequired } from "../../features/content-consent/nsfw";
import {
  messagesStore,
  getChannelMessages,
  setMessagePinned,
  addOptimisticMessage,
  markSendFailed,
  removeOptimistic,
  reattachToPresent,
  isWindowDetached,
  invalidateChannelMessageWindow,
  clearChannelContent,
} from "@stores/messages.store";
import type { Message } from "@stores/messages.store";
import { resolveAuthor } from "@lib/text/formatting";
import { resolveDisplayName } from "@lib/avatar";
import { markdownToPlainText } from "@lib/text/markdown";
import { jumpToMessage } from "@lib/message-navigation";
import { authStore } from "@stores/auth.store";
import type { ImportedAuthor, MessageUser } from "@lib/types";
import { importedName } from "../../features/messaging/importedAuthor";
import type { MessageController } from "./MessageController";
import type { ReactionController } from "./ReactionController";
import {
  updateChatHeaderForDm,
  setChatHeaderChannelType,
  setChatHeaderThreads,
  setChatHeaderMedia,
  setChatHeaderTopic,
} from "./ChatHeader";
import { createThreadPanelHost } from "./ThreadPanelHost";
import {
  setThreadNavigationConsumer,
  settleThreadNavigation,
} from "../../features/threads/threadNavigation";
import type { ThreadPanelHost } from "./ThreadPanelHost";
import type { ThreadListPopover } from "@components/ThreadListPopover";
import type { ThreadInfo } from "@lib/types";
import type { ChatHeaderRefs } from "./ChatHeader";
import { dmStore, dmDisplayName } from "@stores/dm.store";
import type { DmChannel } from "@stores/dm.store";
import { createAvatarElement, pickAvatarColor } from "@components/message-list/avatar";
import { buildGroupAvatarStack } from "@components/DmSidebar";
import { canManageMessages } from "@lib/permissions";
import { findSticker } from "@stores/stickers.store";
import { stickersText } from "../../i18n/stickers";
import { blocksStore, dmComposerBlockReason } from "@stores/blocks.store";
import { membersStore } from "@stores/members.store";
import { channelsStore, setActiveChannel, setNsfwAcknowledged } from "@stores/channels.store";
import { viewChannel } from "@lib/prefs/lastChannel";
import { loadSavedDraft, saveDraft, type SavedDraft } from "@lib/prefs/savedDrafts";
import { uiStore } from "@stores/ui.store";
import { safetyStore } from "../../features/safety/store";
import { reportEntryText } from "../../i18n/reportEntry";
import { messagingText } from "../../i18n/messaging";
import { requestsText } from "../../i18n/requests";
import { shellText, statusLabel } from "../../i18n/shell";
import { formatUntil, safetyText } from "../../i18n/safety";
import { leaveChannel, markChannelRead, markChannelReadSeen } from "@lib/read-state";
import { readPointerEnabled, threadsEnabled } from "@lib/serverCapabilities";
import {
  newClientMessageId,
  pendingMessageExpired,
  pendingMessageRetryFloor,
  recoveredPendingText,
  supportsMessageDeduplication,
  savePendingText,
  acknowledgePendingMessage,
} from "@lib/pendingMessages";
import { WsErrorCode } from "@lib/protocolTypes";

const log = createLogger("channel-ctrl");

/** Longer than ws.ts's 60 s server-silence deadline, so a half-open socket is
 *  declared dead (and the entry failed) before the entry can expire. */
const TRACKED_ACTION_EXPIRY_MS = 90_000;
/** How long typing must pause before the draft is written to storage. */
const DRAFT_SAVE_DELAY_MS = 750;

/** Characters of the message shown in the delete confirm. */
const DELETE_PREVIEW_MAX_CHARS = 200;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ChannelControllerOptions {
  readonly ws: WsClient;
  readonly api: ApiClient;
  readonly msgCtrl: MessageController;
  readonly reactionCtrl: ReactionController;
  readonly typingLimiter: { tryConsume(key?: string): boolean };
  readonly showToast: (msg: string, type: string) => void;
  readonly getCurrentUserId: () => number;
  readonly slots: {
    readonly messagesSlot: HTMLDivElement;
    readonly typingSlot: HTMLDivElement;
    readonly inputSlot: HTMLDivElement;
    /** Where a thread's side panel mounts, beside the chat column. */
    readonly threadSlot?: HTMLDivElement;
  };
  readonly chatHeaderName: HTMLSpanElement | null;
  readonly chatHeaderRefs: ChatHeaderRefs | null;
  /** Close the image lightbox when the mounted channel falls behind the
   *  NSFW gate (ChatArea closes the pins and search overlays itself). */
  readonly onContentGated?: () => void;
  /** Move focus somewhere reachable after the NSFW gate that held it is
   *  removed (accepted, declined or dismissed with Escape). */
  readonly focusFallback?: () => void;
  /** Join the DM call a live call log row stands for. */
  readonly onJoinCall?: (channelId: number) => void;
  /** Open the pinned-messages panel (the "pinned messages" link of a pin row). */
  readonly onOpenPins?: () => void;
}

export interface ChannelController {
  /** Mount components for a channel. No-op if same channel already mounted. */
  mountChannel(channelId: number, channelName: string, channelType?: ChannelType): void;
  /** Destroy current channel components and reset state. */
  destroyChannel(): void;
  /** destroyChannel(), then drop every stashed draft and cancel the uploads
   *  still running in them. For page teardown. */
  destroy(): void;
  /** Currently mounted channel ID, or null. */
  readonly currentChannelId: number | null;
  /** Currently mounted message list (for scroll-to-message). */
  readonly messageList: MessageListComponent | null;
  /** Open a thread in the side panel beside the channel. */
  openThread(thread: ThreadInfo): void;
  /** The thread the side panel has open, or null. */
  readonly openThreadId: number | null;
  /** Open or close the channel's thread list under the header's Threads button. */
  toggleThreadList(anchor: HTMLButtonElement): void;
  /** Open the composer's attachment picker (Ctrl+Shift+U). No-op with no composer. */
  openFilePicker(): void;
  /** Open or close the composer's emoji or GIF picker (Ctrl+E, Ctrl+G). */
  togglePicker(kind: "emoji" | "gif"): void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** The header's mark for a DM: the partner's avatar, or a group's face stack. */
function buildDmHeaderAvatar(dm: DmChannel, label: string): HTMLElement {
  if (dm.isGroup) {
    // The row's colour for a group, and a testid of its own so the header's
    // stack never doubles the row's.
    const stack = buildGroupAvatarStack(
      dm.channelId,
      dm.participants,
      label,
      "#5865F2",
      "ch-avatar-stack",
      dm.icon ?? null,
    );
    stack.setAttribute("aria-hidden", "true");
    return stack;
  }
  const member = membersStore.getState().members.get(dm.recipient.id);
  const wrapper = createAvatarElement(
    {
      username: dm.recipient.username,
      displayName: label,
      avatar: member?.avatar ?? dm.recipient.avatar,
    },
    { className: "ch-avatar-circle", background: pickAvatarColor(label) },
  );
  wrapper.setAttribute("aria-hidden", "true");
  return wrapper;
}

/** What the header's avatar is drawn from; equal keys mean the same picture. */
function dmHeaderAvatarKey(dm: DmChannel, label: string): string {
  if (dm.isGroup) {
    return `g|${label}|${dm.icon ?? ""}|${dm.participants.map((p) => `${p.id}:${p.avatar}`).join(",")}`;
  }
  const member = membersStore.getState().members.get(dm.recipient.id);
  return `u|${label}|${dm.recipient.id}|${member?.avatar ?? dm.recipient.avatar}`;
}

function currentMessageUser(): MessageUser | null {
  const u = authStore.getState().user;
  if (u === null) return null;
  return { id: u.id, username: u.username, avatar: u.avatar };
}

/** The message the dialog is about: author and a truncated plain-text
 *  excerpt, both set as text. An attachments-only message shows nothing
 *  extra beyond its author. */
function renderDeletePreview(msg: Message): HTMLElement {
  const author = resolveDisplayName(resolveAuthor(msg.user));
  const plain = Array.from(markdownToPlainText(msg.content, messagingText("spoiler.revealed")));
  const excerpt = plain.slice(0, DELETE_PREVIEW_MAX_CHARS).join("");
  const preview = createElement("div", {
    class: "msg-delete-preview",
    "data-testid": "msg-delete-preview",
  });
  preview.appendChild(createElement("span", { class: "msg-delete-preview-author" }, author));
  if (excerpt !== "") {
    const truncated = plain.length > DELETE_PREVIEW_MAX_CHARS;
    preview.appendChild(
      createElement(
        "span",
        { class: "msg-delete-preview-text" },
        truncated ? `${excerpt}\u2026` : excerpt,
      ),
    );
  } else if (msg.attachments.length > 0) {
    preview.appendChild(
      createElement(
        "span",
        { class: "msg-delete-preview-text" },
        messagingText("reply.attachment"),
      ),
    );
  }
  return preview;
}

/** Stop a queued send's uploads (Delete, teardown, a stale account); the
 *  module's Cancel does the same once it is loaded. */
function abortQueued(entry: QueuedSend): void {
  entry.cancelled = true;
  for (const item of entry.items) item.upload?.owner.destroy();
}

export function createChannelController(opts: ChannelControllerOptions): ChannelController {
  const {
    ws,
    api,
    msgCtrl,
    reactionCtrl,
    typingLimiter,
    showToast,
    getCurrentUserId,
    slots,
    chatHeaderName,
    chatHeaderRefs,
    onContentGated,
    focusFallback,
  } = opts;

  // The thread side panel beside the chat column. It belongs to the
  // mounted channel: a channel switch closes it, and `thread_focus` goes null.
  const threadHost: ThreadPanelHost | null =
    slots.threadSlot === undefined
      ? null
      : createThreadPanelHost({
          ws,
          api,
          msgCtrl,
          slot: slots.threadSlot,
          showToast: (msg, type) => showToast(msg, type),
        });
  let threadList: ThreadListPopover | null = null;

  let currentChannelId: number | null = null;
  let channelAbort: AbortController | null = null;
  const pinsInFlight = new Set<string>();
  let messageList: MessageListComponent | null = null;
  let messageInput: MessageInputComponent | null = null;
  let typingIndicator: MountableComponent | null = null;
  // An NSFW channel's consent UI: the gate mounted instead of its content, or
  // the withdraw bar above content the reader has consented to.
  let nsfwConsentUi: MountableComponent | null = null;
  // Bumped whenever that UI is torn down, so a lazy load that resolves late
  // cannot mount a gate or bar that no longer belongs to the channel.
  let nsfwConsentUiGen = 0;
  // Store/ws subscriptions that keep the composer's disabled state in sync.
  let composerGatingUnsubs: (() => void)[] = [];

  // Unsent composer state per channel, so switching away and back keeps
  // the text, the reply target, the staged upload ids and any upload still in
  // flight (it keeps running in the draft until restored). Controller-scoped
  // (not per-mount) because the whole point is to outlive a channel switch.
  // Entries are dropped once a send consumes them or the user clears them.
  const draftByChannel = new Map<number, ComposerDraft>();

  // 3A-3: the mounted composer's text and reply also go to storage, so they
  // survive a restart. Saved a moment after typing stops, and at once when the
  // draft empties or the channel switches.
  let draftSaveTimer: ReturnType<typeof setTimeout> | null = null;
  // The account the mounted composer belongs to, captured at mount, so a late
  // save never files a draft under whoever is signed in by then.
  let draftOwner: { host: string; userId: number; current: () => boolean } | null = null;
  // What was last written, so an edit (whose peeked draft never changes) does
  // not rewrite storage on every key.
  let lastSavedDraft = "";

  function persistDraft(channelId: number, draft: SavedDraft): void {
    const owner = draftOwner;
    if (owner === null || !(owner.userId > 0) || owner.host === "" || !owner.current()) return;
    const stamp = JSON.stringify([owner.host, owner.userId, channelId, draft]);
    if (stamp === lastSavedDraft) return;
    lastSavedDraft = stamp;
    saveDraft(owner.host, owner.userId, channelId, draft);
  }

  function saveMountedDraft(): void {
    if (draftSaveTimer !== null) {
      clearTimeout(draftSaveTimer);
      draftSaveTimer = null;
    }
    if (messageInput !== null && currentChannelId !== null) {
      persistDraft(currentChannelId, messageInput.peekDraft());
    }
  }

  function scheduleDraftSave(): void {
    if (draftSaveTimer !== null) clearTimeout(draftSaveTimer);
    const draft = messageInput?.peekDraft();
    if (draft !== undefined && draft.content === "" && draft.replyTo === null) {
      saveMountedDraft();
      return;
    }
    draftSaveTimer = setTimeout(saveMountedDraft, DRAFT_SAVE_DELAY_MS);
  }

  /** After a restart there is no in-memory draft, so take the saved one. Its
   *  reply is dropped only when the loaded history shows the target deleted:
   *  history is usually not loaded yet, and the server refuses a reply to a
   *  message that is gone. */
  function restoreSavedDraft(channelId: number, input: MessageInputComponent): void {
    const userId = getCurrentUserId();
    const host = api.getConfig?.().host ?? "";
    if (!(userId > 0) || host === "") return;
    const saved = loadSavedDraft(host, userId, channelId);
    if (saved === null) return;
    const target = saved.replyTo;
    const gone =
      target !== null &&
      getChannelMessages(channelId).some((m) => m.id === target.messageId && m.deleted);
    input.restoreDraft({
      content: saved.content,
      replyTo: gone ? null : target,
      attachments: [],
    });
  }

  // When the last accepted send happened (epoch ms) per channel, so the Send
  // gate's countdown survives a channel switch instead of restarting from zero
  // on the remount. The deadline is derived from the channel's CURRENT
  // slow_mode, so an admin changing it while the user is away is followed.
  // `window` is the largest slow_mode (seconds) observed since the send: the
  // server keeps enforcing its largest window, so a temporary reduction must
  // not forget the send time. Controller-scoped like the drafts above, so it
  // dies with the session; an entry is dropped once its largest window passed.
  const slowModeSentAtByChannel = new Map<number, { sentAt: number; window: number }>();
  const recordSlowModeSend = (id: number, seconds: number, sentAt = Date.now()): void => {
    slowModeSentAtByChannel.set(id, { sentAt, window: seconds });
  };
  // The server prunes its rate-limit timestamps only every few minutes and
  // evaluates the retained ones against the current window, so a raised
  // setting can still reject a send whose largest-observed window has passed.
  const SLOW_MODE_RETENTION_MS = 5 * 60 * 1000;
  const slowModeRetained = (id: number): boolean => {
    const entry = slowModeSentAtByChannel.get(id);
    return (
      entry !== undefined &&
      Date.now() < entry.sentAt + Math.max(entry.window * 1000, SLOW_MODE_RETENTION_MS)
    );
  };
  const slowModeWindowOver = (id: number): boolean => {
    const entry = slowModeSentAtByChannel.get(id);
    return entry === undefined || Date.now() >= entry.sentAt + entry.window * 1000;
  };

  // Optimistic send: keep the raw payload per correlation id so a failed send
  // can be retried (including its attachments). Controller-scoped rather than
  // per-mount: correlation ids are globally unique (crypto.randomUUID), and a
  // failed row survives a channel switch (messages.store carries non-"sent"
  // rows across refetches), so its draft must survive the switch too — a
  // per-mount map left Retry on a failed row that outlived a remount silently
  // inert. Entries are dropped on retry, discard, and the chat_send_ok ack, so
  // controller scope does not turn it into a session-long transcript.
  const draftByCorrelation = new Map<
    string,
    {
      content: string;
      replyTo: number | null;
      // 3A-12: the reply's @ON/@OFF, part of the retry fingerprint, so a
      // retry resends the same value.
      replyPing?: boolean;
      // A sticker send, kept so a retry posts the same sticker.
      sticker?: { readonly id: number; readonly name: string };
      // Each file with its name (and picked File, when there is one), so a
      // file the server did not attach can go back into the composer (2A-3).
      attachments: readonly SentAttachment[];
      // Which channel this cid was actually sent to. chat_send_ok and the
      // SLOW_MODE error are global ws.on subscriptions with no channel_id of
      // their own — a late frame for a send made in a channel the
      // user has since left must not be attributed to whatever channel is
      // mounted when it arrives.
      channelId: number;
      // The account that sent it: a frame for another account's send is ignored.
      userId: number;
      clientMessageId?: string;
      // When the client handed this message to the socket (epoch ms): a late
      // ack's cooldown starts here, not when the ack is finally received.
      sentAt: number;
    }
  >();
  // performSend has two dispatch paths — a plain text send with a
  // client_message_id awaits savePendingText's persistence IPC before it
  // reaches the socket, while a send with a reply or attachment dispatches
  // synchronously. Left unordered, a second send submitted while the first
  // one's persist IPC is still in flight reaches the socket (and the server)
  // first, so the server assigns it the lower message id/timestamp and every
  // client renders the two out of submission order. Routing every send
  // through this one controller-scoped FIFO chain — rather than guarding
  // either branch individually — orders both against each other and against
  // themselves, and survives a channel switch the same way draftByCorrelation
  // does (a send from the channel just left can still be persisting).
  // sendChainBusy/sendChainGen let a send with nothing ahead of it dispatch
  // fully synchronously (as every non-persisting send always has) instead of
  // always taking a microtask detour through the chain: sendChainGen tags
  // each chain entry so its settle handler only clears the busy flag when it
  // is still the last one queued (a later entry may have queued behind it in
  // the meantime).
  let sendChain: Promise<void> = Promise.resolve();
  let sendChainBusy = false;
  let sendChainGen = 0;
  const sendTimers = new Map<string, { timer: number; release?: () => void }>();

  // 3A-9: a message sent with files still uploading waits here, keyed by its
  // "uploading" row's correlation id, and posts once its uploads land. Like
  // draftByCorrelation it is controller-scoped, so the send keeps going (and
  // posts to its own channel) after a channel switch. The queue module is
  // loaded on the first upload, and kept here once it is.
  const queuedSends = new Map<string, QueuedSend>();
  let sendQueueMod: SendQueueModule | null = null;

  // chat_edit and chat_delete are fire-and-forget — no ack carries
  // their envelope id back, so before this they were toasted "success" on
  // send and silently dropped by a closed or half-open socket. Track each
  // frame by the id ws.send returns (the same correlation scheme reactions
  // use), resolve it on the server echo, and report a failure instead of a
  // false success. Controller-scoped like draftByCorrelation so a frame in
  // flight across a channel switch keeps its entry; restoration only lands
  // when that channel is the one mounted.
  interface TrackedEdit {
    readonly channelId: number;
    readonly messageId: number;
    readonly content: string;
  }
  const pendingEdits = new Map<string, TrackedEdit>();
  const pendingDeletes = new Map<string, { channelId: number; messageId: number }>();
  const trackTimers = new Map<string, number>();
  function track<T>(pending: Map<string, T>, id: string, entry: T): void {
    pending.set(id, entry);
    trackTimers.set(
      id,
      window.setTimeout(() => untrack(pending, id), TRACKED_ACTION_EXPIRY_MS),
    );
  }
  /** Remove a tracked entry and its expiry timer; returns the entry, if any. */
  function untrack<T>(pending: Map<string, T>, id: string): T | undefined {
    const entry = pending.get(id);
    pending.delete(id);
    window.clearTimeout(trackTimers.get(id));
    trackTimers.delete(id);
    return entry;
  }

  /** A failure can land long after the save: if the user has moved on to the
   *  composer or another text field, the restored editor must not take focus. */
  function userIsBusyElsewhere(): boolean {
    if (messageInput !== null && !messageInput.isIdle()) return true;
    const active = document.activeElement;
    // The idle composer is where a just-saved edit hands focus back.
    if (active instanceof HTMLElement && active.classList.contains("msg-textarea")) return false;
    return (
      active instanceof HTMLElement &&
      (active instanceof HTMLInputElement ||
        active instanceof HTMLTextAreaElement ||
        active.isContentEditable)
    );
  }

  /** Put a failed edit's text back in its row's inline editor, but only while
   *  its own channel is the mounted one and no other edit is open — the row it
   *  belongs to may be gone by now (startEdit refuses a message that is not
   *  loaded, not yours or not sent), and a list for another channel would
   *  target the wrong message id. At most one edit lands, the newest; the error
   *  toast (when asked for) says the text is back only if it is. */
  function failEdits(edits: readonly TrackedEdit[], toast: boolean): void {
    queueMicrotask(() => {
      const newest = edits.findLast((edit) => edit.channelId === currentChannelId);
      let restored = false;
      if (
        newest !== undefined &&
        messageList !== null &&
        !messageList.isEditing() &&
        messageList.startEdit(newest.messageId, newest.content, { focus: !userIsBusyElsewhere() })
      ) {
        restored = true;
      }
      if (toast) {
        showToast(
          messagingText(restored ? "toast.editFailedRestored" : "toast.editFailed"),
          "error",
        );
      }
    });
  }
  function clearSendTimer(id: string): void {
    const owned = sendTimers.get(id);
    if (!owned) return;
    sendTimers.delete(id);
    window.clearTimeout(owned.timer);
    owned.release?.();
  }

  /** 3A-12: the reply bar shows the display name, and no @ON/@OFF on your own message. */
  function replyTargetOf(msg: {
    readonly id: number;
    readonly user: {
      readonly id: number;
      readonly username: string;
      readonly display_name?: string | null;
    };
    readonly importedAuthor?: ImportedAuthor;
  }): ReplyTarget {
    return {
      messageId: msg.id,
      username:
        msg.importedAuthor !== undefined
          ? importedName(msg.importedAuthor)
          : msg.user.display_name || msg.user.username,
      // An imported author has no one to ping, so the toggle is hidden as for your own message.
      self: msg.importedAuthor !== undefined || msg.user.id === getCurrentUserId(),
    };
  }

  /** 2A-3: give files a send did not carry back to the composer of the
   *  channel it went to, mounted or stashed, with the send's reply target
   *  when given and that composer has none of its own. */
  function putBackUnsent(
    sentTo: number,
    files: readonly SentAttachment[],
    reason: "skipped" | "unavailable",
    replyTo: number | null = null,
    ping?: boolean,
  ): void {
    const target =
      replyTo === null
        ? undefined
        : getChannelMessages(sentTo).find((m) => m.id === replyTo && !m.deleted);
    const reply = target === undefined ? null : { ...replyTargetOf(target), ping };
    if (sentTo === currentChannelId && messageInput !== null) {
      messageInput.restoreUnsent(files, reason, reply);
      scheduleDraftSave();
      return;
    }
    const stashed = draftByChannel.get(sentTo);
    draftByChannel.set(sentTo, {
      content: stashed?.content ?? "",
      replyTo: stashed?.replyTo ?? reply,
      attachments: [
        ...(stashed?.attachments ?? []),
        ...files.map((f) => ({ ...f, uploadedAt: 0, unsent: true })),
      ],
      ...(stashed?.uploads === undefined ? {} : { uploads: stashed.uploads }),
    });
  }

  function destroyChannel(): void {
    threadList?.close();
    threadHost?.close();
    // The reaction picker is a body-mounted overlay keyed to a message in
    // this channel — every other teardown path already routes through here,
    // so this is the one choke point to close it before the channel it was
    // opened against goes away. destroy() is idempotent (closePicker
    // null-checks), so it is safe even when no picker is open.
    reactionCtrl.destroy();

    for (const unsub of composerGatingUnsubs) unsub();
    composerGatingUnsubs = [];

    if (channelAbort !== null) {
      channelAbort.abort();
      channelAbort = null;
    }

    nsfwConsentUiGen++;
    if (nsfwConsentUi !== null) {
      nsfwConsentUi.destroy?.();
      nsfwConsentUi = null;
    }
    if (messageList !== null) {
      messageList.destroy?.();
      messageList = null;
    }
    if (typingIndicator !== null) {
      typingIndicator.destroy?.();
      typingIndicator = null;
    }
    if (messageInput !== null) {
      saveMountedDraft();
      // Stash the unsent state before the composer is torn down. Empty
      // drafts are not stored, so switching away from a channel with nothing
      // typed leaves no entry behind.
      if (currentChannelId !== null) {
        const draft = messageInput.getDraft();
        if (
          draft.content !== "" ||
          draft.replyTo !== null ||
          draft.attachments.length > 0 ||
          (draft.uploads?.length ?? 0) > 0
        ) {
          draftByChannel.set(currentChannelId, draft);
        } else {
          draftByChannel.delete(currentChannelId);
        }
      }
      messageInput.destroy?.();
      messageInput = null;
    }
    clearChildren(slots.messagesSlot);
    clearChildren(slots.typingSlot);
    clearChildren(slots.inputSlot);

    // The server only delivers live broadcasts for the focused channel, so
    // the window being torn down here stops updating the moment it does.
    // Every teardown path routes through this one choke point (bare
    // destroyChannel() calls from the NSFW gate's "Go Back" and a resync's
    // setActiveChannel(null), as well as mountChannel's channel-to-channel
    // switch), so invalidating here — rather than only in mountChannel's
    // previousChannelId branch — covers all of them: without it, a bare
    // destroyChannel() leaves the torn-down channel's "loaded" flag set and
    // the next visit renders its pre-teardown snapshot as current.
    // Idempotent (no-ops once the flag is already gone), so this is safe
    // alongside mountChannel's existing invalidate of previousChannelId.
    if (currentChannelId !== null) invalidateChannelMessageWindow(currentChannelId);
    // reaction_update stops arriving too, so a cached who-reacted list could
    // be stale by the next visit.
    clearReactionUsersCache();
    currentChannelId = null;
  }

  function mountChannel(
    channelId: number,
    channelName: string,
    channelType?: ChannelType,
    focusGate = true,
  ): void {
    if (currentChannelId === channelId) return;

    const previousChannelId = currentChannelId;
    destroyChannel();
    currentChannelId = channelId;
    // channel_focus (sent below) is the only thing that advances the *new*
    // channel's server-side read state; leaving one never does. Without this,
    // messages read while focused here restate as unread/mention badges on
    // the next full `ready`. mark_read is a local no-op (already zeroed on
    // open) — it only repairs the server's view. With a read pointer, leaving
    // marks only what the reader saw (leaveChannel), never "everything".
    // A forum holds no messages, so it has no read state to repair.
    const leftForum =
      channelsStore.getState().channels.get(previousChannelId ?? 0)?.type === "forum";
    if (previousChannelId !== null && !leftForum) {
      if (readPointerEnabled()) leaveChannel(previousChannelId);
      else markChannelRead(previousChannelId);
      // The server only delivers live broadcasts for the focused channel, so
      // the window being left stops updating the moment focus moves here.
      // Drop its loaded flag so the next visit refetches the live tail
      // instead of rendering the old snapshot as current — setMessages'
      // merge preserves any pending/failed rows across that refetch.
      invalidateChannelMessageWindow(previousChannelId);
    }

    log.info("Switching channel", { channelId, channelName });

    // The channel is actually on screen now, so this is where its
    // badge is cleared and it is recorded as the last channel (the ready-time
    // auto-select only selected it), alongside the channel_focus.
    viewChannel(channelId, channelType, ws);

    channelAbort = new AbortController();
    const signal = channelAbort.signal;
    const userId = getCurrentUserId();
    const owner = { host: api.getConfig?.().host ?? "", userId };
    const session = api.getSession?.();
    const ownsAccountSession = (): boolean =>
      (session === undefined || session.isCurrent()) &&
      getCurrentUserId() === owner.userId &&
      (api.getConfig?.().host ?? "") === owner.host;
    const ownsSession = (): boolean => !signal.aborted && ownsAccountSession();
    draftOwner = { ...owner, current: ownsAccountSession };

    /**
     * Mount the gate or the withdraw bar. Their module (with its catalog) is
     * loaded on first use so only a labelled channel pays for it (B9 shared
     * MainPage budget); the gated path mounts no content while it loads.
     */
    function mountConsentUi(
      build: (ui: typeof import("@components/NsfwGate")) => MountableComponent,
    ): void {
      const gen = ++nsfwConsentUiGen;
      import("@components/NsfwGate").then(
        (ui) => {
          if (signal.aborted || gen !== nsfwConsentUiGen) return;
          nsfwConsentUi = build(ui);
          nsfwConsentUi.mount(slots.messagesSlot);
        },
        (err: unknown) =>
          log.error("NSFW consent UI failed to load", { channelId, error: String(err) }),
      );
    }

    function mountConsentBar(): void {
      mountConsentUi((ui) =>
        ui.createNsfwConsentBar({
          onRevoke: () =>
            api.revokeNsfw(channelId).then(
              () => {
                if (ownsAccountSession()) setNsfwAcknowledged(channelId, false);
              },
              (err: unknown) => {
                log.error("NSFW consent revoke failed", { channelId, error: String(err) });
                if (ownsSession()) showToast(ui.nsfwConsentText("bar.revokeFailed"), "error");
              },
            ),
        }),
      );
    }

    /** Mirrors onJumpToPresent — reattach clears "loaded" so the tail is refetched. */
    function jumpToPresentForSend(): void {
      reattachToPresent(channelId);
      // While detached, this (already-active) channel could have
      // picked up an unread/mention badge for messages that arrived below
      // the gap (dispatcher.ts's evenIfActive path) — nothing else clears
      // it, since incrementUnread's usual "active channel" skip is exactly
      // what a detached window opts out of. Jumping to present is reading
      // it, so mark it read the same way leaving a channel does. With a read
      // pointer that is what was seen, not everything.
      if (readPointerEnabled()) markChannelReadSeen(channelId);
      else markChannelRead(channelId);
      void msgCtrl.loadMessages(channelId, signal);
    }

    /** A reply whose target was deleted while composing sends as a plain message. */
    function liveReplyTo(replyTo: number | null): number | null {
      const target =
        replyTo === null ? undefined : getChannelMessages(channelId).find((m) => m.id === replyTo);
      return target?.deleted === true ? null : replyTo;
    }

    // 3A-9: the queue's hooks into this mount. Built here, so a send queued in
    // this channel posts, fails and puts files back for this channel even after
    // the user has switched away.
    function queueDeps(entry: QueuedSend): QueueDeps {
      const live = (): boolean => queuedSends.get(entry.cid) === entry && ownsAccountSession();
      return {
        upload: uploadFile,
        putBack: (files) => {
          if (live()) putBackUnsent(entry.channelId, files, "skipped");
        },
        // The server refuses a send inside the channel's slow-mode window, so wait it out.
        // Like the composer gate: the channel's current slow_mode, none for moderators.
        slowWindow: () => {
          const sent = slowModeSentAtByChannel.get(entry.channelId);
          if (sent === undefined || canManageMessages()) return undefined;
          const window = channelsStore.getState().channels.get(entry.channelId)?.slowMode ?? 0;
          return { sentAt: sent.sentAt, window };
        },
        fail: (code) => {
          if (live()) markSendFailed(entry.cid, code);
        },
        dispatch: (files) => {
          if (queuedSends.get(entry.cid) !== entry) return;
          queuedSends.delete(entry.cid);
          // Remove and add run in this one task, so no frame shows the gap.
          removeOptimistic(entry.cid);
          // Everything went back to the composer and there is no text: nothing to post.
          if (files.length === 0 && entry.content === "") return;
          const reply = liveReplyTo(entry.replyTo);
          performSend(entry.content, reply, files, undefined, reply !== null && entry.replyPing, {
            queued: true,
          });
        },
      };
    }

    /** Show `entry` as an "uploading" row and run it; on Retry it replaces the
     *  failed row under a new id. The entry stays under its old id until the
     *  module has loaded, so a Delete in that window still finds it. Waits for
     *  the lazy module, which the first upload preloaded. A failed entry whose
     *  row vanishes without Delete stays in `queuedSends`, holding its Files,
     *  until teardown. */
    function startQueued(entry: QueuedSend, retry: boolean): void {
      // A failed load is already logged by the loader's preload.
      void loadSendQueue()
        .catch(() => null)
        .then((mod) => {
          if (queuedSends.get(entry.cid) !== entry) return;
          const user = currentMessageUser();
          if (user === null || !ownsAccountSession()) {
            // Another account's send: nothing may post or keep uploading.
            abortQueued(entry);
            queuedSends.delete(entry.cid);
            return;
          }
          if (retry) {
            // A second Retry click in the window finds it no longer failed.
            if (entry.failed !== true) return;
            queuedSends.delete(entry.cid);
            removeOptimistic(entry.cid);
            entry.cid = crypto.randomUUID();
            queuedSends.set(entry.cid, entry);
          }
          // The strip reads this when the row first renders: Cancel only while it runs.
          entry.failed = false;
          if (isWindowDetached(channelId) && !signal.aborted) jumpToPresentForSend();
          // Set first, so a render during the add can draw the strip.
          if (mod !== null) sendQueueMod = mod;
          addOptimisticMessage({
            correlationId: entry.cid,
            channelId,
            user,
            content: entry.content,
            replyTo: entry.replyTo,
            timestamp: new Date().toISOString(),
            status: "uploading",
          });
          if (mod === null) {
            // The uploads keep going; the text is on the row, and Retry loads again.
            entry.failed = true;
            markSendFailed(entry.cid, "UPLOAD_FAILED");
            return;
          }
          void (retry ? mod.retryQueuedSend : mod.runQueuedSend)(entry, queueDeps(entry));
        });
    }

    function enqueueSend(
      content: string,
      replyTo: number | null,
      replyPing: boolean,
      queued: readonly QueuedAttachment[],
    ): void {
      const entry: QueuedSend = {
        cid: crypto.randomUUID(),
        channelId,
        userId: owner.userId,
        content,
        replyTo,
        replyPing,
        items: queued.map((q) => ({ ...q })),
      };
      queuedSends.set(entry.cid, entry);
      startQueued(entry, false);
    }

    /** The file upload, shared by the composer and a queued send's re-uploads. */
    const uploadFile = async (
      file: File,
      uploadSignal?: AbortSignal,
      onProgress?: (fraction: number) => void,
      voice?: VoiceUploadMeta,
    ): Promise<{ id: string; url: string; filename: string }> => {
      // The first upload loads the queue module, so a send queued while it runs finds it ready.
      preloadSendQueue();
      try {
        const result = await api.uploadFile(file, uploadSignal, onProgress, voice);
        return { id: result.id, url: result.url, filename: result.filename };
      } catch (err) {
        // A user-cancelled upload is not a failure — the composer already
        // removed its preview and does not want an error for it. A real
        // failure is reported once, inline, by the composer from this
        // rejection, so it is not toasted here too.
        if (!uploadSignal?.aborted) log.error("File upload failed", { error: String(err) });
        throw err;
      }
    };

    function performSend(
      content: string,
      replyTo: number | null,
      files: readonly SentAttachment[],
      existingClientMessageId?: string,
      replyPing = false,
      sendOptions: {
        readonly queued?: boolean;
        readonly sticker?: { readonly id: number; readonly name: string };
      } = {},
    ): void {
      const sticker = sendOptions.sticker;
      const attachments = files.map((f) => f.id);
      const user = currentMessageUser();
      // A queued send (3A-9) was built by this mount but may post after the
      // user left the channel: it needs the account, not the mount.
      const owns = sendOptions.queued === true ? ownsAccountSession : ownsSession;
      if (user === null || !owns()) return;
      // Sending while viewing a detached history window jumps to present: the
      // optimistic row belongs in the live tail, and addMessage would refuse
      // to append the echo into a detached window anyway. A queued send that
      // outlived this mount leaves it, since that window is no longer shown.
      if (isWindowDetached(channelId) && !signal.aborted) jumpToPresentForSend();
      const timestamp = new Date().toISOString();
      const clientMessageId =
        existingClientMessageId ??
        (supportsMessageDeduplication(owner)
          ? newClientMessageId(pendingMessageRetryFloor(owner))
          : undefined);
      // Set only for a send with a recoverable logical identity: plain text
      // with a client_message_id, no reply and no attachments.
      const persistId =
        replyTo === null && attachments.length === 0 && sticker === undefined
          ? clientMessageId
          : undefined;
      // A sticker send commits with its receipt, so the server requires the id.
      if (sticker !== undefined && clientMessageId === undefined) {
        if (owns()) showToast(stickersText("send.unsupported"), "error");
        return;
      }
      // The optimistic row's text is the server's fallback for the sticker.
      const rowContent = sticker === undefined ? content : `[Sticker: ${sticker.name}]`;
      const live = sticker === undefined ? null : findSticker(sticker.id);
      const rowSticker =
        live === null ? undefined : { id: live.id, name: live.name, url: live.url };
      const rowFields = {
        content: rowContent,
        ...(rowSticker === undefined ? {} : { sticker: rowSticker }),
      };
      const draftSticker = sticker === undefined ? {} : { sticker };
      /** Persist before handing text to the socket, so a process crash after
       *  commit but before ACK can recover the same logical identity. Resolves
       *  false when the write did not land: callers that send regardless only
       *  need the toast, but the offline branch has nothing else carrying the
       *  text and must say so on the row. */
      function persistPendingText(id: string): Promise<boolean> {
        return savePendingText(owner, {
          clientMessageId: id,
          channelId,
          content,
          createdAt: Number(id.split(":", 1)[0]),
        }).then(
          () => true,
          () => {
            if (owns()) showToast(messagingText("toast.pendingSaveFailed"), "error");
            return false;
          },
        );
      }
      if (uiStore.getState().connectionStatus !== "connected") {
        // Composer gating normally prevents this, but stay consistent: show a
        // failed row with retry rather than silently dropping the message.
        const cid = crypto.randomUUID();
        addOptimisticMessage({
          correlationId: cid,
          clientMessageId,
          channelId,
          user,
          ...rowFields,
          replyTo,
          timestamp,
        });
        draftByCorrelation.set(cid, {
          content,
          ...draftSticker,
          replyTo,
          ...(replyTo === null ? {} : { replyPing }),
          attachments: files,
          channelId,
          userId: owner.userId,
          clientMessageId,
          sentAt: Date.now(),
        });
        markSendFailed(cid, "OFFLINE");
        if (persistId !== undefined) {
          // Nothing will deliver this text: it was never handed to a socket, so
          // a failed write means it is gone at restart. Distinguish that from a
          // plain offline row, whose retry window is still open.
          void persistPendingText(persistId).then((saved) => {
            if (!saved && owns()) markSendFailed(cid, "OFFLINE_NO_RECOVERY");
          });
        }
        return;
      }
      const sendNow = (): void => {
        if (!ownsAccountSession()) return;
        const cid = ws.send({
          type: "chat_send",
          payload: {
            channel_id: channelId,
            content: sticker === undefined ? content : "",
            ...(sticker === undefined ? {} : { sticker_id: sticker.id }),
            reply_to: replyTo,
            ...(replyTo === null ? {} : { reply_ping: replyPing }),
            attachments,
            ...(clientMessageId ? { client_message_id: clientMessageId } : {}),
          },
        });
        addOptimisticMessage({
          correlationId: cid,
          clientMessageId,
          channelId,
          user,
          ...rowFields,
          replyTo,
          timestamp,
        });
        draftByCorrelation.set(cid, {
          content,
          ...draftSticker,
          replyTo,
          ...(replyTo === null ? {} : { replyPing }),
          attachments: files,
          channelId,
          userId: owner.userId,
          clientMessageId,
          sentAt: Date.now(),
        });
        // A live socket can lose an ACK without disconnecting. End the spinner
        // honestly; only a server ACK/echo ever calls a message delivered.
        const timer = window.setTimeout(() => {
          clearSendTimer(cid);
          if (
            (session === undefined || session.isCurrent()) &&
            getCurrentUserId() === owner.userId
          ) {
            markSendFailed(cid, "UNCONFIRMED");
          }
        }, 20_000);
        sendTimers.set(cid, { timer, release: session?.addCleanup(() => clearSendTimer(cid)) });
      };
      // Both branches go through the single controller-scoped
      // sendChain so a synchronous reply/attachment send can never jump a
      // plain-text send whose persistPendingText IPC is still in flight — and
      // vice versa. Without this, only guarding the branch a given finding
      // named would still leave the two branches racing each other. When
      // nothing is already in flight and this send needs no persistence,
      // dispatch stays fully synchronous — unchanged from before, and relied
      // on by every caller (e.g. a same-tick read of ws.send's return value).
      if (persistId === undefined && !sendChainBusy) {
        sendNow();
        return;
      }
      sendChainBusy = true;
      const myGen = ++sendChainGen;
      sendChain = sendChain
        .then(() => (persistId === undefined ? undefined : persistPendingText(persistId)))
        .then(() => {
          sendNow();
          // Only the still-last-queued entry may clear the flag — a newer
          // send may have queued behind this one while it was persisting.
          if (sendChainGen === myGen) sendChainBusy = false;
        });
    }

    function retrySend(correlationId: string): void {
      if (!ownsSession()) return;
      const queued = queuedSends.get(correlationId);
      if (queued !== undefined) {
        // 3A-9: a failed queued send uploads what it lacks and posts again, as
        // a new row under a new id.
        if (queued.channelId !== channelId) return;
        startQueued(queued, true);
        return;
      }
      const recovered = recoveredPendingText(owner, correlationId);
      const draft =
        draftByCorrelation.get(correlationId) ??
        (recovered
          ? {
              ...recovered,
              userId: owner.userId,
              replyTo: null,
              replyPing: false,
              attachments: [] as readonly SentAttachment[],
            }
          : undefined);
      if (draft === undefined || draft.channelId !== channelId) return;
      if (
        draft.clientMessageId &&
        pendingMessageExpired(draft.clientMessageId, Date.now(), pendingMessageRetryFloor(owner))
      ) {
        showToast(messagingText("toast.retryExpired"), "error");
        return;
      }
      if (draft.clientMessageId && !supportsMessageDeduplication(owner)) {
        showToast(messagingText("toast.retryUnsupported"), "error");
        return;
      }
      // A refused reply may point at a message deleted outside the loaded
      // window. Nothing was stored, so it goes again as a plain message under
      // a fresh id.
      const refusedReply =
        draft.replyTo !== null &&
        getChannelMessages(channelId).find((m) => m.correlationId === correlationId)?.errorCode ===
          WsErrorCode.BAD_REQUEST;
      draftByCorrelation.delete(correlationId);
      clearSendTimer(correlationId);
      removeOptimistic(correlationId);
      const retrySticker = "sticker" in draft ? draft.sticker : undefined;
      const stickerOpts = retrySticker === undefined ? {} : { sticker: retrySticker };
      if (refusedReply) {
        performSend(draft.content, null, draft.attachments, undefined, false, stickerOpts);
        return;
      }
      performSend(
        draft.content,
        draft.replyTo,
        draft.attachments,
        draft.clientMessageId,
        draft.replyPing === true,
        stickerOpts,
      );
    }

    /** Withdraw a stored upload that will never be sent; the server sweeps it anyway if this fails. */
    function discardQuietly(id: string): void {
      void api.discardUpload(id).catch(() => {});
    }

    function deleteDraft(correlationId: string): void {
      if (!ownsSession()) return;
      const queued = queuedSends.get(correlationId);
      if (queued !== undefined) {
        // 3A-9: stop its uploads and withdraw the ones already stored.
        abortQueued(queued);
        for (const item of queued.items) {
          if (item.id !== undefined) discardQuietly(item.id);
        }
        queuedSends.delete(correlationId);
        removeOptimistic(correlationId);
        return;
      }
      const id =
        draftByCorrelation.get(correlationId)?.clientMessageId ??
        recoveredPendingText(owner, correlationId)?.clientMessageId;
      acknowledgePendingMessage(id);
      draftByCorrelation.delete(correlationId);
      clearSendTimer(correlationId);
      removeOptimistic(correlationId);
    }

    // Block gating is a 1:1 rule (Discord semantics, mirrored by the server's
    // requireDMNotBlocked): a group DM is a shared room, and gating one
    // member's composer over a block with one other member would leave the
    // group reading a conversation that person cannot join.
    const gatedDm =
      channelType === "dm"
        ? dmStore.getState().channels.find((c) => c.channelId === channelId)
        : undefined;
    const dmRecipientId = gatedDm !== undefined && !gatedDm.isGroup ? gatedDm.recipient.id : null;

    // Update header
    if (chatHeaderRefs !== null && channelType === "dm") {
      // Presence changes re-run this; the picture only needs rebuilding when
      // what it is drawn from changed, or it would flicker on every update.
      let headerAvatar: { key: string; el: HTMLElement } | null = null;
      const refreshDmHeader = (): void => {
        const dmChannel = dmStore.getState().channels.find((c) => c.channelId === channelId);
        // A group has no single presence to show, so the subtitle lists who is
        // in it instead — that is the fact a group header is asked for, and a
        // first member's status presented as the group's would be a lie.
        let subtitle = shellText("status.offline");
        if (dmChannel !== undefined && dmChannel.isGroup) {
          const names = dmChannel.participants.map((p) => (p.displayName ?? "") || p.username);
          subtitle = requestsText("dm.groupSubtitle", {
            count: String(names.length + 1),
            names: names.join(", "),
          });
        } else if (dmChannel !== undefined) {
          const member = membersStore.getState().members.get(dmChannel.recipient.id);
          subtitle = statusLabel(member?.status ?? dmChannel.recipient.status ?? "offline");
        }
        const headerName = dmChannel !== undefined ? dmDisplayName(dmChannel) : channelName;
        updateChatHeaderForDm(chatHeaderRefs, {
          username: headerName,
          status: subtitle,
          avatar: ((): HTMLElement | null => {
            if (dmChannel === undefined) return null;
            const key = dmHeaderAvatarKey(dmChannel, headerName);
            if (headerAvatar === null || headerAvatar.key !== key) {
              headerAvatar = { key, el: buildDmHeaderAvatar(dmChannel, headerName) };
            }
            return headerAvatar.el;
          })(),
          isGroup: dmChannel?.isGroup === true,
        });
        // Both are clickable: a 1:1 name opens the profile panel and a group
        // name renames the group.
        chatHeaderRefs.nameGroupEl.style.cursor = "pointer";
      };
      refreshDmHeader();
      // Keep the subtitle live across presence and roster changes — otherwise
      // it is set once from a snapshot and never updated until the channel is
      // re-mounted, same as the topic subscription below does for text
      // channels. destroyChannel already tears these down.
      if (dmRecipientId !== null) {
        composerGatingUnsubs.push(
          membersStore.subscribeSelector(
            (s) => s.members.get(dmRecipientId)?.status,
            refreshDmHeader,
          ),
        );
      }
      composerGatingUnsubs.push(
        dmStore.subscribeSelector(
          (s) => s.channels.find((c) => c.channelId === channelId),
          refreshDmHeader,
        ),
      );
    } else if (chatHeaderRefs !== null) {
      updateChatHeaderForDm(chatHeaderRefs, null);
      const typeRefs = chatHeaderRefs;
      const typeOf = (): ChannelType | undefined =>
        channelsStore.getState().channels.get(channelId)?.type ?? channelType;
      const syncHeaderType = (): void => {
        setChatHeaderChannelType(typeRefs, typeOf());
        setChatHeaderThreads(typeRefs, typeOf() === "text" && threadsEnabled());
        const type = typeOf();
        setChatHeaderMedia(
          typeRefs,
          (type === "text" || type === "announcement") && channelMediaEnabled(),
        );
      };
      syncHeaderType();
      composerGatingUnsubs.push(
        channelsStore.subscribeSelector((s) => s.channels.get(channelId)?.type, syncHeaderType),
      );
      if (chatHeaderName !== null) {
        setText(chatHeaderName, channelName);
        // Keep the header name live across channel_update events (a rename),
        // same as the topic subscription right below — otherwise it is set
        // once from the mount-time snapshot and disagrees with the sidebar
        // row (which does re-render off the live store) until the channel is
        // remounted.
        const nameEl = chatHeaderName;
        composerGatingUnsubs.push(
          channelsStore.subscribeSelector(
            (s) => s.channels.get(channelId)?.name ?? channelName,
            (name) => setText(nameEl, name),
          ),
        );
      }
      // Show the channel topic and keep it live across channel_update events.
      const topicRefs = chatHeaderRefs;
      setChatHeaderTopic(
        chatHeaderRefs,
        channelsStore.getState().channels.get(channelId)?.topic ?? "",
      );
      composerGatingUnsubs.push(
        channelsStore.subscribeSelector(
          (s) => s.channels.get(channelId)?.topic ?? "",
          (topic) => setChatHeaderTopic(topicRefs, topic),
        ),
      );
    } else if (chatHeaderName !== null) {
      setText(chatHeaderName, channelName);
    }

    // NSFW consent gates composition, not just display: until the
    // server has confirmed this account's acknowledgement, the channel's
    // content is neither mounted nor fetched, and any rows left from before
    // consent was withdrawn are dropped. Any change that crosses the gate —
    // accepted here, revoked here or on another device, relabelled, or
    // restated by a reconnect's ready — remounts the channel on the other
    // side of it; labelling or unlabelling consented content only adds or
    // removes the withdraw bar, so the composer keeps its draft.
    const storedChannel = channelsStore.getState().channels.get(channelId);
    const gated = nsfwConsentRequired(storedChannel);
    composerGatingUnsubs.push(
      channelsStore.subscribeSelector(
        (s) => {
          const ch = s.channels.get(channelId);
          if (ch?.nsfw !== true) return "none";
          return nsfwConsentRequired(ch) ? "gated" : "consented";
        },
        (state) => {
          if (currentChannelId !== channelId) return;
          if ((state === "gated") === gated) {
            nsfwConsentUiGen++;
            nsfwConsentUi?.destroy?.();
            nsfwConsentUi = null;
            if (state === "consented") mountConsentBar();
            return;
          }
          // A remount caused elsewhere (another device, a moderator, a
          // reconnect) takes focus only from the content it replaces, never
          // from an open dialog or another part of the app.
          const active = document.activeElement;
          const gateHadFocus = [slots.messagesSlot, slots.typingSlot, slots.inputSlot].some(
            (slot) => slot.contains(active),
          );
          const takeFocus = gateHadFocus || active === null || active === document.body;
          const name = channelsStore.getState().channels.get(channelId)?.name ?? channelName;
          destroyChannel();
          mountChannel(channelId, name, channelType, takeFocus);
          if (state === "gated") onContentGated?.();
          else if (gateHadFocus) focusFallback?.();
        },
      ),
    );
    if (gated) {
      clearChannelContent(channelId);
      mountConsentUi((ui) =>
        ui.createNsfwGate({
          channelName,
          focusOnMount: focusGate,
          onAccept: () =>
            api.acknowledgeNsfw(channelId).then(() => {
              if (ownsAccountSession()) setNsfwAcknowledged(channelId, true);
            }),
          onCancel: () => {
            // Leave the channel entirely: keeping the gate up over a channel the
            // reader declined would strand them on a screen with no way out that
            // is not also "continue".
            destroyChannel();
            setActiveChannel(null);
            focusFallback?.();
          },
        }),
      );
      return;
    }

    // A forum shows its post list in place of the message list, and has no
    // typing row or composer. A post opens in the thread panel.
    if ((storedChannel?.type ?? channelType) === "forum") {
      const forum = NAVIGATION_DESTINATIONS.forum;
      if (forum === undefined) return;
      slots.messagesSlot.appendChild(
        forum.build({
          channelId,
          signal,
          api,
          ws,
          openPost: (threadId) =>
            threadHost?.openById(
              threadId,
              channelId,
              signal,
              () =>
                // The post's row, or the New Post button once the row is gone.
                slots.messagesSlot.querySelector<HTMLElement>(`[data-post-id="${threadId}"]`) ??
                slots.messagesSlot.querySelector<HTMLElement>('[data-testid="forum-new-post"]'),
            ),
          avatar: (subject, className) =>
            createAvatarElement(subject, {
              className,
              background: pickAvatarColor(subject.username),
              decorative: true,
              deferUntilVisible: true,
            }),
        }),
      );
      if (storedChannel?.nsfw === true) mountConsentBar();
      // A followed post's sidebar row asked for this forum: open the post now.
      settleThreadNavigation(channelId);
      return;
    }

    void msgCtrl.loadMessages(channelId, signal);

    /** Send the delete frame. A destructive menu action is gated on
     *  the connection; a closed or half-open socket would drop the frame and
     *  leave the moderator thinking the message was deleted. */
    function sendDelete(msgId: number): void {
      if (uiStore.getState().connectionStatus !== "connected") {
        showToast(messagingText("toast.deleteFailed"), "error");
        return;
      }
      const id = ws.send({
        type: "chat_delete",
        payload: { message_id: msgId },
      });
      track(pendingDeletes, id, { channelId, messageId: msgId });
    }

    /** The destructive delete confirm, on the shared confirm preset
     *  (features/dialogs/confirmModal.ts): Cancel first and focused, Escape and the backdrop
     *  cancel, focus returns to the opener. Tied to the mounted channel's
     *  signal, so a switch or destroy closes it. */
    /** `onConfirm` runs just before the delete is sent. */
    function openDeleteConfirm(
      msgId: number,
      flow: { readonly onConfirm?: () => void; readonly clicked: boolean },
    ): void {
      const body: Node[] = [
        createElement("p", { class: "modal-danger-text" }, messagingText("delete.body")),
      ];
      const target = getChannelMessages(channelId).find((m) => m.id === msgId);
      if (target !== undefined) body.push(renderDeletePreview(target));
      // The tip is about the Delete click, so it is left out when no click
      // opened this (an emptied edit).
      if (flow.clicked) {
        body.push(
          createElement(
            "p",
            { class: "msg-delete-tip", "data-testid": "msg-delete-tip" },
            messagingText("delete.shiftTip"),
          ),
        );
      }
      createConfirmModal({
        title: messagingText("delete.title"),
        titleId: `msg-delete-title-${msgId}`,
        body,
        confirmLabel: messagingText("delete.confirm"),
        testId: "msg-delete-modal",
        confirmTestId: "msg-delete-confirm",
        cancelTestId: "msg-delete-cancel",
        signal,
        onConfirm: () => {
          flow.onConfirm?.();
          sendDelete(msgId);
        },
      });
    }

    // Bound before any message renders so GIFs in messages get their star.
    bindGifFavoritesApi(api);
    setInlineImageDecorator(gifFavoriteStar);

    // MessageList
    messageList = createMessageList({
      channelId,
      channelName,
      channelType,
      currentUserId: userId,
      ...(opts.onJoinCall !== undefined && { onJoinCall: opts.onJoinCall }),
      ...(opts.onOpenPins !== undefined && { onOpenPins: opts.onOpenPins }),
      onScrollTop: () => {
        if (channelAbort !== null) {
          return msgCtrl.loadOlderMessages(channelId, channelAbort.signal);
        }
        return undefined;
      },
      onScrollBottom: () => {
        if (channelAbort !== null) {
          return msgCtrl.loadNewerMessages(channelId, channelAbort.signal);
        }
        return undefined;
      },
      onRetryLoad: () => {
        if (channelAbort !== null) {
          void msgCtrl.loadMessages(channelId, channelAbort.signal);
        }
      },
      // A reply bar (and any other in-row jump) goes through the same jumper
      // as search hits and permalinks, so an out-of-window target fetches its
      // around-window instead of silently doing nothing.
      onJumpToMessage: (msgId: number) => {
        jumpToMessage(channelId, msgId);
      },
      onJumpToPresent: () => {
        // Dropping the detached flag also clears "loaded", so loadMessages
        // refetches the live tail instead of short-circuiting.
        reattachToPresent(channelId);
        // See performSend's identical call above — a detached
        // active channel's badge (from dispatcher.ts's evenIfActive path)
        // must be cleared here too, or it lingers after the user has jumped
        // back to present and is looking straight at the live tail.
        markChannelRead(channelId);
        if (channelAbort !== null) {
          void msgCtrl.loadMessages(channelId, channelAbort.signal);
        }
      },
      // The Wave button of a welcome row: an ordinary 👋 message sent as
      // a reply to the join row through the normal send path.
      onWave: (msgId: number): boolean => {
        const target = liveReplyTo(msgId);
        if (target === null) return false;
        performSend(WAVE_CONTENT, target, []);
        return true;
      },
      onReplyClick: (msgId: number) => {
        const msgs = getChannelMessages(channelId);
        const msg = msgs.find((m) => m.id === msgId);
        if (msg === undefined) messageInput?.setReplyTo(msgId, "");
        else {
          const { messageId, username, ...replyOpts } = replyTargetOf(msg);
          messageInput?.setReplyTo(messageId, username, replyOpts);
        }
      },
      onEditClick: (msgId: number) => {
        messageList?.startEdit(msgId);
      },
      onEditSave: (messageId: number, content: string): boolean => {
        const msgs = getChannelMessages(channelId);
        const original = msgs.find((m) => m.id === messageId);
        if (original !== undefined && original.content === content) {
          return true;
        }
        // Same connection gate as delete. A dropped edit frame must
        // not look saved — the row would keep its old text, and the user
        // would never know to try again. The editor stays open with the text.
        if (uiStore.getState().connectionStatus !== "connected") {
          showToast(messagingText("toast.editFailed"), "error");
          return false;
        }
        const id = ws.send({
          type: "chat_edit",
          payload: { message_id: messageId, content },
        });
        track(pendingEdits, id, { channelId, messageId, content });
        return true;
      },
      // Discord's flow: clearing an edit and pressing Save asks to delete the
      // message. Cancel leaves the editor open; Delete closes it first.
      onEmptyEdit: (messageId: number) => {
        openDeleteConfirm(messageId, {
          onConfirm: () => {
            messageList?.cancelEdit();
            // The modal handed focus back to the editor that is now gone.
            messageInput?.focus();
          },
          clicked: false,
        });
      },
      onEditEnd: () => messageInput?.focus(),
      onDeleteClick: (msgId: number, shiftKey: boolean) => {
        // Shift-click skips the prompt, as Discord's delete confirm does.
        // A plain click opens a confirm.
        if (!shiftKey) {
          openDeleteConfirm(msgId, { clicked: true });
          return;
        }
        sendDelete(msgId);
      },
      onReactionClick: (msgId: number, emoji: string) => {
        reactionCtrl.handleReaction(msgId, emoji);
      },
      onPinClick: (msgId: number, chId: number, currentlyPinned: boolean) => {
        // One request per message at a time: a second click while one is
        // pending would race its revert against the first.
        const flightKey = `${chId}:${msgId}`;
        if (pinsInFlight.has(flightKey)) return;
        pinsInFlight.add(flightKey);
        // Optimistic: the row flips now and snaps back if the server refuses,
        // so the control answers the click instead of waiting on the round trip.
        setMessagePinned(chId, msgId, !currentlyPinned);
        const revisionAfterFlip = messagesStore.getState().messagePinRevision?.get(msgId);
        const action = currentlyPinned
          ? api.unpinMessage(chId, msgId)
          : api.pinMessage(chId, msgId);
        action
          .then(() => {
            showToast(
              currentlyPinned ? messagingText("toast.unpinned") : messagingText("toast.pinned"),
              "success",
            );
          })
          .catch((err) => {
            // A moved revision means a chat_pinned for this message already
            // holds the truth; do not overwrite it.
            if (messagesStore.getState().messagePinRevision?.get(msgId) === revisionAfterFlip) {
              setMessagePinned(chId, msgId, currentlyPinned);
            }
            log.error("Pin/unpin failed", { error: String(err) });
            showToast(messagingText("toast.pinFailed"), "error");
          })
          .finally(() => {
            pinsInFlight.delete(flightKey);
          });
      },
      onReportClick: (msgId: number) => {
        const msg = getChannelMessages(channelId).find((m) => m.id === msgId);
        if (msg === undefined) return;
        import("../../features/reports/openers").then(
          ({ openMessageReport }) => {
            if (signal.aborted) return;
            // The dialog's closing restores focus to the Report button; the
            // composer is the fallback when a re-render has replaced the row.
            openMessageReport({
              api,
              msg,
              signal,
              fallbackFocus: () => slots.inputSlot.querySelector<HTMLElement>("textarea"),
            });
          },
          () => showToast(reportEntryText("reportLoadFailed"), "error"),
        );
      },
      onForwardClick: (msgId: number) => {
        import("../../components/ForwardPicker").then(
          ({ openForwardPicker }) => {
            if (signal.aborted) return;
            // Focus goes back to the composer: the menu that opened it is gone.
            openForwardPicker({
              ws,
              channelId,
              messageId: msgId,
              signal,
              fallbackFocus: () => slots.inputSlot.querySelector<HTMLElement>("textarea"),
            });
          },
          () => showToast(messagingText("forward.loadFailed"), "error"),
        );
      },
      // Voting and ending are plain requests on this channel's socket; the counts
      // come back as poll_update through the dispatcher.
      onPollVote: (messageId, answerIds) => votePoll(ws, messageId, answerIds, signal),
      onPollEnd: (messageId) => endPoll(ws, messageId, signal),
      ...(threadHost !== null && {
        onCreateThreadClick: (msgId: number) => {
          import("../../components/CreateThreadDialog").then(
            ({ openCreateThreadDialog }) => {
              if (signal.aborted) return;
              openCreateThreadDialog({
                ws,
                channelId,
                messageId: msgId,
                signal,
                onCreated: (thread) => threadHost.openById(thread.id, channelId, signal),
                onExists: (threadId) => threadHost.openById(threadId, channelId, signal),
                fallbackFocus: () => slots.inputSlot.querySelector<HTMLElement>("textarea"),
              });
            },
            () => showToast(messagingText("thread.panelLoadFailed"), "error"),
          );
        },
        onOpenThread: (threadId: number) => {
          threadHost.openById(threadId, channelId, signal);
        },
      }),
      onRetry: (correlationId: string) => retrySend(correlationId),
      onDeleteDraft: (correlationId: string) => deleteDraft(correlationId),
      renderUploadStrip: (correlationId, stripSignal) => {
        const entry = queuedSends.get(correlationId);
        return entry === undefined || sendQueueMod === null
          ? null
          : sendQueueMod.renderUploadStrip(entry, stripSignal);
      },
    });
    messageList.mount(slots.messagesSlot);
    if (storedChannel?.nsfw === true) mountConsentBar();

    // TypingIndicator
    typingIndicator = createTypingIndicator({
      channelId,
      currentUserId: userId,
    });
    typingIndicator.mount(slots.typingSlot);

    // MessageInput
    messageInput = createMessageInput({
      channelId,
      channelName,
      gifApi: api,
      onSend: (
        content: string,
        replyTo: number | null,
        _attachments: readonly string[],
        files: readonly SentAttachment[],
        replyPing: boolean,
        queued?: readonly QueuedAttachment[],
      ) => {
        const reply = liveReplyTo(replyTo);
        const ping = reply !== null && replyPing === true;
        if (queued === undefined) performSend(content, reply, files, undefined, ping);
        else enqueueSend(content, reply, ping, queued);
      },
      onSendSticker: (sticker, replyTo, replyPing) => {
        const reply = liveReplyTo(replyTo);
        performSend("", reply, [], undefined, reply !== null && replyPing, { sticker });
      },
      onUploadFile: uploadFile,
      onDiscardUpload: async (id: string) => {
        try {
          await api.discardUpload(id);
        } catch (err) {
          // The server sweeps an unsent upload on its own; this only frees
          // the quota sooner, so a failure is logged and not shown. A 404 is
          // a copy already gone (withdrawn before, or an older server).
          if (!(err instanceof ApiClientError && err.status === 404)) {
            log.warn("Discarding an unsent upload failed", { error: String(err) });
          }
          throw err;
        }
      },
      onTyping: () => {
        if (typingLimiter.tryConsume(String(channelId))) {
          ws.send({
            type: "typing_start",
            payload: { channel_id: channelId },
          });
        }
      },
      onDraftChange: scheduleDraftSave,
      onCreatePoll: () => {
        import("../../components/PollComposer").then(
          ({ openPollComposer }) => {
            if (signal.aborted) return;
            openPollComposer({
              ws,
              channelId,
              signal,
              fallbackFocus: () => slots.inputSlot.querySelector<HTMLElement>("textarea"),
            });
          },
          () => showToast(messagingText("poll.loadFailed"), "error"),
        );
      },
    });
    messageInput.mount(slots.inputSlot);

    // Restore this channel's stashed draft, if any — its text, reply
    // target and staged upload ids — so a switch away and back is lossless.
    // A reply whose target is gone (deleted while away) is dropped, not
    // restored onto a message the server would refuse the reply to.
    const stashedDraft = draftByChannel.get(channelId);
    if (stashedDraft !== undefined) {
      const replyTo =
        stashedDraft.replyTo !== null &&
        !getChannelMessages(channelId).some(
          (m) => m.id === stashedDraft.replyTo!.messageId && !m.deleted,
        )
          ? null
          : stashedDraft.replyTo;
      messageInput.restoreDraft({ ...stashedDraft, replyTo });
      draftByChannel.delete(channelId);
    } else {
      restoreSavedDraft(channelId, messageInput);
    }
    // A dropped reply must not come back from storage on the next start.
    scheduleDraftSave();

    // Composer gating: express permission + connection as affordance. The
    // composer disables (with a reason) when the socket is down or the user
    // may not post here, instead of accepting a click and failing. For DM
    // channels the reason also covers block state (channels-members-dms.md §3.2).
    // Slow mode as affordance: after an accepted send the composer disables
    // itself for the channel's cooldown with a live countdown, instead of
    // taking a message the server will bounce with SLOW_MODE (UX spec §5,
    // "do not drop the drafted message" — the draft stays in the textarea).
    let slowModeTicker: ReturnType<typeof setInterval> | null = null;

    const stopSlowModeTicker = (): void => {
      if (slowModeTicker !== null) {
        clearInterval(slowModeTicker);
        slowModeTicker = null;
      }
    };

    const slowModeRemaining = (): number => {
      const entry = slowModeSentAtByChannel.get(channelId);
      if (entry === undefined) return 0;
      const seconds = channelsStore.getState().channels.get(channelId)?.slowMode ?? 0;
      entry.window = Math.max(entry.window, seconds);
      return Math.max(0, Math.ceil((entry.sentAt + seconds * 1000 - Date.now()) / 1000));
    };

    const computeComposerReason = (): string | null => {
      const status = uiStore.getState().connectionStatus;
      if (status === "reconnecting") return shellText("channel.reconnecting");
      if (status === "disconnected") return shellText("channel.notConnected");
      const timeout = safetyStore.getState().timeout;
      if (timeout !== null)
        return safetyText("timeout.composer", { time: formatUntil(timeout.expiresAt) });
      if (dmRecipientId !== null) {
        const blockReason = dmComposerBlockReason(blocksStore.getState(), dmRecipientId);
        if (blockReason !== null) return blockReason;
      }
      const ch = channelsStore.getState().channels.get(channelId);
      if (ch === undefined) return null;
      if (!ch.canSend) {
        return ch.type === "announcement"
          ? messagingText("composer.announcementOnly")
          : messagingText("composer.noPermission");
      }
      return null;
    };
    // The standing slow-mode note: shown from the first moment, for anyone
    // slow mode would limit. Not a send gate, so the first send still goes.
    const refreshSlowModeNote = (): void => {
      const seconds = channelsStore.getState().channels.get(channelId)?.slowMode ?? 0;
      messageInput?.setSlowModeNote(
        seconds > 0 && !canManageMessages()
          ? messagingText("composer.slowModeNote", { seconds: String(seconds) })
          : null,
      );
    };
    const refreshComposerState = (): void => {
      refreshSlowModeNote();
      messageInput?.setDisabled(computeComposerReason());
      // Slow mode gates the SEND only: the draft stays editable so the user
      // can keep typing through the cooldown (Discord parity, F12).
      const remaining = slowModeRemaining();
      messageInput?.setSendGate(
        remaining > 0 ? messagingText("composer.slowMode", { seconds: String(remaining) }) : null,
      );
    };

    /**
     * Begin (or restart) the slow-mode cooldown for this channel. Moderators
     * bypass slow mode server-side, so they never get gated here either.
     */
    const armSlowModeTicker = (): void => {
      refreshComposerState();
      stopSlowModeTicker();
      slowModeTicker = setInterval(() => {
        // Keep ticking past a zero gate until the largest observed window is
        // over, so a setting raised again meanwhile re-gates the composer.
        refreshComposerState();
        if (slowModeWindowOver(channelId)) stopSlowModeTicker();
      }, 1000);
    };
    const startSlowMode = (seconds: number): void => {
      if (seconds <= 0 || canManageMessages()) return;
      recordSlowModeSend(channelId, seconds);
      armSlowModeTicker();
    };
    composerGatingUnsubs.push(stopSlowModeTicker);

    // Both chat_send_ok and the SLOW_MODE error are global ws.on
    // subscriptions carrying no channel_id of their own — only the
    // correlation id ties a frame back to the send that produced it. A send
    // made in a channel the user has since left can still be in flight when
    // its ack/refusal arrives, and by then this listener belongs to whatever
    // channel is newly mounted. Absent/empty correlation ids never
    // happen over the real transport, so fall back to attributing to the
    // mounted channel rather than silently dropping every ack.
    const sentToMountedChannel = (correlationId: string | undefined): boolean =>
      correlationId === undefined ||
      correlationId === "" ||
      draftByCorrelation.get(correlationId)?.channelId === channelId;

    // The server accepted a message — the next one is subject to the cooldown.
    composerGatingUnsubs.push(
      ws.on("chat_send_ok", (payload, correlationId) => {
        if (!ownsSession()) return;
        const sameChannel = sentToMountedChannel(correlationId);
        const sentDraft =
          correlationId === undefined ? undefined : draftByCorrelation.get(correlationId);
        const sentTo = sentDraft?.channelId;
        // An accepted send can never be retried, so its draft is dead weight.
        // The map is controller-scoped (a failed row outlives a channel
        // switch, so its draft must too), which means nothing else would ever
        // drop it — every message sent in the session would be retained.
        if (correlationId !== undefined && correlationId !== "") {
          draftByCorrelation.delete(correlationId);
          clearSendTimer(correlationId);
        }
        if (payload.client_message_id) {
          for (const [id, draft] of draftByCorrelation) {
            if (draft.clientMessageId === payload.client_message_id) {
              draftByCorrelation.delete(id);
              clearSendTimer(id);
            }
          }
        }
        const ch = channelsStore.getState().channels.get(channelId);
        if (
          ch !== undefined &&
          ch.id === channelsStore.getState().activeChannelId &&
          sameChannel &&
          !payload.deduplicated
        ) {
          startSlowMode(ch.slowMode);
        } else if (sentTo !== undefined && !sameChannel && !payload.deduplicated) {
          // A late ack for a channel the user has left: charge that channel's
          // cooldown now, without arming this mounted channel's ticker.
          const seconds = channelsStore.getState().channels.get(sentTo)?.slowMode ?? 0;
          if (seconds > 0 && !canManageMessages()) {
            recordSlowModeSend(sentTo, seconds, sentDraft?.sentAt);
          }
        }
      }),
    );
    composerGatingUnsubs.push(
      ws.on("chat_message", (payload) => {
        if (!ownsSession() || payload.user.id !== owner.userId || !payload.client_message_id)
          return;
        // The live echo proves delivery even when its preceding ACK was lost.
        // Dispatcher owns store reconciliation; this listener only releases
        // private retry payloads and timers owned by this controller.
        for (const [id, draft] of draftByCorrelation) {
          if (
            draft.clientMessageId === payload.client_message_id &&
            draft.channelId === payload.channel_id
          ) {
            draftByCorrelation.delete(id);
            clearSendTimer(id);
          }
        }
      }),
    );
    // The server's edit/delete echoes carry no envelope id, so a
    // tracked frame is resolved by its channel + message (the same
    // content-match reactions use). Only the server echo proves delivery.
    composerGatingUnsubs.push(
      ws.on("chat_edited", (payload) => {
        for (const [id, edit] of pendingEdits) {
          if (edit.channelId === payload.channel_id && edit.messageId === payload.message_id) {
            untrack(pendingEdits, id);
          }
        }
      }),
    );
    composerGatingUnsubs.push(
      ws.on("chat_deleted", (payload) => {
        for (const [id, del] of pendingDeletes) {
          if (del.channelId === payload.channel_id && del.messageId === payload.message_id) {
            untrack(pendingDeletes, id);
          }
        }
      }),
    );
    // A local transport failure never echoes, so the frame is gone: report
    // one error (the dispatcher's generic handler ignores an id that matches
    // no pending send/reaction) and put a failed edit's text back. A half-open
    // socket does not reject the send (the frame buffers), so the reconnect
    // transition below is what catches that case.
    composerGatingUnsubs.push(
      ws.onSendFailure((id) => {
        const edit = untrack(pendingEdits, id);
        if (edit !== undefined) {
          failEdits([edit], true);
          return;
        }
        if (untrack(pendingDeletes, id) !== undefined) {
          showToast(messagingText("toast.deleteFailed"), "error");
        }
      }),
    );
    // Leaving "connected" means an in-flight frame can never be echoed: the
    // dispatcher only sweeps optimistic sends/reactions, so resolve the
    // tracked edit/delete frames here too — one error, and an edit's text
    // back — instead of leaving a false success and a leaked entry.
    composerGatingUnsubs.push(
      ws.onStateChange((state) => {
        if (state === "connected") return;
        if (pendingEdits.size > 0) failEdits([...pendingEdits.values()], true);
        pendingEdits.clear();
        const hadDelete = pendingDeletes.size > 0;
        pendingDeletes.clear();
        for (const timer of trackTimers.values()) window.clearTimeout(timer);
        trackTimers.clear();
        if (hadDelete) showToast(messagingText("toast.deleteFailed"), "error");
      }),
    );
    // A refused send restarts the full window: the server's limiter is the
    // authority on when the next one is allowed. A refused edit restores the
    // text but leaves the one error to the dispatcher's own chain.
    composerGatingUnsubs.push(
      ws.on("error", (payload, correlationId) => {
        if (correlationId !== undefined) {
          const edit = untrack(pendingEdits, correlationId);
          if (edit !== undefined) failEdits([edit], false);
          untrack(pendingDeletes, correlationId);
        }
        if (payload.code !== WsErrorCode.SLOW_MODE) return;
        if (!sentToMountedChannel(correlationId)) return;
        const ch = channelsStore.getState().channels.get(channelId);
        if (ch !== undefined) startSlowMode(ch.slowMode);
      }),
    );

    refreshComposerState();
    // Returning to a channel still inside its cooldown: re-arm the countdown.
    if (canManageMessages()) slowModeSentAtByChannel.delete(channelId);
    else if (!slowModeWindowOver(channelId) || slowModeRemaining() > 0) armSlowModeTicker();
    else if (!slowModeRetained(channelId)) slowModeSentAtByChannel.delete(channelId);
    composerGatingUnsubs.push(
      uiStore.subscribeSelector(
        (s) => s.connectionStatus,
        () => refreshComposerState(),
      ),
    );
    composerGatingUnsubs.push(
      channelsStore.subscribeSelector(
        (s) => s.channels.get(channelId)?.canSend ?? true,
        () => refreshComposerState(),
      ),
    );
    // A channel_update/create that changes the interval refreshes the note.
    composerGatingUnsubs.push(
      channelsStore.subscribeSelector(
        (s) => s.channels.get(channelId)?.slowMode ?? 0,
        () => refreshComposerState(),
      ),
    );
    composerGatingUnsubs.push(
      safetyStore.subscribeSelector(
        (s) => s.timeout,
        () => refreshComposerState(),
      ),
    );
    // A role change can make the user exempt from slow mode, or no longer so.
    composerGatingUnsubs.push(
      membersStore.subscribeSelector(
        (s) => s.roleRevision ?? 0,
        () => refreshComposerState(),
      ),
    );
    if (dmRecipientId !== null) {
      // Un-gate live when the block clears (unblock) and gate on a refused send.
      composerGatingUnsubs.push(
        blocksStore.subscribeSelector(
          (s) => dmComposerBlockReason(s, dmRecipientId),
          () => refreshComposerState(),
        ),
      );
    }

    // Arrow-up edit: listen for edit-last-message bubbling from MessageInput
    slots.inputSlot.addEventListener(
      "edit-last-message",
      () => {
        const msgs = getChannelMessages(channelId);
        const myId = getCurrentUserId();
        // Find the last message sent by the current user (array is chronological)
        for (let i = msgs.length - 1; i >= 0; i--) {
          const m = msgs[i]!;
          // Mirrors renderers.ts's gate on the visual Edit affordance: an
          // optimistic row (pending/failed) carries id 0 until the server
          // acks it, so editing it would send chat_edit for a message that
          // does not exist yet.
          // A server-written row (a DM call log) is never editable, nor is a
          // sticker message: it has no text and the server refuses it.
          if (
            m.user.id === myId &&
            !m.deleted &&
            m.status === "sent" &&
            !isServerRowKind(m.kind) &&
            m.sticker === undefined
          ) {
            messageList?.startEdit(m.id);
            break;
          }
        }
      },
      { signal },
    );

    // A sidebar thread row asked for this channel: open its thread or list now.
    settleThreadNavigation(channelId);
  }

  // 2A-3 at controller scope, not per mount: an ack or refusal can land while
  // no channel is mounted (an NSFW gate, a cleared selection), and its files
  // still go back to the channel they were sent to. Registered before any
  // mount, so these run before a mount's own listeners drop the draft.
  const unsentUnsubs = [
    ws.on("chat_send_ok", (payload, correlationId) => {
      const draft = correlationId ? draftByCorrelation.get(correlationId) : undefined;
      if (draft === undefined || draft.userId !== getCurrentUserId()) return;
      // The message went without these files. Ids the send did not carry are ignored.
      const skipped = new Set(payload.skipped_attachment_ids ?? []);
      const unsent = draft.attachments.filter((a) => skipped.has(a.id));
      if (unsent.length > 0) putBackUnsent(draft.channelId, unsent, "skipped");
    }),
    ws.on("error", (payload, correlationId) => {
      if (payload.code !== WsErrorCode.ATTACHMENTS_UNAVAILABLE || !correlationId) return;
      const draft = draftByCorrelation.get(correlationId);
      if (draft === undefined || draft.userId !== getCurrentUserId()) return;
      // A files-only send none of whose files could be attached: the
      // dispatcher drops its row (nothing was stored), and a Retry with the
      // same ids would fail the same way.
      draftByCorrelation.delete(correlationId);
      clearSendTimer(correlationId);
      putBackUnsent(
        draft.channelId,
        draft.attachments,
        "unavailable",
        draft.replyTo,
        draft.replyPing,
      );
    }),
  ];

  function destroy(): void {
    for (const off of unsentUnsubs) off();
    destroyChannel();
    for (const draft of draftByChannel.values()) {
      for (const upload of draft.uploads ?? []) upload.owner.destroy();
    }
    draftByChannel.clear();
    for (const entry of queuedSends.values()) abortQueued(entry);
    queuedSends.clear();
    threadHost?.destroy();
    setThreadNavigationConsumer(null);
  }

  /** The header's Threads button: close the list when it is open, else open it
   *  for the mounted channel. Its code loads on the first open. */
  function toggleThreadList(anchor: HTMLButtonElement): void {
    if (threadList !== null) {
      threadList.close();
      return;
    }
    const channelId = currentChannelId;
    const signal = channelAbort?.signal;
    if (channelId === null || signal === undefined || threadHost === null) return;
    const host = threadHost;
    // A second click while the code loads must not queue a second popover.
    anchor.setAttribute("aria-expanded", "true");
    import("../../components/ThreadListPopover").then(
      ({ openThreadListPopover }) => {
        if (signal.aborted) {
          anchor.setAttribute("aria-expanded", "false");
          return;
        }
        threadList = openThreadListPopover({
          api,
          channelId,
          anchor,
          signal,
          onOpenThread: (thread) => host.open(thread),
          onClosed: () => {
            threadList = null;
          },
        });
      },
      () => {
        anchor.setAttribute("aria-expanded", "false");
        showToast(messagingText("thread.panelLoadFailed"), "error");
      },
    );
  }

  // The sidebar's thread rows reach this channel view through threadNavigation.
  if (threadHost !== null) {
    setThreadNavigationConsumer({
      get currentChannelId() {
        return currentChannelId;
      },
      open: (req) => {
        const signal = channelAbort?.signal;
        if (signal === undefined) return;
        if (req.kind === "thread") {
          threadHost.openById(req.threadId, req.parentId, signal);
          return;
        }
        const anchor = chatHeaderRefs?.threadsBtn;
        if (anchor !== undefined && !anchor.hidden && threadList === null) toggleThreadList(anchor);
      },
    });
  }

  return {
    mountChannel,
    destroyChannel,
    destroy,
    openThread: (thread) => threadHost?.open(thread),
    toggleThreadList,
    get openThreadId() {
      return threadHost?.openThreadId ?? null;
    },
    openFilePicker: () => messageInput?.openFilePicker(),
    togglePicker: (kind) => messageInput?.togglePicker(kind),
    get currentChannelId() {
      return currentChannelId;
    },
    get messageList() {
      return messageList;
    },
  };
}
