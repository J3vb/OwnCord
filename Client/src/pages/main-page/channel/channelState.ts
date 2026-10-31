/** The mutable state one channel controller keeps, shared by its modules. */
import type { MountableComponent } from "@lib/text/safeRender";
import type { MessageListComponent } from "@components/MessageList";
import type { SendQueueModule } from "../../../features/messaging/sendQueueLoader";
import type { QueuedSend } from "../../../features/messaging/sendQueue";
import type { MessageController } from "../MessageController";
import type { ReactionController } from "../ReactionController";
import type { ThreadPanelHost } from "../ThreadPanelHost";
import type { ThreadListPopover } from "@components/ThreadListPopover";
import type { ChatHeaderRefs } from "../ChatHeader";
import type { SavedDraft } from "@lib/prefs/savedDrafts";
import type { TrackedEdit } from "./channelShared";
import type { ChannelControllerOptions } from "../ChannelController";
import type { ChannelType, ImportedAuthor, VoiceUploadMeta } from "@lib/types";
import type {
  ComposerDraft,
  MessageInputComponent,
  QueuedAttachment,
  ReplyTarget,
  SentAttachment,
} from "@components/MessageInput";
import type { QueueDeps } from "../../../features/messaging/sendQueue";
import type { SessionScope } from "../../../lib/net/sessionScope";
import type { DmChannel } from "../../../stores/dm.store";
import type { Channel } from "../../../stores/channels.store";

export interface ChannelState {
  readonly opts: ChannelControllerOptions;
  readonly ws: ChannelControllerOptions["ws"];
  readonly api: ChannelControllerOptions["api"];
  readonly msgCtrl: MessageController;
  readonly reactionCtrl: ReactionController;
  readonly typingLimiter: { tryConsume(key?: string): boolean };
  readonly showToast: (msg: string, type: string) => void;
  readonly getCurrentUserId: () => number;
  readonly slots: {
    readonly messagesSlot: HTMLDivElement;
    readonly typingSlot: HTMLDivElement;
    readonly inputSlot: HTMLDivElement;
    readonly threadSlot?: HTMLDivElement;
  };
  readonly chatHeaderName: HTMLSpanElement | null;
  readonly chatHeaderRefs: ChatHeaderRefs | null;
  readonly onContentGated: (() => void) | undefined;
  readonly focusFallback: (() => void) | undefined;
  readonly threadHost: ThreadPanelHost | null;
  threadList: ThreadListPopover | null;
  currentChannelId: number | null;
  channelAbort: AbortController | null;
  readonly pinsInFlight: Set<string>;
  messageList: MessageListComponent | null;
  messageInput: MessageInputComponent | null;
  typingIndicator: MountableComponent | null;
  // An NSFW channel's consent UI: the gate mounted instead of its content, or
  // the withdraw bar above content the reader has consented to.
  nsfwConsentUi: MountableComponent | null;
  // Bumped whenever that UI is torn down, so a lazy load that resolves late
  // cannot mount a gate or bar that no longer belongs to the channel.
  nsfwConsentUiGen: number;
  // Store/ws subscriptions that keep the composer's disabled state in sync.
  composerGatingUnsubs: (() => void)[];
  // Unsent composer state per channel, so switching away and back keeps
  // the text, the reply target, the staged upload ids and any upload still in
  // flight (it keeps running in the draft until restored). Controller-scoped
  // (not per-mount) because the whole point is to outlive a channel switch.
  // Entries are dropped once a send consumes them or the user clears them.
  readonly draftByChannel: Map<number, ComposerDraft>;
  // 3A-3: the mounted composer's text and reply also go to storage, so they
  // survive a restart. Saved a moment after typing stops, and at once when the
  // draft empties or the channel switches.
  draftSaveTimer: ReturnType<typeof setTimeout> | null;
  // The account the mounted composer belongs to, captured at mount, so a late
  // save never files a draft under whoever is signed in by then.
  draftOwner: { host: string; userId: number; current: () => boolean } | null;
  // What was last written, so an edit (whose peeked draft never changes) does
  // not rewrite storage on every key.
  lastSavedDraft: string;
  // When the last accepted send happened (epoch ms) per channel, so the Send
  // gate's countdown survives a channel switch instead of restarting from zero
  // on the remount. The deadline is derived from the channel's CURRENT
  // slow_mode, so an admin changing it while the user is away is followed.
  // `window` is the largest slow_mode (seconds) observed since the send: the
  // server keeps enforcing its largest window, so a temporary reduction must
  // not forget the send time. Controller-scoped like the drafts above, so it
  // dies with the session; an entry is dropped once its largest window passed.
  readonly slowModeSentAtByChannel: Map<number, { sentAt: number; window: number }>;
  // The server prunes its rate-limit timestamps only every few minutes and
  // evaluates the retained ones against the current window, so a raised
  // setting can still reject a send whose largest-observed window has passed.
  readonly SLOW_MODE_RETENTION_MS: number;
  // Optimistic send: keep the raw payload per correlation id so a failed send
  // can be retried (including its attachments). Controller-scoped rather than
  // per-mount: correlation ids are globally unique (crypto.randomUUID), and a
  // failed row survives a channel switch (messages.store carries non-"sent"
  // rows across refetches), so its draft must survive the switch too — a
  // per-mount map left Retry on a failed row that outlived a remount silently
  // inert. Entries are dropped on retry, discard, and the chat_send_ok ack, so
  // controller scope does not turn it into a session-long transcript.
  readonly draftByCorrelation: Map<
    string,
    {
      content: string;
      replyTo: number | null;
      replyPing?: boolean;
      sticker?: { readonly id: number; readonly name: string };
      attachments: readonly SentAttachment[];
      channelId: number;
      userId: number;
      clientMessageId?: string;
      sentAt: number;
    }
  >;
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
  sendChain: Promise<void>;
  sendChainBusy: boolean;
  sendChainGen: number;
  readonly sendTimers: Map<string, { timer: number; release?: () => void }>;
  // 3A-9: a message sent with files still uploading waits here, keyed by its
  // "uploading" row's correlation id, and posts once its uploads land. Like
  // draftByCorrelation it is controller-scoped, so the send keeps going (and
  // posts to its own channel) after a channel switch. The queue module is
  // loaded on the first upload, and kept here once it is.
  readonly queuedSends: Map<string, QueuedSend>;
  sendQueueMod: SendQueueModule | null;
  // chat_edit and chat_delete are fire-and-forget — no ack carries
  // their envelope id back, so before this they were toasted "success" on
  // send and silently dropped by a closed or half-open socket. Track each
  // frame by the id ws.send returns (the same correlation scheme reactions
  // use), resolve it on the server echo, and report a failure instead of a
  // false success. Controller-scoped like draftByCorrelation so a frame in
  // flight across a channel switch keeps its entry; restoration only lands
  // when that channel is the one mounted.
  readonly pendingEdits: Map<string, TrackedEdit>;
  readonly pendingDeletes: Map<string, { channelId: number; messageId: number }>;
  readonly trackTimers: Map<string, number>;
}

