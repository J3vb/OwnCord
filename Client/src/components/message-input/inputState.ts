/** The mutable state one message input instance keeps, shared by its modules. */
import type { Disposable } from "@lib/disposable";
import type {
  MentionAutocompleteComponent,
  MentionSuggestion,
} from "@components/MentionAutocomplete";
import type { EmojiAutocompleteComponent } from "@components/EmojiAutocomplete";
import type { ChannelAutocompleteComponent } from "@components/ChannelAutocomplete";
import type { SlashAutocompleteComponent } from "@components/SlashAutocomplete";
import type { PickedMention } from "@lib/text/pickedMentions";
import type { VoiceComposer } from "../../features/voice-messages/voiceComposer";
import type {
  MessageInputOptions,
  SentAttachment,
  ReplyTarget,
  ComposerDraft,
  DraftUpload,
} from "../MessageInput";

export interface InputState {
  readonly options: MessageInputOptions;
  readonly disposable: Disposable;
  readonly signal: AbortSignal;
  root: HTMLDivElement | null;
  state: { replyTo: ReplyTarget | null };
  lastTypingTime: number;
  lastSendTime: number;
  textarea: HTMLTextAreaElement | null;
  /** Releases this composer's claim on the member menu's Mention target. */
  releaseComposer: (() => void) | null;
  replyBar: HTMLDivElement | null;
  replyText: HTMLSpanElement | null;
  replyPingBtn: HTMLButtonElement | null;
  disabledReason: string | null;
  /** Slow-mode-style gate: refuses the send without freezing the composer. */
  sendGateReason: string | null;
  /** True once the server has told us GIFs are off, or if no GIF api was wired. */
  gifUnavailable: boolean;
  readonly controlButtons: HTMLButtonElement[];
  /** The voice-message recorder bar, owned by this composer. */
  voice: VoiceComposer | null;
  attachmentPreviewBar: HTMLDivElement | null;
  /** The composer's single refusal line. It stays until the user edits or
   *  sends rather than vanishing after a few seconds (A11Y-05), so it is one
   *  reused node, not a fresh one per call. */
  uploadErrorEl: HTMLDivElement | null;
  slowModeNote: string | null;
  slowModeNoteEl: HTMLDivElement | null;
  charCounter: HTMLSpanElement | null;
  readonly uploadErrorId: string;
  /** Set by mount() when file uploads are wired; backs openFilePicker(). */
  openPicker: (() => void) | null;
  /** Set by mount(); backs togglePicker(). */
  togglePickerOf: ((kind: "emoji" | "gif" | "sticker") => void) | null;
  mentionPopup: MentionAutocompleteComponent | null;
  /** Users and roles picked from the popup for this draft, by the
   *  text now in the textarea. Send turns the spans still intact into id
   *  tokens, on a server that resolves them; an edited span is plain text. */
  pickedMentions: PickedMention[];
  /** The popup row just chosen; insertMention reads it as it inserts the text. */
  pendingPick: MentionSuggestion | null;
  /** Index of the "@" the open popup is completing; -1 when closed. */
  mentionStart: number;
  emojiPopup: EmojiAutocompleteComponent | null;
  /** Index of the ":" the open emoji popup is completing; -1 when closed. */
  emojiStart: number;
  channelPopup: ChannelAutocompleteComponent | null;
  /** Index of the "#" the open channel popup is completing; -1 when closed. */
  channelStart: number;
  /** Open while the whole draft is "/" plus letters (built-in slash commands). */
  slashPopup: SlashAutocompleteComponent | null;
  /** Pending attachment IDs to send with the next message. `upload` is set
   *  exactly while the upload is in flight: Send then queues the message behind
   *  it (3A-9), while a chip past ATTACHMENT_TTL_MS still blocks Send, see
   *  refreshStale. Destroying its owner cancels that upload when the user
   *  removes the preview, and it is detached once the upload succeeds. A `Disposable` rather than a raw AbortController
   *  keeps the upload token in the lifecycle primitives, matching
   *  MessageList's per-row owner. */
  readonly pendingAttachments: {
    id: string;
    filename: string;
    readonly previewEl: HTMLDivElement;
    upload?: DraftUpload;
    uploadedAt?: number;
    /** The picked file, kept so a chip past ATTACHMENT_TTL_MS can re-upload.
     *  Absent on chips restored from an older draft. */
    file?: File;
    /** Past ATTACHMENT_TTL_MS with no file to re-upload from. */
    expired?: boolean;
    /** Put back after a send did not carry it; cleared by a fresh upload. */
    unsent?: boolean;
    /** A draft moved into this file, returned to the composer if the upload fails. */
    draftText?: string;
  }[];
  /** Uploads getDraft() handed to the draft; destroy() leaves them running. */
  readonly handedOff: Set<DraftUpload>;
  /** References to picker close functions, set by mount() for destroy() to call. */
  cleanupPickers: (() => void) | null;
  /** Pending animation frame for a coalesced textarea resize, or null. */
  resizeFrame: number | null;
  /** Timer IDs for cleanup on destroy. */
  readonly activeTimers: Set<ReturnType<typeof setTimeout>>;
  /** Unique counter for preview items (before upload completes and we have a server ID). */
  previewCounter: number;
}

