/**
 * ChannelController — channel switching, component mount/destroy lifecycle.
 * Creates and manages MessageList, TypingIndicator, and MessageInput per channel.
 * Extracted from MainPage to reduce god-object coupling and enable unit testing.
 */

import { clearChildren, setText } from "@lib/dom";
import { createLogger } from "@lib/logger";
import type { MountableComponent } from "@lib/safe-render";
import type { WsClient } from "@lib/ws";
import type { ApiClient } from "@lib/api";
import type { ChannelType } from "@lib/types";
import { createMessageList } from "@components/MessageList";
import type { MessageListComponent } from "@components/MessageList";
import { createMessageInput } from "@components/MessageInput";
import type { MessageInputComponent } from "@components/MessageInput";
import { createTypingIndicator } from "@components/TypingIndicator";
import { createNsfwConsentBar, createNsfwGate } from "@components/NsfwGate";
import { nsfwConsentRequired } from "../../features/content-consent/nsfw";
import { nsfwConsentText } from "../../i18n/nsfwConsent";
import {
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
import { jumpToMessage } from "@lib/message-navigation";
import { authStore } from "@stores/auth.store";
import type { MessageUser } from "@lib/types";
import type { MessageController } from "./MessageController";
import type { PendingDeleteManager } from "./MessageController";
import type { ReactionController } from "./ReactionController";
import { updateChatHeaderForDm } from "./ChatHeader";
import type { ChatHeaderRefs } from "./ChatHeader";
import { dmStore, dmDisplayName } from "@stores/dm.store";
import { canManageMessages } from "@lib/permissions";
import { blocksStore, dmComposerBlockReason } from "@stores/blocks.store";
import { membersStore } from "@stores/members.store";
import { channelsStore, setActiveChannel, setNsfwAcknowledged } from "@stores/channels.store";
import { uiStore } from "@stores/ui.store";
import { safetyStore } from "../../features/safety/store";
import { formatUntil, safetyText } from "../../i18n/safety";
import { markChannelRead } from "@lib/read-state";
import {
  newClientMessageId,
  pendingMessageExpired,
  pendingMessageRetryFloor,
  recoveredPendingText,
  supportsMessageDeduplication,
  savePendingText,
  acknowledgePendingMessage,
} from "@lib/pendingMessages";

const log = createLogger("channel-ctrl");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ChannelControllerOptions {
  readonly ws: WsClient;
  readonly api: ApiClient;
  readonly msgCtrl: MessageController;
  readonly pendingDeleteManager: PendingDeleteManager;
  readonly reactionCtrl: ReactionController;
  readonly typingLimiter: { tryConsume(key?: string): boolean };
  readonly showToast: (msg: string, type: string) => void;
  readonly getCurrentUserId: () => number;
  readonly slots: {
    readonly messagesSlot: HTMLDivElement;
    readonly typingSlot: HTMLDivElement;
    readonly inputSlot: HTMLDivElement;
  };
  readonly chatHeaderName: HTMLSpanElement | null;
  readonly chatHeaderRefs: ChatHeaderRefs | null;
  /** Close the image lightbox when the mounted channel falls behind the
   *  NSFW gate (ChatArea closes the pins and search overlays itself). */
  readonly onContentGated?: () => void;
  /** Move focus somewhere reachable after the NSFW gate that held it is
   *  removed (accepted, declined or dismissed with Escape). */
  readonly focusFallback?: () => void;
}

export interface ChannelController {
  /** Mount components for a channel. No-op if same channel already mounted. */
  mountChannel(channelId: number, channelName: string, channelType?: ChannelType): void;
  /** Destroy current channel components and reset state. */
  destroyChannel(): void;
  /** Currently mounted channel ID, or null. */
  readonly currentChannelId: number | null;
  /** Currently mounted message list (for scroll-to-message). */
  readonly messageList: MessageListComponent | null;
  /** Open the composer's attachment picker (Ctrl+U). No-op with no composer. */
  openFilePicker(): void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

function currentMessageUser(): MessageUser | null {
  const u = authStore.getState().user;
  if (u === null) return null;
  return { id: u.id, username: u.username, avatar: u.avatar };
}

export function createChannelController(opts: ChannelControllerOptions): ChannelController {
  const {
    ws,
    api,
    msgCtrl,
    pendingDeleteManager,
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

  let currentChannelId: number | null = null;
  let channelAbort: AbortController | null = null;
  let messageList: MessageListComponent | null = null;
  let messageInput: MessageInputComponent | null = null;
  let typingIndicator: MountableComponent | null = null;
  // An NSFW channel's consent UI: the gate mounted instead of its content, or
  // the withdraw bar above content the reader has consented to.
  let nsfwConsentUi: MountableComponent | null = null;
  // Store/ws subscriptions that keep the composer's disabled state in sync.
  let composerGatingUnsubs: (() => void)[] = [];

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
      attachments: readonly string[];
      // Which channel this cid was actually sent to. chat_send_ok and the
      // SLOW_MODE error are global ws.on subscriptions with no channel_id of
      // their own (OC-0059) — a late frame for a send made in a channel the
      // user has since left must not be attributed to whatever channel is
      // mounted when it arrives.
      channelId: number;
      clientMessageId?: string;
    }
  >();
  // OC-0433: performSend has two dispatch paths — a plain text send with a
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
  function clearSendTimer(id: string): void {
    const owned = sendTimers.get(id);
    if (!owned) return;
    sendTimers.delete(id);
    window.clearTimeout(owned.timer);
    owned.release?.();
  }

  function destroyChannel(): void {
    pendingDeleteManager.cleanup();
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
    // the next visit renders its pre-teardown snapshot as current (OC-0247).
    // Idempotent (no-ops once the flag is already gone), so this is safe
    // alongside mountChannel's existing invalidate of previousChannelId.
    if (currentChannelId !== null) invalidateChannelMessageWindow(currentChannelId);
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
    // open) — it only repairs the server's view.
    if (previousChannelId !== null) {
      markChannelRead(previousChannelId);
      // The server only delivers live broadcasts for the focused channel, so
      // the window being left stops updating the moment focus moves here.
      // Drop its loaded flag so the next visit refetches the live tail
      // instead of rendering the old snapshot as current — setMessages'
      // merge preserves any pending/failed rows across that refetch.
      invalidateChannelMessageWindow(previousChannelId);
    }

    log.info("Switching channel", { channelId, channelName });

    ws.send({
      type: "channel_focus",
      payload: { channel_id: channelId },
    });

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

    function mountConsentBar(): void {
      nsfwConsentUi = createNsfwConsentBar({
        onRevoke: () =>
          api.revokeNsfw(channelId).then(
            () => {
              if (ownsAccountSession()) setNsfwAcknowledged(channelId, false);
            },
            (err: unknown) => {
              log.error("NSFW consent revoke failed", { channelId, error: String(err) });
              if (ownsSession()) showToast(nsfwConsentText("bar.revokeFailed"), "error");
            },
          ),
      });
      nsfwConsentUi.mount(slots.messagesSlot);
    }

    function performSend(
      content: string,
      replyTo: number | null,
      attachments: readonly string[],
      existingClientMessageId?: string,
    ): void {
      const user = currentMessageUser();
      if (user === null || !ownsSession()) return;
      // Sending while viewing a detached history window jumps to present: the
      // optimistic row belongs in the live tail, and addMessage would refuse
      // to append the echo into a detached window anyway. Mirrors
      // onJumpToPresent — reattach clears "loaded" so the tail is refetched.
      if (isWindowDetached(channelId)) {
        reattachToPresent(channelId);
        // OC-0204: while detached, this (already-active) channel could have
        // picked up an unread/mention badge for messages that arrived below
        // the gap (dispatcher.ts's evenIfActive path) — nothing else clears
        // it, since incrementUnread's usual "active channel" skip is exactly
        // what a detached window opts out of. Jumping to present is reading
        // it, so mark it read the same way leaving a channel does.
        markChannelRead(channelId);
        if (channelAbort !== null) {
          void msgCtrl.loadMessages(channelId, channelAbort.signal);
        }
      }
      const timestamp = new Date().toISOString();
      const clientMessageId =
        existingClientMessageId ??
        (supportsMessageDeduplication(owner)
          ? newClientMessageId(pendingMessageRetryFloor(owner))
          : undefined);
      // Set only for a send with a recoverable logical identity: plain text
      // with a client_message_id, no reply and no attachments.
      const persistId = replyTo === null && attachments.length === 0 ? clientMessageId : undefined;
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
            if (ownsSession())
              showToast("Could not save this pending message for recovery after restart", "error");
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
          content,
          replyTo,
          timestamp,
        });
        draftByCorrelation.set(cid, { content, replyTo, attachments, channelId, clientMessageId });
        markSendFailed(cid, "OFFLINE");
        if (persistId !== undefined) {
          // Nothing will deliver this text: it was never handed to a socket, so
          // a failed write means it is gone at restart. Distinguish that from a
          // plain offline row, whose retry window is still open.
          void persistPendingText(persistId).then((saved) => {
            if (!saved && ownsSession()) markSendFailed(cid, "OFFLINE_NO_RECOVERY");
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
            content,
            reply_to: replyTo,
            attachments,
            ...(clientMessageId ? { client_message_id: clientMessageId } : {}),
          },
        });
        addOptimisticMessage({
          correlationId: cid,
          clientMessageId,
          channelId,
          user,
          content,
          replyTo,
          timestamp,
        });
        draftByCorrelation.set(cid, { content, replyTo, attachments, channelId, clientMessageId });
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
      // OC-0433: both branches go through the single controller-scoped
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
      const recovered = recoveredPendingText(owner, correlationId);
      const draft =
        draftByCorrelation.get(correlationId) ??
        (recovered
          ? {
              ...recovered,
              replyTo: null,
              attachments: [] as readonly string[],
            }
          : undefined);
      if (draft === undefined || draft.channelId !== channelId) return;
      if (
        draft.clientMessageId &&
        pendingMessageExpired(draft.clientMessageId, Date.now(), pendingMessageRetryFloor(owner))
      ) {
        showToast(
          "This message's retry window expired. Copy the text to send a new message.",
          "error",
        );
        return;
      }
      if (draft.clientMessageId && !supportsMessageDeduplication(owner)) {
        showToast(
          "This server cannot safely retry a saved message. Copy its text to send it again.",
          "error",
        );
        return;
      }
      draftByCorrelation.delete(correlationId);
      clearSendTimer(correlationId);
      removeOptimistic(correlationId);
      performSend(draft.content, draft.replyTo, draft.attachments, draft.clientMessageId);
    }

    function deleteDraft(correlationId: string): void {
      if (!ownsSession()) return;
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
      const refreshDmHeader = (): void => {
        const dmChannel = dmStore.getState().channels.find((c) => c.channelId === channelId);
        // A group has no single presence to show, so the subtitle lists who is
        // in it instead — that is the fact a group header is asked for, and a
        // first member's status presented as the group's would be a lie.
        let subtitle = "Offline";
        if (dmChannel !== undefined && dmChannel.isGroup) {
          const names = dmChannel.participants.map((p) => (p.displayName ?? "") || p.username);
          subtitle = `${names.length + 1} members: You, ${names.join(", ")}`;
        } else if (dmChannel !== undefined) {
          const member = membersStore.getState().members.get(dmChannel.recipient.id);
          const status = member?.status ?? dmChannel.recipient.status ?? "Offline";
          subtitle = status.charAt(0).toUpperCase() + status.slice(1);
        }
        const headerName = dmChannel !== undefined ? dmDisplayName(dmChannel) : channelName;
        updateChatHeaderForDm(chatHeaderRefs, { username: headerName, status: subtitle });
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
      const topicEl = chatHeaderRefs.topicEl;
      setText(topicEl, channelsStore.getState().channels.get(channelId)?.topic ?? "");
      composerGatingUnsubs.push(
        channelsStore.subscribeSelector(
          (s) => s.channels.get(channelId)?.topic ?? "",
          (topic) => setText(topicEl, topic),
        ),
      );
    } else if (chatHeaderName !== null) {
      setText(chatHeaderName, channelName);
    }

    // NSFW consent gates composition, not just display (B9-7): until the
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
          const focusGate = gateHadFocus || active === null || active === document.body;
          const name = channelsStore.getState().channels.get(channelId)?.name ?? channelName;
          destroyChannel();
          mountChannel(channelId, name, channelType, focusGate);
          if (state === "gated") onContentGated?.();
          else if (gateHadFocus) focusFallback?.();
        },
      ),
    );
    if (gated) {
      clearChannelContent(channelId);
      nsfwConsentUi = createNsfwGate({
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
      });
      nsfwConsentUi.mount(slots.messagesSlot);
      return;
    }

    void msgCtrl.loadMessages(channelId, signal);

    // MessageList
    messageList = createMessageList({
      channelId,
      channelName,
      channelType,
      currentUserId: userId,
      onScrollTop: () => {
        if (channelAbort !== null) {
          return msgCtrl.loadOlderMessages(channelId, channelAbort.signal);
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
        // OC-0204: see performSend's identical call above — a detached
        // active channel's badge (from dispatcher.ts's evenIfActive path)
        // must be cleared here too, or it lingers after the user has jumped
        // back to present and is looking straight at the live tail.
        markChannelRead(channelId);
        if (channelAbort !== null) {
          void msgCtrl.loadMessages(channelId, channelAbort.signal);
        }
      },
      onReplyClick: (msgId: number) => {
        const msgs = getChannelMessages(channelId);
        const msg = msgs.find((m) => m.id === msgId);
        messageInput?.setReplyTo(msgId, msg?.user.username ?? "");
      },
      onEditClick: (msgId: number) => {
        const msgs = getChannelMessages(channelId);
        const msg = msgs.find((m) => m.id === msgId);
        if (msg !== undefined) {
          messageInput?.startEdit(msgId, msg.content);
        }
      },
      onDeleteClick: (msgId: number) => {
        const result = pendingDeleteManager.tryDelete(msgId);
        if (result === "confirmed") {
          ws.send({
            type: "chat_delete",
            payload: { message_id: msgId },
          });
          showToast("Message deleted", "success");
        } else {
          showToast("Click delete again to confirm", "info");
        }
      },
      onReactionClick: (msgId: number, emoji: string) => {
        reactionCtrl.handleReaction(msgId, emoji);
      },
      onPinClick: (msgId: number, chId: number, currentlyPinned: boolean) => {
        const action = currentlyPinned
          ? api.unpinMessage(chId, msgId)
          : api.pinMessage(chId, msgId);
        action
          .then(() => {
            setMessagePinned(chId, msgId, !currentlyPinned);
            showToast(currentlyPinned ? "Message unpinned" : "Message pinned", "success");
          })
          .catch((err) => {
            log.error("Pin/unpin failed", { error: String(err) });
            showToast("Failed to pin/unpin message", "error");
          });
      },
      onRetry: (correlationId: string) => retrySend(correlationId),
      onDeleteDraft: (correlationId: string) => deleteDraft(correlationId),
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
      onSend: (content: string, replyTo: number | null, attachments: readonly string[]) => {
        performSend(content, replyTo, attachments);
      },
      onUploadFile: async (file: File) => {
        try {
          const result = await api.uploadFile(file);
          return { id: result.id, url: result.url, filename: result.filename };
        } catch (err) {
          log.error("File upload failed", { error: String(err) });
          showToast("File upload failed", "error");
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
      onEditMessage: (messageId: number, content: string) => {
        const trimmed = content.trim();
        if (trimmed === "") {
          showToast("Message cannot be empty", "error");
          return;
        }
        const msgs = getChannelMessages(channelId);
        const original = msgs.find((m) => m.id === messageId);
        if (original !== undefined && original.content === trimmed) {
          return;
        }
        ws.send({
          type: "chat_edit",
          payload: { message_id: messageId, content: trimmed },
        });
        showToast("Message edited", "success");
      },
    });
    messageInput.mount(slots.inputSlot);

    // Composer gating: express permission + connection as affordance. The
    // composer disables (with a reason) when the socket is down or the user
    // may not post here, instead of accepting a click and failing. For DM
    // channels the reason also covers block state (channels-members-dms.md §3.2).
    // Slow mode as affordance: after an accepted send the composer disables
    // itself for the channel's cooldown with a live countdown, instead of
    // taking a message the server will bounce with SLOW_MODE (UX spec §5,
    // "do not drop the drafted message" — the draft stays in the textarea).
    let slowModeUntil = 0;
    let slowModeTicker: ReturnType<typeof setInterval> | null = null;

    const stopSlowModeTicker = (): void => {
      if (slowModeTicker !== null) {
        clearInterval(slowModeTicker);
        slowModeTicker = null;
      }
    };

    const slowModeRemaining = (): number =>
      slowModeUntil === 0 ? 0 : Math.max(0, Math.ceil((slowModeUntil - Date.now()) / 1000));

    const computeComposerReason = (): string | null => {
      const status = uiStore.getState().connectionStatus;
      if (status === "reconnecting") return "Reconnecting…";
      if (status === "disconnected") return "Not connected";
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
          ? "Only moderators can post in announcement channels"
          : "You don't have permission to send messages here";
      }
      const remaining = slowModeRemaining();
      if (remaining > 0) return `Slow mode — ${remaining}s`;
      return null;
    };
    const refreshComposerState = (): void => {
      messageInput?.setDisabled(computeComposerReason());
    };

    /**
     * Begin (or restart) the slow-mode cooldown for this channel. Moderators
     * bypass slow mode server-side, so they never get gated here either.
     */
    const startSlowMode = (seconds: number): void => {
      if (seconds <= 0 || canManageMessages()) return;
      slowModeUntil = Date.now() + seconds * 1000;
      refreshComposerState();
      stopSlowModeTicker();
      slowModeTicker = setInterval(() => {
        if (slowModeRemaining() <= 0) {
          slowModeUntil = 0;
          stopSlowModeTicker();
        }
        refreshComposerState();
      }, 1000);
    };
    composerGatingUnsubs.push(stopSlowModeTicker);

    // Both chat_send_ok and the SLOW_MODE error are global ws.on
    // subscriptions carrying no channel_id of their own — only the
    // correlation id ties a frame back to the send that produced it. A send
    // made in a channel the user has since left can still be in flight when
    // its ack/refusal arrives, and by then this listener belongs to whatever
    // channel is newly mounted (OC-0059). Absent/empty correlation ids never
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
    // A refused send restarts the full window: the server's limiter is the
    // authority on when the next one is allowed.
    composerGatingUnsubs.push(
      ws.on("error", (payload, correlationId) => {
        if (payload.code !== "SLOW_MODE") return;
        if (!sentToMountedChannel(correlationId)) return;
        const ch = channelsStore.getState().channels.get(channelId);
        if (ch !== undefined) startSlowMode(ch.slowMode);
      }),
    );

    refreshComposerState();
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
    composerGatingUnsubs.push(
      safetyStore.subscribeSelector(
        (s) => s.timeout,
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
          if (m.user.id === myId && !m.deleted && m.status === "sent") {
            messageInput?.startEdit(m.id, m.content);
            break;
          }
        }
      },
      { signal },
    );
  }

  return {
    mountChannel,
    destroyChannel,
    openFilePicker: () => messageInput?.openFilePicker(),
    get currentChannelId() {
      return currentChannelId;
    },
    get messageList() {
      return messageList;
    },
  };
}
