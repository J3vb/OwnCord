/**
 * ChannelController — channel switching, component mount/destroy lifecycle.
 * Creates and manages MessageList, TypingIndicator, and MessageInput per channel.
 * Extracted from MainPage to reduce god-object coupling and enable unit testing.
 */

import { clearChildren } from "@lib/dom";
import type { WsClient } from "@lib/ws";
import { type ApiClient } from "@lib/api";
import type { ChannelType, ThreadInfo } from "@lib/types";
import { type MessageListComponent } from "@components/MessageList";
import { NAVIGATION_DESTINATIONS } from "../../features/navigation/destinations";
import { type ComposerDraft, type SentAttachment } from "@components/MessageInput";
import { clearReactionUsersCache } from "../../features/messaging/reactionUsers";
import type { QueuedSend } from "../../features/messaging/sendQueue";
import { nsfwConsentRequired } from "../../features/content-consent/nsfw";
import { invalidateChannelMessageWindow, clearChannelContent } from "@stores/messages.store";
import type { MessageController } from "./MessageController";
import type { ReactionController } from "./ReactionController";
import { type ChatHeaderRefs } from "./ChatHeader";
import { createThreadPanelHost, type ThreadPanelHost } from "./ThreadPanelHost";
import {
  setThreadNavigationConsumer,
  settleThreadNavigation,
} from "../../features/threads/threadNavigation";
import { createAvatarElement, pickAvatarColor } from "../../features/profiles/avatar";
import { channelsStore, setActiveChannel, setNsfwAcknowledged } from "@stores/channels.store";
import { viewChannel } from "@lib/prefs/lastChannel";
import { messagingText } from "../../i18n/messaging";
import { leaveChannel, markChannelRead } from "@lib/readState";
import { readPointerEnabled } from "@lib/net/serverCapabilities";
import { WsErrorCode } from "@lib/protocolTypes";
import { log, abortQueued, type TrackedEdit } from "./channel/channelShared";
import type { ChannelState, ChannelApi } from "./channel/channelState";
import { createChannelDrafts } from "./channel/channelDrafts";
import { createChannelSends } from "./channel/channelSends";
import { mountSendPipeline } from "./channel/channelMountSend";
import { mountDmHeader } from "./channel/channelMountHeader";
import { mountMessageList } from "./channel/channelMountList";
import { mountComposer, mountComposerGating } from "./channel/channelMountComposer";
import type { MountScope } from "./channel/channelState";

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
  const st: ChannelState = {
    opts,
    ws: ws,
    api: api,
    msgCtrl: msgCtrl,
    reactionCtrl: reactionCtrl,
    typingLimiter: typingLimiter,
    showToast: showToast,
    getCurrentUserId: getCurrentUserId,
    slots: slots,
    chatHeaderName: chatHeaderName,
    chatHeaderRefs: chatHeaderRefs,
    onContentGated: onContentGated,
    focusFallback: focusFallback,
    threadHost: threadHost,
    threadList: null,
    currentChannelId: null,
    channelAbort: null,
    pinsInFlight: new Set<string>(),
    messageList: null,
    messageInput: null,
    typingIndicator: null,
    nsfwConsentUi: null,
    nsfwConsentUiGen: 0,
    composerGatingUnsubs: [],
    draftByChannel: new Map<number, ComposerDraft>(),
    draftSaveTimer: null,
    draftOwner: null,
    lastSavedDraft: "",
    slowModeSentAtByChannel: new Map<number, { sentAt: number; window: number }>(),
    SLOW_MODE_RETENTION_MS: 5 * 60 * 1000,
    draftByCorrelation: new Map<
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
    >(),
    sendChain: Promise.resolve(),
    sendChainBusy: false,
    sendChainGen: 0,
    sendTimers: new Map<string, { timer: number; release?: () => void }>(),
    queuedSends: new Map<string, QueuedSend>(),
    sendQueueMod: null,
    pendingEdits: new Map<string, TrackedEdit>(),
    pendingDeletes: new Map<string, { channelId: number; messageId: number }>(),
    trackTimers: new Map<string, number>(),
  };
  const cc = {} as ChannelApi;
  Object.assign(cc, createChannelDrafts(st, cc), createChannelSends(st, cc));

  // 2A-3 at controller scope, not per mount: an ack or refusal can land while
  // no channel is mounted (an NSFW gate, a cleared selection), and its files
  // still go back to the channel they were sent to. Registered before any
  // mount, so these run before a mount's own listeners drop the draft.
  const unsentUnsubs = [
    st.ws.on("chat_send_ok", (payload, correlationId) => {
      const draft = correlationId ? st.draftByCorrelation.get(correlationId) : undefined;
      if (draft === undefined || draft.userId !== st.getCurrentUserId()) return;
      // The message went without these files. Ids the send did not carry are ignored.
      const skipped = new Set(payload.skipped_attachment_ids ?? []);
      const unsent = draft.attachments.filter((a) => skipped.has(a.id));
      if (unsent.length > 0) cc.putBackUnsent(draft.channelId, unsent, "skipped");
    }),
    st.ws.on("error", (payload, correlationId) => {
      if (payload.code !== WsErrorCode.ATTACHMENTS_UNAVAILABLE || !correlationId) return;
      const draft = st.draftByCorrelation.get(correlationId);
      if (draft === undefined || draft.userId !== st.getCurrentUserId()) return;
      // A files-only send none of whose files could be attached: the
      // dispatcher drops its row (nothing was stored), and a Retry with the
      // same ids would fail the same way.
      st.draftByCorrelation.delete(correlationId);
      cc.clearSendTimer(correlationId);
      cc.putBackUnsent(
        draft.channelId,
        draft.attachments,
        "unavailable",
        draft.replyTo,
        draft.replyPing,
      );
    }),
  ];

  function destroyChannel(): void {
    st.threadList?.close();
    st.threadHost?.close();
    // The reaction picker is a body-mounted overlay keyed to a message in
    // this channel — every other teardown path already routes through here,
    // so this is the one choke point to close it before the channel it was
    // opened against goes away. destroy() is idempotent (closePicker
    // null-checks), so it is safe even when no picker is open.
    st.reactionCtrl.destroy();

    for (const unsub of st.composerGatingUnsubs) unsub();
    st.composerGatingUnsubs = [];

    if (st.channelAbort !== null) {
      st.channelAbort.abort();
      st.channelAbort = null;
    }

    st.nsfwConsentUiGen++;
    if (st.nsfwConsentUi !== null) {
      st.nsfwConsentUi.destroy?.();
      st.nsfwConsentUi = null;
    }
    if (st.messageList !== null) {
      st.messageList.destroy?.();
      st.messageList = null;
    }
    if (st.typingIndicator !== null) {
      st.typingIndicator.destroy?.();
      st.typingIndicator = null;
    }
    if (st.messageInput !== null) {
      cc.saveMountedDraft();
      // Stash the unsent state before the composer is torn down. Empty
      // drafts are not stored, so switching away from a channel with nothing
      // typed leaves no entry behind.
      if (st.currentChannelId !== null) {
        const draft = st.messageInput.getDraft();
        if (
          draft.content !== "" ||
          draft.replyTo !== null ||
          draft.attachments.length > 0 ||
          (draft.uploads?.length ?? 0) > 0
        ) {
          st.draftByChannel.set(st.currentChannelId, draft);
        } else {
          st.draftByChannel.delete(st.currentChannelId);
        }
      }
      st.messageInput.destroy?.();
      st.messageInput = null;
    }
    clearChildren(st.slots.messagesSlot);
    clearChildren(st.slots.typingSlot);
    clearChildren(st.slots.inputSlot);

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
    if (st.currentChannelId !== null) invalidateChannelMessageWindow(st.currentChannelId);
    // reaction_update stops arriving too, so a cached who-reacted list could
    // be stale by the next visit.
    clearReactionUsersCache();
    st.currentChannelId = null;
  }

  function mountChannel(
    channelId: number,
    channelName: string,
    channelType?: ChannelType,
    focusGate = true,
  ): void {
    const ms = {} as MountScope;
    ms.channelId = channelId;
    ms.channelName = channelName;
    ms.channelType = channelType;
    ms.focusGate = focusGate;

    if (st.currentChannelId === ms.channelId) return;

    ms.previousChannelId = st.currentChannelId;
    destroyChannel();
    st.currentChannelId = ms.channelId;
    // channel_focus (sent below) is the only thing that advances the *new*
    // channel's server-side read state; leaving one never does. Without this,
    // messages read while focused here restate as unread/mention badges on
    // the next full `ready`. mark_read is a local no-op (already zeroed on
    // open) — it only repairs the server's view. With a read pointer, leaving
    // marks only what the reader saw (leaveChannel), never "everything".
    // A forum holds no messages, so it has no read state to repair.
    ms.leftForum =
      channelsStore.getState().channels.get(ms.previousChannelId ?? 0)?.type === "forum";
    if (ms.previousChannelId !== null && !ms.leftForum) {
      if (readPointerEnabled()) leaveChannel(ms.previousChannelId);
      else markChannelRead(ms.previousChannelId);
      // The server only delivers live broadcasts for the focused channel, so
      // the window being left stops updating the moment focus moves here.
      // Drop its loaded flag so the next visit refetches the live tail
      // instead of rendering the old snapshot as current — setMessages'
      // merge preserves any pending/failed rows across that refetch.
      invalidateChannelMessageWindow(ms.previousChannelId);
    }

    log.info("Switching channel", { channelId: ms.channelId, channelName: ms.channelName });

    // The channel is actually on screen now, so this is where its
    // badge is cleared and it is recorded as the last channel (the ready-time
    // auto-select only selected it), alongside the channel_focus.
    viewChannel(ms.channelId, ms.channelType, st.ws);

    st.channelAbort = new AbortController();
    ms.signal = st.channelAbort.signal;
    ms.userId = st.getCurrentUserId();
    ms.owner = { host: st.api.getConfig?.().host ?? "", userId: ms.userId };
    ms.session = st.api.getSession?.();
    ms.ownsAccountSession = (): boolean =>
      (ms.session === undefined || ms.session.isCurrent()) &&
      st.getCurrentUserId() === ms.owner.userId &&
      (st.api.getConfig?.().host ?? "") === ms.owner.host;
    ms.ownsSession = (): boolean => !ms.signal.aborted && ms.ownsAccountSession();
    st.draftOwner = { ...ms.owner, current: ms.ownsAccountSession };
    mountSendPipeline(st, cc, ms);
    mountDmHeader(st, cc, ms);

    // NSFW consent gates composition, not just display: until the
    // server has confirmed this account's acknowledgement, the channel's
    // content is neither mounted nor fetched, and any rows left from before
    // consent was withdrawn are dropped. Any change that crosses the gate —
    // accepted here, revoked here or on another device, relabelled, or
    // restated by a reconnect's ready — remounts the channel on the other
    // side of it; labelling or unlabelling consented content only adds or
    // removes the withdraw bar, so the composer keeps its draft.
    ms.storedChannel = channelsStore.getState().channels.get(ms.channelId);
    ms.gated = nsfwConsentRequired(ms.storedChannel);
    st.composerGatingUnsubs.push(
      channelsStore.subscribeSelector(
        (s) => {
          const ch = s.channels.get(ms.channelId);
          if (ch?.nsfw !== true) return "none";
          return nsfwConsentRequired(ch) ? "gated" : "consented";
        },
        (state) => {
          if (st.currentChannelId !== ms.channelId) return;
          if ((state === "gated") === ms.gated) {
            st.nsfwConsentUiGen++;
            st.nsfwConsentUi?.destroy?.();
            st.nsfwConsentUi = null;
            if (state === "consented") ms.mountConsentBar();
            return;
          }
          // A remount caused elsewhere (another device, a moderator, a
          // reconnect) takes focus only from the content it replaces, never
          // from an open dialog or another part of the app.
          const active = document.activeElement;
          const gateHadFocus = [
            st.slots.messagesSlot,
            st.slots.typingSlot,
            st.slots.inputSlot,
          ].some((slot) => slot.contains(active));
          const takeFocus = gateHadFocus || active === null || active === document.body;
          const name = channelsStore.getState().channels.get(ms.channelId)?.name ?? ms.channelName;
          destroyChannel();
          mountChannel(ms.channelId, name, ms.channelType, takeFocus);
          if (state === "gated") st.onContentGated?.();
          else if (gateHadFocus) st.focusFallback?.();
        },
      ),
    );
    if (ms.gated) {
      clearChannelContent(ms.channelId);
      ms.mountConsentUi((ui) =>
        ui.createNsfwGate({
          channelName: ms.channelName,
          focusOnMount: ms.focusGate,
          onAccept: () =>
            st.api.acknowledgeNsfw(ms.channelId).then(() => {
              if (ms.ownsAccountSession()) setNsfwAcknowledged(ms.channelId, true);
            }),
          onCancel: () => {
            // Leave the channel entirely: keeping the gate up over a channel the
            // reader declined would strand them on a screen with no way out that
            // is not also "continue".
            destroyChannel();
            setActiveChannel(null);
            st.focusFallback?.();
          },
        }),
      );
      return;
    }

    // A forum shows its post list in place of the message list, and has no
    // typing row or composer. A post opens in the thread panel.
    if ((ms.storedChannel?.type ?? ms.channelType) === "forum") {
      const forum = NAVIGATION_DESTINATIONS.forum;
      if (forum === undefined) return;
      st.slots.messagesSlot.appendChild(
        forum.build({
          channelId: ms.channelId,
          signal: ms.signal,
          api: st.api,
          ws: st.ws,
          openPost: (threadId) =>
            st.threadHost?.openById(
              threadId,
              ms.channelId,
              ms.signal,
              () =>
                // The post's row, or the New Post button once the row is gone.
                st.slots.messagesSlot.querySelector<HTMLElement>(`[data-post-id="${threadId}"]`) ??
                st.slots.messagesSlot.querySelector<HTMLElement>('[data-testid="forum-new-post"]'),
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
      if (ms.storedChannel?.nsfw === true) ms.mountConsentBar();
      // A followed post's sidebar row asked for this forum: open the post now.
      settleThreadNavigation(ms.channelId);
      return;
    }

    void st.msgCtrl.loadMessages(ms.channelId, ms.signal);
    mountMessageList(st, cc, ms);
    mountComposer(st, cc, ms);
    mountComposerGating(st, cc, ms);

    // A sidebar thread row asked for this channel: open its thread or list now.
    settleThreadNavigation(ms.channelId);
  }
  function destroy(): void {
    for (const off of unsentUnsubs) off();
    destroyChannel();
    for (const draft of st.draftByChannel.values()) {
      for (const upload of draft.uploads ?? []) upload.owner.destroy();
    }
    st.draftByChannel.clear();
    for (const entry of st.queuedSends.values()) abortQueued(entry);
    st.queuedSends.clear();
    st.threadHost?.destroy();
    setThreadNavigationConsumer(null);
  }

  /** The header's Threads button: close the list when it is open, else open it
   *  for the mounted channel. Its code loads on the first open. */
  function toggleThreadList(anchor: HTMLButtonElement): void {
    if (st.threadList !== null) {
      st.threadList.close();
      return;
    }
    const channelId = st.currentChannelId;
    const signal = st.channelAbort?.signal;
    if (channelId === null || signal === undefined || st.threadHost === null) return;
    const host = st.threadHost;
    // A second click while the code loads must not queue a second popover.
    anchor.setAttribute("aria-expanded", "true");
    import("../../components/ThreadListPopover").then(
      ({ openThreadListPopover }) => {
        if (signal.aborted) {
          anchor.setAttribute("aria-expanded", "false");
          return;
        }
        st.threadList = openThreadListPopover({
          api: st.api,
          channelId,
          anchor,
          signal,
          onOpenThread: (thread) => host.open(thread),
          onClosed: () => {
            st.threadList = null;
          },
        });
      },
      () => {
        anchor.setAttribute("aria-expanded", "false");
        st.showToast(messagingText("thread.panelLoadFailed"), "error");
      },
    );
  }

  // The sidebar's thread rows reach this channel view through threadNavigation.
  if (st.threadHost !== null) {
    setThreadNavigationConsumer({
      get currentChannelId() {
        return st.currentChannelId;
      },
      open: (req) => {
        const signal = st.channelAbort?.signal;
        if (signal === undefined) return;
        if (req.kind === "thread") {
          st.threadHost!.openById(req.threadId, req.parentId, signal);
          return;
        }
        const anchor = st.chatHeaderRefs?.threadsBtn;
        if (anchor !== undefined && !anchor.hidden && st.threadList === null)
          toggleThreadList(anchor);
      },
    });
  }

  return {
    mountChannel,
    destroyChannel,
    destroy,
    openThread: (thread) => st.threadHost?.open(thread),
    toggleThreadList,
    get openThreadId() {
      return st.threadHost?.openThreadId ?? null;
    },
    openFilePicker: () => st.messageInput?.openFilePicker(),
    togglePicker: (kind) => st.messageInput?.togglePicker(kind),
    get currentChannelId() {
      return st.currentChannelId;
    },
    get messageList() {
      return st.messageList;
    },
  };
}