/** Every function the input's modules share, filled in once by createMessageInput. */
export interface InputApi {
  activeMentionToken(): { query: string; start: number } | null;
  closeMentionPopup(): void;
  recordPick(token: string): void;
  insertMention(token: string): void;
  activeEmojiToken(): { query: string; start: number } | null;
  closeEmojiPopup(): void;
  insertEmoji(insert: string): void;
  activeChannelToken(): { query: string; start: number } | null;
  closeChannelPopup(): void;
  insertChannel(name: string): void;
  closeSlashPopup(): void;
  activeSlashQuery(): string | null;
  insertSlashCommand(name: string): void;
  syncSlashPopup(): void;
  syncChannelPopup(): void;
  syncEmojiPopup(): void;
  syncMentionPopup(): void;
  syncAutocomplete(): void;
  insertMentionAtCaret(username: string): boolean;
  applyFormatting(marker: string): void;
  showReplyBar(): void;
  replyPing(): boolean;
  hideReplyBar(): void;
  measureTextarea(): void;
  autoResize(): void;
  autoResizeOnInput(): void;
  updateCounter(): void;
  maybeEmitTyping(): void;
  idlePlaceholder(): string;
  applyDisabledState(): void;
  setDisabled(reason: string | null): void;
  setSendGate(reason: string | null): void;
  setSlowModeNote(text: string | null): void;
  applySlowModeNote(): void;
  setReplyTo(messageId: number, username: string, opts?: Pick<ReplyTarget, "ping" | "self">): void;
  clearReply(): void;
  focus(): void;
  isIdle(): boolean;
  canTakeText(): boolean;
  togglePicker(kind: "emoji" | "gif" | "sticker"): void;
  clearPendingAttachments(): void;
  showUploadError(message: string, action?: { label: string; onClick: () => void }): void;
  createErrorAction(action: { label: string; onClick: () => void }): HTMLButtonElement;
  clearUploadError(): void;
  handleSend(): void;
  canAttachLongText(text: string): boolean;
  sendDraftAsFile(): void;
  pasteLongTextAsFile(e: ClipboardEvent): void;
  wireDropOverlay(container: Element): void;
  isStale(a: InputState["pendingAttachments"][number]): boolean;
  refreshStale(a: InputState["pendingAttachments"][number]): void;
  scheduleExpiry(a: InputState["pendingAttachments"][number]): void;
  discard(id: string): Promise<void> | undefined;
  removePreviewItem(el: HTMLDivElement): void;
  readFileAsDataUrl(file: File): Promise<string>;
  appendPreview(item: HTMLDivElement, file: File | undefined, filename: string): void;
  appendRemoveButton(item: HTMLDivElement, filename: string): void;
  toggleSpoiler(att: InputState["pendingAttachments"][number], btn: HTMLButtonElement): void;
  appendSpoilerButton(item: HTMLDivElement, file: File | undefined): void;
  handlePasteFile(file: File, draftText?: string): Promise<void>;
  startUpload(
    upload: NonNullable<MessageInputOptions["onUploadFile"]>,
    file: File,
    before?: Promise<void>,
  ): DraftUpload;
  runUpload(
    pending: InputState["pendingAttachments"][number],
    file: File,
    before?: Promise<void>,
  ): Promise<void>;
  restoreDraftText(text: string | undefined): void;
  followUpload(
    pending: InputState["pendingAttachments"][number],
    handle: DraftUpload,
  ): Promise<void>;
  openFilePicker(): void;
  peekDraft(): { content: string; replyTo: ReplyTarget | null };
  getDraft(): ComposerDraft;
  restoreDraft(draft: ComposerDraft): void;
  addUnsentChip(att: SentAttachment): boolean;
  restoreUnsent(
    files: readonly SentAttachment[],
    reason: "skipped" | "unavailable",
    replyTo?: ComposerDraft["replyTo"],
  ): void;
}