/** Every function the channel controller's modules share, filled in once by createChannelController. */
export interface ChannelApi {
  persistDraft(channelId: number, draft: SavedDraft): void;
  saveMountedDraft(): void;
  scheduleDraftSave(): void;
  restoreSavedDraft(channelId: number, input: MessageInputComponent): void;
  putBackUnsent(
    sentTo: number,
    files: readonly SentAttachment[],
    reason: "skipped" | "unavailable",
    replyTo?: number | null,
    ping?: boolean,
  ): void;
  recordSlowModeSend(id: number, seconds: number, sentAt?: number): void;
  slowModeRetained(id: number): boolean;
  slowModeWindowOver(id: number): boolean;
  track<T>(pending: Map<string, T>, id: string, entry: T): void;
  untrack<T>(pending: Map<string, T>, id: string): T | undefined;
  userIsBusyElsewhere(): boolean;
  failEdits(edits: readonly TrackedEdit[], toast: boolean): void;
  clearSendTimer(id: string): void;
  replyTargetOf(msg: {
    readonly id: number;
    readonly user: {
      readonly id: number;
      readonly username: string;
      readonly display_name?: string | null;
    };
    readonly importedAuthor?: ImportedAuthor;
  }): ReplyTarget;
}

/** The values mountChannel() builds, shared by its mount steps. */
export interface MountScope {
  channelId: number;
  channelName: string;
  channelType: ChannelType | undefined;
  focusGate: boolean;
  previousChannelId: number | null;
  // channel_focus (sent below) is the only thing that advances the *new*
  // channel's server-side read state; leaving one never does. Without this,
  // messages read while focused here restate as unread/mention badges on
  // the next full `ready`. mark_read is a local no-op (already zeroed on
  // open) — it only repairs the server's view. With a read pointer, leaving
  // marks only what the reader saw (leaveChannel), never "everything".
  // A forum holds no messages, so it has no read state to repair.
  leftForum: boolean;
  signal: AbortSignal;
  userId: number;
  owner: { host: string; userId: number };
  session: SessionScope;
  ownsAccountSession: () => boolean;
  ownsSession: () => boolean;
  /**
   * Mount the gate or the withdraw bar. Their module (with its catalog) is
   * loaded on first use so only a labelled channel pays for it (B9 shared
   * MainPage budget); the gated path mounts no content while it loads.
   */
  mountConsentUi: (
    build: (ui: typeof import("@components/NsfwGate")) => MountableComponent,
  ) => void;
  mountConsentBar: () => void;
  /** Mirrors onJumpToPresent — reattach clears "loaded" so the tail is refetched. */
  jumpToPresentForSend: () => void;
  /** A reply whose target was deleted while composing sends as a plain message. */
  liveReplyTo: (replyTo: number | null) => number | null;
  // 3A-9: the queue's hooks into this mount. Built here, so a send queued in
  // this channel posts, fails and puts files back for this channel even after
  // the user has switched away.
  queueDeps: (entry: QueuedSend) => QueueDeps;
  /** Show `entry` as an "uploading" row and run it; on Retry it replaces the
   *  failed row under a new id. The entry stays under its old id until the
   *  module has loaded, so a Delete in that window still finds it. Waits for
   *  the lazy module, which the first upload preloaded. A failed entry whose
   *  row vanishes without Delete stays in `queuedSends`, holding its Files,
   *  until teardown. */
  startQueued: (entry: QueuedSend, retry: boolean) => void;
  enqueueSend: (
    content: string,
    replyTo: number | null,
    replyPing: boolean,
    queued: readonly QueuedAttachment[],
  ) => void;
  /** The file upload, shared by the composer and a queued send's re-uploads. */
  uploadFile: (
    file: File,
    uploadSignal?: AbortSignal,
    onProgress?: (fraction: number) => void,
    voice?: VoiceUploadMeta,
  ) => Promise<{ id: string; url: string; filename: string }>;
  performSend: (
    content: string,
    replyTo: number | null,
    files: readonly SentAttachment[],
    existingClientMessageId?: string,
    replyPing?: boolean,
    sendOptions?: {
      readonly queued?: boolean;
      readonly sticker?: { readonly id: number; readonly name: string };
    },
  ) => void;
  retrySend: (correlationId: string) => void;
  /** Withdraw a stored upload that will never be sent; the server sweeps it anyway if this fails. */
  discardQuietly: (id: string) => void;
  deleteDraft: (correlationId: string) => void;
  // Block gating is a 1:1 rule (Discord semantics, mirrored by the server's
  // requireDMNotBlocked): a group DM is a shared room, and gating one
  // member's composer over a block with one other member would leave the
  // group reading a conversation that person cannot join.
  gatedDm: DmChannel | undefined;
  dmRecipientId: number | null;
  // NSFW consent gates composition, not just display: until the
  // server has confirmed this account's acknowledgement, the channel's
  // content is neither mounted nor fetched, and any rows left from before
  // consent was withdrawn are dropped. Any change that crosses the gate —
  // accepted here, revoked here or on another device, relabelled, or
  // restated by a reconnect's ready — remounts the channel on the other
  // side of it; labelling or unlabelling consented content only adds or
  // removes the withdraw bar, so the composer keeps its draft.
  storedChannel: Channel | undefined;
  gated: boolean;
  /** Send the delete frame. A destructive menu action is gated on
   *  the connection; a closed or half-open socket would drop the frame and
   *  leave the moderator thinking the message was deleted. */
  sendDelete: (msgId: number) => void;
  /** The destructive delete confirm, on the shared confirm preset
   *  (features/dialogs/confirmModal.ts): Cancel first and focused, Escape and the backdrop
   *  cancel, focus returns to the opener. Tied to the mounted channel's
   *  signal, so a switch or destroy closes it. */
  /** `onConfirm` runs just before the delete is sent. */
  openDeleteConfirm: (
    msgId: number,
    flow: { readonly onConfirm?: () => void; readonly clicked: boolean },
  ) => void;
  // Restore this channel's stashed draft, if any — its text, reply
  // target and staged upload ids — so a switch away and back is lossless.
  // A reply whose target is gone (deleted while away) is dropped, not
  // restored onto a message the server would refuse the reply to.
  stashedDraft: ComposerDraft | undefined;
  // Composer gating: express permission + connection as affordance. The
  // composer disables (with a reason) when the socket is down or the user
  // may not post here, instead of accepting a click and failing. For DM
  // channels the reason also covers block state (channels-members-dms.md §3.2).
  // Slow mode as affordance: after an accepted send the composer disables
  // itself for the channel's cooldown with a live countdown, instead of
  // taking a message the server will bounce with SLOW_MODE (UX spec §5,
  // "do not drop the drafted message" — the draft stays in the textarea).
  slowModeTicker: ReturnType<typeof setInterval> | null;
  stopSlowModeTicker: () => void;
  slowModeRemaining: () => number;
  computeComposerReason: () => string | null;
  // The standing slow-mode note: shown from the first moment, for anyone
  // slow mode would limit. Not a send gate, so the first send still goes.
  refreshSlowModeNote: () => void;
  refreshComposerState: () => void;
  /**
   * Begin (or restart) the slow-mode cooldown for this channel. Moderators
   * bypass slow mode server-side, so they never get gated here either.
   */
  armSlowModeTicker: () => void;
  startSlowMode: (seconds: number) => void;
  // Both chat_send_ok and the SLOW_MODE error are global ws.on
  // subscriptions carrying no channel_id of their own — only the
  // correlation id ties a frame back to the send that produced it. A send
  // made in a channel the user has since left can still be in flight when
  // its ack/refusal arrives, and by then this listener belongs to whatever
  // channel is newly mounted. Absent/empty correlation ids never
  // happen over the real transport, so fall back to attributing to the
  // mounted channel rather than silently dropping every ack.
  sentToMountedChannel: (correlationId: string | undefined) => boolean;
}
