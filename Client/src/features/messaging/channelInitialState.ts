/** The fresh per-controller state of a channel view. */

import type { QueuedSend } from "./sendQueue";
import type { ComposerDraft, SentAttachment } from "./MessageInput";
import type { ThreadPanelHost } from "../../pages/main-page/ThreadPanelHost";
import type { ChannelControllerOptions } from "../../pages/main-page/ChannelController";
import type { ChannelState } from "../../pages/main-page/channel/channelState";
import type { TrackedEdit } from "../../pages/main-page/channel/channelShared";

export function createChannelState(
  opts: ChannelControllerOptions,
  threadHost: ThreadPanelHost | null,
): ChannelState {
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
  return {
    opts,
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
    threadHost,
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
}
