/**
 * MessageInput component — textarea with send and reply bar.
 * Step 5.42 of the Tauri v2 migration.
 */

import { Disposable } from "@lib/disposable";
import { isImeCommit } from "@lib/text/ime";
import { dialogOpen } from "@lib/ui/dialogOpen";
import { createElement, appendChildren, setText, setOwnedTimeout } from "@lib/dom";
import { createIcon } from "@lib/icons";
import { errorText } from "@lib/api";
import type { MountableComponent } from "@lib/text/safeRender";
import { createLazyScreen } from "@components/lazyScreen";
import {
  createMentionAutocomplete,
  type MentionAutocompleteComponent,
  type MentionSuggestion,
} from "@components/MentionAutocomplete";
import {
  createEmojiAutocomplete,
  MIN_EMOJI_QUERY,
  type EmojiAutocompleteComponent,
} from "@components/EmojiAutocomplete";
import { listCustomEmoji } from "@stores/emoji.store";
import {
  createChannelAutocomplete,
  type ChannelAutocompleteComponent,
} from "@components/ChannelAutocomplete";
import { claimComposer, focusComposer } from "../features/messaging/activeComposer";
import { emojiCatalog, loadEmojiCatalog } from "../features/messaging/emojiCatalog";
import {
  createSlashAutocomplete,
  type SlashAutocompleteComponent,
} from "@components/SlashAutocomplete";
import { replaceEmojiShortcodes } from "../features/messaging/shortcodes";
import { applyPickedMentions, type PickedMention } from "@lib/text/pickedMentions";
import { idMentionsEnabled } from "@lib/net/serverCapabilities";
import { applySlashCommand } from "../features/messaging/slashCommands";
import { FORMAT_MARKERS, wrapWithMarker } from "../features/messaging/markdownMarkers";
import { MAX_MESSAGE_LEN } from "../features/messaging/messageLimits";
import { ATTACHMENT_TTL_MS } from "../features/messaging/attachmentTtl";
import { isSpoilerFilename, toggleSpoilerFilename } from "../features/messaging/spoilerAttachment";

// The pickers load on their first open, so their code stays out of the
// main-page chunk.
const emojiPickerScreen = createLazyScreen("emoji-picker", () => import("@components/EmojiPicker"));
const gifPickerScreen = createLazyScreen("gif-picker", () => import("@components/GifPicker"));
const stickerPickerScreen = createLazyScreen(
  "sticker-picker",
  () => import("@components/StickerPicker"),
);

export { wrapWithMarker };
import { authStore } from "@stores/auth.store";
import { pollsEnabled, stickersEnabled, voiceMessagesEnabled } from "@lib/net/serverCapabilities";
import { onPrefChange } from "@lib/prefs/preferences";
import {
  COMPOSER_BUTTON_PREF_KEYS,
  composerButtonShown,
} from "../features/messaging/composerButtons";
import { currentUserRoleHasPermission } from "@lib/permissions";
import { Permission, type VoiceUploadMeta } from "@lib/types";
import {
  createExpressionPopup,
  type ExpressionPanel,
  type ExpressionPopup,
  type ExpressionTab,
} from "@components/ExpressionPopup";
import type { VoiceComposer } from "../features/voice-messages/voiceComposer";
import { voiceMessagesText } from "../i18n/voiceMessages";
import { messagingText } from "../i18n/messaging";
import { stickersText } from "../i18n/stickers";
import type { GifApi, GifFavoritesApi } from "@lib/media/gifProvider";

export interface MessageInputOptions {
  readonly channelId: number;
  readonly channelName: string;
  /**
   * GIF endpoints on the user's own server. Omit to hide the GIF affordance
   * entirely — the button is rendered disabled rather than offering a picker
   * that cannot load.
   */
  readonly gifApi?: GifApi & GifFavoritesApi;
  readonly onSend: (
    content: string,
    replyTo: number | null,
    attachments: readonly string[],
    files: readonly SentAttachment[],
    /** Whether a reply mentions the author it answers (3A-12). False with no reply. */
    replyPing: boolean,
    /** Set when an upload was still running (3A-9): every chip in chip order,
     *  the running ones with their handle. `attachments`/`files` then carry
     *  only the settled ones, and the host posts the message once all land. */
    queued?: readonly QueuedAttachment[],
  ) => void;
  readonly onUploadFile?: (
    file: File,
    signal?: AbortSignal,
    onProgress?: (fraction: number) => void,
    /** Set for a voice message: its length and waveform ride the upload. */
    voice?: VoiceUploadMeta,
  ) => Promise<{ id: string; url: string; filename: string }>;
  /** Withdraw an upload that will never be sent, so its quota is free at
   *  once. Best effort: a rejection is ignored. */
  readonly onDiscardUpload?: (id: string) => Promise<void>;
  readonly onTyping: () => void;
  /**
   * Opens the poll dialog. Omit to leave the Poll button out; it is
   * also left out on a server that does not advertise polls.
   */
  readonly onCreatePoll?: () => void;
  /**
   * Sends a custom sticker at once: `replyTo` and `replyPing` are the
   * pending reply, if any. Omit to leave the sticker button and tab out; they
   * are also left out on a server that does not advertise stickers.
   */
  readonly onSendSticker?: (
    sticker: { readonly id: number; readonly name: string },
    replyTo: number | null,
    replyPing: boolean,
  ) => void;
  /** The draft's text or reply changed; read it back with peekDraft(). */
  readonly onDraftChange?: () => void;
  /** Initial disabled reason (e.g. read-only / no-permission / offline). */
  readonly disabledReason?: string | null;
  /** Replaces the "Message #channel" placeholder (a text-only thread composer). */
  readonly placeholder?: string;
  /** Leave the "+" attach button out (a text-only thread composer). */
  readonly noAttach?: boolean;
}

/** A file a send carried, kept so one the server did not attach can go back
 *  into the composer (2A-3). `file` is absent on a chip restored from an older
 *  draft, so that chip cannot re-upload. */
export interface SentAttachment {
  readonly id: string;
  readonly filename: string;
  readonly file?: File;
}

/** One chip of a send queued behind its uploads (3A-9). A settled chip has
 *  `id` and `uploadedAt`; a running one has `upload`, whose handle the host
 *  takes over (its `onProgress` slot is free). `file` lets the host re-upload. */
export interface QueuedAttachment {
  readonly filename: string;
  readonly file?: File;
  readonly id?: string;
  readonly uploadedAt?: number;
  readonly upload?: DraftUpload;
}

/** The message a draft replies to. `username` is the name the bar shows (the
 *  display name when there is one); `ping` is the bar's @ON/@OFF toggle,
 *  absent meaning ON; `self` hides the toggle on a reply to your own message or to
 *  an imported one (nobody to ping). */
export interface ReplyTarget {
  readonly messageId: number;
  readonly username: string;
  readonly ping?: boolean;
  readonly self?: boolean;
}

/** A channel's unsent composer state, captured before a channel switch and
 *  restored when the user returns. Uploads settled before the switch
 *  keep their server id; an upload still in flight rides along in `uploads`. */
export interface ComposerDraft {
  readonly content: string;
  readonly replyTo: ReplyTarget | null;
  /** Users and roles picked from the mention popup. */
  readonly picks?: readonly PickedMention[];
  readonly attachments: readonly {
    readonly id: string;
    readonly filename: string;
    /** Date.now() when the upload settled; ages the chip on restore. */
    readonly uploadedAt: number;
    /** The picked file, so a restored chip past its age can re-upload. */
    readonly file?: File;
    /** A file a send did not carry: it comes back in its error state. */
    readonly unsent?: boolean;
  }[];
  /** Uploads still running when the composer was torn down. They keep going
   *  and the composer that restores the draft shows them again. */
  readonly uploads?: readonly DraftUpload[];
}

/** One running upload, owned by the draft between composers. */
export interface DraftUpload {
  readonly filename: string;
  readonly file: File;
  /** Destroying it cancels the upload. */
  readonly owner: Disposable;
  /** Resolves with the server's id; rejects on failure or cancel. */
  readonly result: Promise<{ readonly id: string; readonly filename: string }>;
  /** Date.now() when `result` resolved, else undefined. */
  readonly settledAt: number | undefined;
  /** Last reported progress, null before the first tick. */
  readonly fraction: number | null;
  /** The chip showing this upload sets this to drive its progress bar. */
  onProgress: ((fraction: number) => void) | null;
  /** Set while this upload refreshes a stale chip: the chip's old id and
   *  age, so a failed refresh keeps the chip even after a channel switch. */
  refreshing: { readonly id: string; readonly uploadedAt: number } | null;
}

export type MessageInputComponent = MountableComponent & {
  setReplyTo(messageId: number, username: string, opts?: Pick<ReplyTarget, "ping" | "self">): void;
  clearReply(): void;
  /** Put the caret back in the composer (the inline editor closed). */
  focus(): void;
  /**
   * Insert `@username ` at the caret (member menu's Mention). Returns false,
   * and leaves the draft alone, when the composer is not mounted, disabled or
   * read-only.
   */
  insertMention(username: string): boolean;
  /** Capture the current unsent state so a channel switch can carry it. */
  getDraft(): ComposerDraft;
  /** Restore a previously captured draft into this (fresh) composer. */
  restoreDraft(draft: ComposerDraft): void;
  /** The draft's text and reply, with none of getDraft()'s upload hand-off. */
  peekDraft(): { readonly content: string; readonly replyTo: ReplyTarget | null };
  /**
   * Put back files a send did not carry, as chips in their error state, and
   * the send's reply target when the composer has no reply of its own.
   */
  restoreUnsent(
    files: readonly SentAttachment[],
    reason: "skipped" | "unavailable",
    replyTo?: ComposerDraft["replyTo"],
  ): void;
  /** True when the composer holds no text, reply or attachment. */
  isIdle(): boolean;
  /**
   * Disable the composer with a visible reason (permission / connection), or
   * pass null to re-enable. Permission is expressed as affordance: a send that
   * the server would refuse is prevented here, not attempted and rejected.
   */
  setDisabled(reason: string | null): void;
  /**
   * Gate sending only, leaving the composer editable (slow mode). The reason
   * shows on a refused send and greys the send control; the user can keep
   * editing the draft. Pass null to lift.
   */
  setSendGate(reason: string | null): void;
  /**
   * Show a persistent note under the composer (slow mode is on), or hide it
   * with null. Unlike setSendGate it never refuses a send: it only tells the
   * user about the limit before the first message.
   */
  setSlowModeNote(text: string | null): void;
  /**
   * Open the attachment file picker, as the "+" button does. Backs the
   * Ctrl+Shift+U shortcut. No-op while the composer is disabled or when the host
   * didn't wire an upload handler.
   */
  openFilePicker(): void;
  /** Open or close the emoji, sticker or GIF tab of the expression popup, as
   *  its button does (Ctrl+E, Ctrl+G). No-op while that button is disabled or absent. */
  togglePicker(kind: "emoji" | "gif" | "sticker"): void;
};

const TYPING_THROTTLE_MS = 3_000;
const MAX_TEXTAREA_HEIGHT = 200;
const SEND_DEBOUNCE_MS = 200;
// The server's per-file cap arrives on auth_ok (upload_policy); an older
// server that omits it falls back to its 100 MiB request cap, and an
// advertised 0 means uploads are disabled on that server.
// The server stays authoritative: this only refuses a doomed upload early.
const FALLBACK_MAX_FILE_SIZE = 100 * 1024 * 1024;

/** True when this server advertised max_upload_bytes 0 (uploads disabled). */
function uploadsDisabledByServer(): boolean {
  return authStore.getState().uploadPolicy?.max_upload_bytes === 0;
}

/**
 * The extension this server's file-type policy refuses `name` for ("" for a
 * name with none in allow-only mode), or null when it is allowed. Mirrors the
 * server's check: case-insensitive, the final extension only, trailing dots
 * and spaces ignored.
 */
function refusedExtension(name: string): string | null {
  const policy = authStore.getState().uploadPolicy;
  const trimmed = name.toLowerCase().replace(/[. ]+$/, "");
  const dot = trimmed.lastIndexOf(".");
  const ext = dot < 0 ? "" : trimmed.slice(dot + 1).trim();
  if (policy?.blocked_extensions?.includes(ext) === true) return ext;
  const allowed = policy?.allowed_extensions ?? [];
  return allowed.length === 0 || allowed.includes(ext) ? null : ext;
}
// Server/ws/command.go rejects the whole chat_send frame (as a generic parse
// error, not an attachment-specific one) once len(Attachments) > 10 -- cap
// the queue client-side so we never upload an attachment doomed to be
// orphaned by a send that can never succeed.
const MAX_ATTACHMENTS = 10;
// The counter shows once this few characters are left, as Discord's does.
const COUNTER_FROM_REMAINING = 200;
/** Where a file dragged in from the OS is accepted. */
const DROP_SLOTS = ".messages-slot, .typing-slot, .input-slot";
/** The file a too-long paste becomes, the name Discord gives it. */
const LONG_PASTE_FILENAME = "message.txt"; // i18n-exempt: a file name, not UI text
/** Makes each composer's refusal-line id unique for aria-describedby. */
let nextComposerId = 0;

/**
 * Keys that move the caret without an open autocomplete popup claiming them,
 * so the popup has to be resynced against the new caret on keyup. The popup's
 * own keys are deliberately absent: it consumes ArrowUp/ArrowDown/Enter/Tab
 * (so the caret does not move) and Escape closes it, and resyncing after any
 * of those would reset the highlighted row or reopen what Escape dismissed.
 */
const CARET_MOVE_KEYS: ReadonlySet<string> = new Set([
  "ArrowLeft",
  "ArrowRight",
  "Home", // i18n-exempt: KeyboardEvent.key value, a wire identifier, never displayed
  "End", // i18n-exempt: KeyboardEvent.key value, a wire identifier, never displayed
  "PageUp",
  "PageDown",
]);

/** Disable the GIF button and say why, instead of silently doing nothing. */
function markGifUnavailable(gifBtn: HTMLButtonElement, reason: string): void {
  gifBtn.setAttribute("disabled", "true");
  gifBtn.title = reason;
  gifBtn.setAttribute("aria-label", messagingText("gif.ariaWithReason", { reason }));
}

/** File-icon + filename label for a non-image attachment chip. */
function fileLabel(filename: string): [HTMLDivElement, HTMLSpanElement] {
  const icon = createElement("div", { class: "attachment-preview-file" });
  icon.appendChild(createIcon("file-text", 16));
  const nameEl = createElement("span", { class: "attachment-preview-name" }, filename);
  return [icon, nameEl];
}

function appendFileLabel(item: HTMLDivElement, filename: string): void {
  appendChildren(item, ...fileLabel(filename));
}

/** Image types the webview cannot draw. Chat shows them through the server's
 *  JPEG preview once sent; before that the composer has only the file. */
const UNDRAWABLE_IMAGE_MIMES = new Set(["image/heic", "image/heif", "image/tiff"]);

/** Whether the composer can preview `file` from its own bytes. */
function isPreviewableImage(file: File): boolean {
  const base = file.type.split(";")[0]!.trim().toLowerCase();
  return base.startsWith("image/") && !UNDRAWABLE_IMAGE_MIMES.has(base);
}

/** Rename a chip's visible labels after its file was renamed. */
function relabelChip(item: HTMLDivElement, filename: string): void {
  const nameEl = item.querySelector(".attachment-preview-name");
  if (nameEl !== null) nameEl.textContent = filename;
  const img = item.querySelector("img");
  if (img !== null) img.alt = filename;
  item
    .querySelector(".attachment-preview-remove")
    ?.setAttribute("aria-label", messagingText("attach.remove", { filename }));
}

/** The spoiler toggle's pressed state for the file's current name. Its label
 *  is fixed: the state is carried by aria-pressed alone. */
function paintSpoilerButton(btn: HTMLButtonElement, filename: string): void {
  const marked = isSpoilerFilename(filename);
  btn.setAttribute("aria-pressed", String(marked));
  btn.classList.toggle("active", marked);
}

export function createMessageInput(options: MessageInputOptions): MessageInputComponent {
  const disposable = new Disposable();
  const signal = disposable.signal;
  let root: HTMLDivElement | null = null;
  let state = {
    replyTo: null as ReplyTarget | null,
  };
  let lastTypingTime = 0;
  let lastSendTime = 0;

  let textarea: HTMLTextAreaElement | null = null;
  /** Releases this composer's claim on the member menu's Mention target. */
  let releaseComposer: (() => void) | null = null;
  let replyBar: HTMLDivElement | null = null;
  let replyText: HTMLSpanElement | null = null;
  let replyPingBtn: HTMLButtonElement | null = null;
  let disabledReason: string | null = options.disabledReason ?? null;
  /** Slow-mode-style gate: refuses the send without freezing the composer. */
  let sendGateReason: string | null = null;
  /** True once the server has told us GIFs are off, or if no GIF api was wired. */
  let gifUnavailable = options.gifApi === undefined;
  const controlButtons: HTMLButtonElement[] = [];
  /** The voice-message recorder bar, owned by this composer. */
  let voice: VoiceComposer | null = null;
  let attachmentPreviewBar: HTMLDivElement | null = null;
  /** The composer's single refusal line. It stays until the user edits or
   *  sends rather than vanishing after a few seconds (A11Y-05), so it is one
   *  reused node, not a fresh one per call. */
  let uploadErrorEl: HTMLDivElement | null = null;
  let slowModeNote: string | null = null;
  let slowModeNoteEl: HTMLDivElement | null = null;
  let charCounter: HTMLSpanElement | null = null;
  const uploadErrorId = `composer-refusal-${++nextComposerId}`;
  /** Set by mount() when file uploads are wired; backs openFilePicker(). */
  let openPicker: (() => void) | null = null;
  /** Set by mount(); backs togglePicker(). */
  let togglePickerOf: ((kind: "emoji" | "gif" | "sticker") => void) | null = null;
  let mentionPopup: MentionAutocompleteComponent | null = null;
  /** Users and roles picked from the popup for this draft, by the
   *  text now in the textarea. Send turns the spans still intact into id
   *  tokens, on a server that resolves them; an edited span is plain text. */
  let pickedMentions: PickedMention[] = [];
  /** The popup row just chosen; insertMention reads it as it inserts the text. */
  let pendingPick: MentionSuggestion | null = null;
  /** Index of the "@" the open popup is completing; -1 when closed. */
  let mentionStart = -1;
  let emojiPopup: EmojiAutocompleteComponent | null = null;
  /** Index of the ":" the open emoji popup is completing; -1 when closed. */
  let emojiStart = -1;
  let channelPopup: ChannelAutocompleteComponent | null = null;
  /** Index of the "#" the open channel popup is completing; -1 when closed. */
  let channelStart = -1;
  /** Open while the whole draft is "/" plus letters (built-in slash commands). */
  let slashPopup: SlashAutocompleteComponent | null = null;

  /** Pending attachment IDs to send with the next message. `upload` is set
   *  exactly while the upload is in flight: Send then queues the message behind
   *  it (3A-9), while a chip past ATTACHMENT_TTL_MS still blocks Send, see
   *  refreshStale. Destroying its owner cancels that upload when the user
   *  removes the preview, and it is detached once the upload succeeds. A `Disposable` rather than a raw AbortController
   *  keeps the upload token in the lifecycle primitives, matching
   *  MessageList's per-row owner. */
  const pendingAttachments: {
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
  }[] = [];
  /** Uploads getDraft() handed to the draft; destroy() leaves them running. */
  const handedOff = new Set<DraftUpload>();
  /** References to picker close functions, set by mount() for destroy() to call. */
  let cleanupPickers: (() => void) | null = null;
  /** Pending animation frame for a coalesced textarea resize, or null. */
  let resizeFrame: number | null = null;
  /** Timer IDs for cleanup on destroy. */
  const activeTimers: Set<ReturnType<typeof setTimeout>> = new Set();

  /**
   * The @token immediately before the caret, or null. The leading boundary
   * mirrors the server's mention rule, so the popup never offers a completion
   * for text ("mail@dom") that a send would not resolve as a mention.
   */
  function activeMentionToken(): { query: string; start: number } | null {
    if (textarea === null) return null;
    const caret = textarea.selectionStart;
    const before = textarea.value.slice(0, caret);
    const match = /(?:^|[^\p{L}\p{N}_@])@([\p{L}\p{N}_.-]{0,64})$/u.exec(before);
    if (match === null) return null;
    const query = match[1] ?? "";
    return { query, start: caret - query.length - 1 };
  }

  function closeMentionPopup(): void {
    if (mentionPopup === null) return;
    mentionPopup.destroy();
    mentionPopup = null;
    mentionStart = -1;
    pendingPick = null;
  }

  /** Remember that the text `@token` stands for the picked user or role. */
  function recordPick(token: string): void {
    const pick = pendingPick;
    pendingPick = null;
    if (pick === null || pick.token !== token || !idMentionsEnabled()) return;
    const id = pick.kind === "role" ? pick.roleId : pick.userId;
    if (id === null) return;
    const picked = { text: `@${token}`, token: pick.kind === "role" ? `<@&${id}>` : `<@${id}>` };
    if (!pickedMentions.some((p) => p.text === picked.text && p.token === picked.token)) {
      pickedMentions.push(picked);
    }
  }

  /** Replace the token under the caret with "@token ". */
  function insertMention(token: string): void {
    // The popup can outlive the token it was opened over: a caret move the
    // composer never observed (Ctrl+A, a programmatic selection) leaves
    // mentionStart pointing at an offset the caret no longer follows, and
    // splicing there garbles the draft instead of completing it. Re-derive
    // the token and only commit while it still starts where the popup thinks.
    const active = activeMentionToken();
    if (textarea === null || mentionStart < 0 || active === null || active.start !== mentionStart) {
      closeMentionPopup();
      return;
    }
    const caret = textarea.selectionStart;
    const before = textarea.value.slice(0, mentionStart);
    const after = textarea.value.slice(caret);
    const inserted = `@${token} `;
    textarea.value = before + inserted + after;
    recordPick(token);
    const pos = before.length + inserted.length;
    textarea.selectionStart = pos;
    textarea.selectionEnd = pos;
    closeMentionPopup();
    autoResize();
    textarea.focus();
  }

  /**
   * The `:token` immediately before the caret, or null. The leading boundary
   * keeps the popup out of ordinary prose: a colon that follows a word ("see
   * this:thing", a "10:30" clock, an "http://" scheme) is punctuation, not the
   * start of a shortcode. A completed `:token:` is skipped too — it is already
   * an emoji, and re-offering completions over it would fight the user.
   */
  function activeEmojiToken(): { query: string; start: number } | null {
    if (textarea === null) return null;
    const caret = textarea.selectionStart;
    const before = textarea.value.slice(0, caret);
    const match = /(?:^|\s):([A-Za-z0-9_]{0,32})$/.exec(before);
    if (match === null) return null;
    const query = match[1] ?? "";
    if (query.length < MIN_EMOJI_QUERY) return null;
    return { query, start: caret - query.length - 1 };
  }

  function closeEmojiPopup(): void {
    if (emojiPopup === null) return;
    emojiPopup.destroy();
    emojiPopup = null;
    emojiStart = -1;
  }

  /** Replace the `:token` under the caret with the chosen emoji, plus a space. */
  function insertEmoji(insert: string): void {
    // Same staleness guard as insertMention: never splice at an anchor the
    // caret has since moved away from.
    const active = activeEmojiToken();
    if (textarea === null || emojiStart < 0 || active === null || active.start !== emojiStart) {
      closeEmojiPopup();
      return;
    }
    const caret = textarea.selectionStart;
    const before = textarea.value.slice(0, emojiStart);
    const after = textarea.value.slice(caret);
    const inserted = `${insert} `;
    textarea.value = before + inserted + after;
    const pos = before.length + inserted.length;
    textarea.selectionStart = pos;
    textarea.selectionEnd = pos;
    closeEmojiPopup();
    autoResize();
    textarea.focus();
  }

  /**
   * The `#token` immediately before the caret, or null. It opens only after
   * whitespace or at the start, so "C#" and "issue#12" stay text; a heading's
   * "# " closes it at the space.
   */
  function activeChannelToken(): { query: string; start: number } | null {
    if (textarea === null) return null;
    const caret = textarea.selectionStart;
    const before = textarea.value.slice(0, caret);
    const match = /(?:^|\s)#([\p{L}\p{N}_-]{0,64})$/u.exec(before);
    if (match === null) return null;
    const query = match[1] ?? "";
    return { query, start: caret - query.length - 1 };
  }

  function closeChannelPopup(): void {
    if (channelPopup === null) return;
    channelPopup.destroy();
    channelPopup = null;
    channelStart = -1;
  }

  /** Replace the `#token` under the caret with "#name ". */
  function insertChannel(name: string): void {
    // Same staleness guard as insertMention.
    const active = activeChannelToken();
    if (textarea === null || channelStart < 0 || active === null || active.start !== channelStart) {
      closeChannelPopup();
      return;
    }
    const caret = textarea.selectionStart;
    const before = textarea.value.slice(0, channelStart);
    const after = textarea.value.slice(caret);
    const inserted = `#${name} `;
    textarea.value = before + inserted + after;
    const pos = before.length + inserted.length;
    textarea.selectionStart = pos;
    textarea.selectionEnd = pos;
    closeChannelPopup();
    autoResize();
    textarea.focus();
  }

  function closeSlashPopup(): void {
    if (slashPopup === null) return;
    slashPopup.destroy();
    slashPopup = null;
  }

  /** The letters after a "/" when the draft is nothing but "/word", else null. */
  function activeSlashQuery(): string | null {
    if (textarea === null) return null;
    const match = /^\/([A-Za-z]*)$/.exec(textarea.value);
    return match === null ? null : (match[1] ?? "");
  }

  /** Replace the "/word" draft with "/name ". */
  function insertSlashCommand(name: string): void {
    if (textarea === null || activeSlashQuery() === null) {
      closeSlashPopup();
      return;
    }
    const inserted = `/${name} `;
    textarea.value = inserted;
    textarea.selectionStart = inserted.length;
    textarea.selectionEnd = inserted.length;
    closeSlashPopup();
    autoResize();
    textarea.focus();
  }

  /** Open, refilter, or close the slash-command popup for the current draft. */
  function syncSlashPopup(): void {
    const query = disabledReason === null ? activeSlashQuery() : null;
    if (query === null) {
      closeSlashPopup();
      return;
    }
    if (slashPopup === null) {
      slashPopup = createSlashAutocomplete({
        onSelect: insertSlashCommand,
        onClose: closeSlashPopup,
        comboboxInput: textarea ?? undefined,
      });
      root?.appendChild(slashPopup.element);
    }
    if (!slashPopup.setQuery(query)) {
      closeSlashPopup();
    }
  }

  /** Open, refilter, or close the channel popup for whatever is under the caret. */
  function syncChannelPopup(): void {
    const active = disabledReason === null ? activeChannelToken() : null;
    if (active === null) {
      closeChannelPopup();
      return;
    }
    if (channelPopup === null) {
      channelPopup = createChannelAutocomplete({
        onSelect: insertChannel,
        onClose: closeChannelPopup,
        comboboxInput: textarea ?? undefined,
      });
      root?.appendChild(channelPopup.element);
    }
    channelStart = active.start;
    if (!channelPopup.setQuery(active.query)) {
      closeChannelPopup();
    }
  }

  /** Open, refilter, or close the emoji popup for whatever is under the caret. */
  function syncEmojiPopup(): void {
    const active = disabledReason === null ? activeEmojiToken() : null;
    if (active === null) {
      closeEmojiPopup();
      return;
    }
    // The Unicode set is a lazy chunk: the first `:token` loads it, and the
    // popup re-syncs once it lands, so a Unicode-only match still opens. A
    // failed load leaves custom emoji only until the next keystroke retries.
    if (emojiCatalog() === null) {
      void loadEmojiCatalog().then(
        () => {
          if (!signal.aborted) syncEmojiPopup();
        },
        () => undefined,
      );
    }
    if (emojiPopup === null) {
      emojiPopup = createEmojiAutocomplete({
        onSelect: insertEmoji,
        onClose: closeEmojiPopup,
        // The popup manages combobox/aria-activedescendant state on the
        // textarea for as long as it is open.
        comboboxInput: textarea ?? undefined,
      });
      root?.appendChild(emojiPopup.element);
    }
    emojiStart = active.start;
    if (!emojiPopup.setQuery(active.query)) {
      closeEmojiPopup();
    }
  }

  /** Apply a formatting marker to the current textarea selection. */
  function applyFormatting(marker: string): void {
    if (textarea === null || disabledReason !== null) return;
    const result = wrapWithMarker(
      textarea.value,
      textarea.selectionStart,
      textarea.selectionEnd,
      marker,
    );
    textarea.value = result.value;
    textarea.selectionStart = result.selectionStart;
    textarea.selectionEnd = result.selectionEnd;
    autoResize();
    maybeEmitTyping();
  }

  /** Open, refilter, or close the popup for whatever is under the caret. */
  function syncMentionPopup(): void {
    const active = disabledReason === null ? activeMentionToken() : null;
    if (active === null) {
      closeMentionPopup();
      return;
    }
    if (mentionPopup === null) {
      mentionPopup = createMentionAutocomplete({
        onSelect: insertMention,
        onPick: (suggestion) => {
          pendingPick = suggestion;
        },
        onClose: closeMentionPopup,
        channelId: options.channelId,
        // The popup manages combobox/aria-activedescendant state on the
        // textarea for as long as it is open.
        comboboxInput: textarea ?? undefined,
      });
      root?.appendChild(mentionPopup.element);
    }
    mentionStart = active.start;
    if (!mentionPopup.setQuery(active.query)) {
      closeMentionPopup();
    }
  }

  /**
   * Drive both completion popups from one caret position. Only one can be open:
   * the caret sits in exactly one token, and two stacked popups over the same
   * textarea would race for the arrow keys.
   */
  function syncAutocomplete(): void {
    // A "/word" draft has no "@", "#" or ":" token, so the slash popup never
    // competes with the others; it only needs to leave them closed.
    syncSlashPopup();
    if (slashPopup !== null) {
      closeMentionPopup();
      closeChannelPopup();
      closeEmojiPopup();
      return;
    }
    syncMentionPopup();
    if (mentionPopup !== null) {
      closeChannelPopup();
      closeEmojiPopup();
      return;
    }
    syncChannelPopup();
    if (channelPopup !== null) {
      closeEmojiPopup();
      return;
    }
    syncEmojiPopup();
  }

  function showReplyBar(): void {
    const reply = state.replyTo;
    if (replyBar === null || replyText === null || reply === null) return;
    setText(replyText, messagingText("reply.replyingTo", { username: reply.username }));
    if (replyPingBtn !== null) {
      const on = reply.ping !== false;
      replyPingBtn.hidden = reply.self === true;
      replyPingBtn.classList.toggle("off", !on);
      replyPingBtn.setAttribute("aria-pressed", String(on));
      setText(replyPingBtn, messagingText(on ? "reply.pingOn" : "reply.pingOff"));
    }
    replyBar.classList.add("visible");
  }

  /** The reply's @ON/@OFF: false for no reply or a reply to yourself. */
  function replyPing(): boolean {
    const reply = state.replyTo;
    return reply !== null && reply.self !== true && reply.ping !== false;
  }

  function hideReplyBar(): void {
    replyBar?.classList.remove("visible");
  }

  /** The one auto/measure cycle: setting "auto" then reading scrollHeight
   *  forces a synchronous layout, so it runs once per frame at most. Any
   *  frame still pending is dropped, its work done here. */
  function measureTextarea(): void {
    if (resizeFrame !== null) {
      cancelAnimationFrame(resizeFrame);
      resizeFrame = null;
    }
    if (textarea === null) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, MAX_TEXTAREA_HEIGHT)}px`;
  }

  /** Programmatic changes (send, draft restore, completions, formatting)
   *  resize synchronously so the next read sees the final height. */
  function autoResize(): void {
    if (textarea === null) return;
    measureTextarea();
    updateCounter();
    options.onDraftChange?.();
  }

  /** Typing: the counter and draft hook stay per-keystroke, but the layout
   *  measure is coalesced to one per animation frame (before paint, so the
   *  user sees the same height as a synchronous resize). A textarea never
   *  measured yet gets its first height at once. */
  function autoResizeOnInput(): void {
    if (textarea === null) return;
    if (textarea.style.height === "") {
      autoResize();
      return;
    }
    resizeFrame ??= requestAnimationFrame(() => {
      resizeFrame = null;
      measureTextarea();
    });
    updateCounter();
    options.onDraftChange?.();
  }

  /** Characters left near the limit, red past it. Every change to the text,
   *  typed or programmatic (formatting, completions), goes through
   *  autoResize(), so the counter and the draft hook are driven from there. */
  function updateCounter(): void {
    if (charCounter === null || textarea === null) return;
    const left = MAX_MESSAGE_LEN - [...textarea.value.trim()].length;
    const show = left <= COUNTER_FROM_REMAINING;
    charCounter.hidden = !show;
    if (!show) return;
    setText(charCounter, String(left));
    charCounter.classList.toggle("over", left < 0);
    charCounter.title = messagingText(left < 0 ? "counter.over" : "counter.left", {
      count: String(Math.abs(left)),
    });
  }

  function maybeEmitTyping(): void {
    const now = Date.now();
    if (now - lastTypingTime >= TYPING_THROTTLE_MS) {
      lastTypingTime = now;
      options.onTyping();
    }
  }

  function clearPendingAttachments(): void {
    for (const att of pendingAttachments) {
      att.previewEl.remove();
    }
    pendingAttachments.length = 0;
    if (attachmentPreviewBar !== null) {
      attachmentPreviewBar.classList.remove("visible");
    }
  }

  function showUploadError(message: string, action?: { label: string; onClick: () => void }): void {
    if (attachmentPreviewBar === null) return;
    // One persistent refusal line: the user needs to read it after the fact,
    // so it is not removed on a timer (A11Y-05). It is cleared by its own
    // dismiss button, the next edit or a successful send (clearUploadError).
    // A line already showing only swaps its text, so a ticking reason (slow
    // mode refreshes every second) never takes focus off the dismiss button.
    const shownText = uploadErrorEl?.querySelector(".attachment-upload-error-text");
    if (shownText) {
      shownText.textContent = message;
      uploadErrorEl?.querySelector(".attachment-upload-error-action")?.remove();
      if (action) {
        uploadErrorEl?.insertBefore(
          createErrorAction(action),
          uploadErrorEl.querySelector(".attachment-upload-error-dismiss"),
        );
      }
      return;
    }
    uploadErrorEl = createElement("div", {
      class: "attachment-upload-error",
      id: uploadErrorId,
    });
    uploadErrorEl.appendChild(
      createElement("span", { class: "attachment-upload-error-text" }, message),
    );
    if (action) uploadErrorEl.appendChild(createErrorAction(action));
    const dismissBtn = createElement("button", {
      class: "attachment-upload-error-dismiss",
      type: "button",
      "aria-label": messagingText("error.dismiss"),
    });
    dismissBtn.appendChild(createIcon("x", 14));
    dismissBtn.addEventListener(
      "click",
      () => {
        clearUploadError();
        textarea?.focus();
      },
      { signal },
    );
    uploadErrorEl.appendChild(dismissBtn);
    textarea?.setAttribute("aria-describedby", uploadErrorId);
    // app.css only shows the preview bar via .visible -- without this an
    // error with no attachments already queued renders into a display:none
    // container and is never seen.
    attachmentPreviewBar.classList.add("visible");
    attachmentPreviewBar.appendChild(uploadErrorEl);
  }

  function createErrorAction(action: { label: string; onClick: () => void }): HTMLButtonElement {
    const btn = createElement(
      "button",
      {
        class: "attachment-upload-error-action",
        type: "button",
        "data-testid": "too-long-as-file",
      },
      action.label,
    );
    btn.addEventListener("click", action.onClick, { signal });
    return btn;
  }

  /** Clear the composer's refusal line and collapse the preview bar when it
   *  held nothing else. */
  function clearUploadError(): void {
    if (uploadErrorEl === null) return;
    uploadErrorEl.remove();
    uploadErrorEl = null;
    textarea?.removeAttribute("aria-describedby");
    if (
      attachmentPreviewBar !== null &&
      pendingAttachments.length === 0 &&
      attachmentPreviewBar.childElementCount === 0
    ) {
      attachmentPreviewBar.classList.remove("visible");
    }
  }

  function idlePlaceholder(): string {
    return (
      options.placeholder ?? messagingText("composer.placeholder", { channel: options.channelName })
    );
  }

  /** Reflect the current disabledReason onto the DOM (textarea + controls). */
  function applyDisabledState(): void {
    if (textarea === null) return;
    const disabled = disabledReason !== null;
    // DESIGN_SYSTEM "Disabled": a gated composer uses aria-disabled +
    // readOnly rather than the `disabled` attribute, because disabling a
    // focused element drops focus to <body> and loses the caret mid-sentence.
    // Send is refused in handleSend() with the reason; the buttons stay
    // `disabled` (they are not focus targets the user is typing into).
    textarea.readOnly = disabled;
    textarea.setAttribute("aria-disabled", String(disabled));
    textarea.placeholder = disabled ? disabledReason! : idlePlaceholder();
    const uploadsOff = uploadsDisabledByServer();
    for (const btn of controlButtons) {
      // The mic needs what "+" needs (an upload) and a server that keeps the clip's metadata.
      if (btn.classList.contains("mic-btn")) {
        btn.hidden = uploadsOff || !voiceMessagesEnabled() || !composerButtonShown("voice");
        if (disabled) btn.setAttribute("disabled", "true");
        else btn.removeAttribute("disabled");
        continue;
      }
      const isAttach = btn.classList.contains("attach-btn");
      if (isAttach) btn.title = uploadsOff ? messagingText("attach.serverDisabled") : "";
      if (disabled || (isAttach && uploadsOff)) {
        btn.setAttribute("disabled", "true");
      } else {
        // Likewise for GIFs when this server has no GIF provider configured.
        if (btn.classList.contains("gif-btn") && gifUnavailable) continue;
        btn.removeAttribute("disabled");
      }
    }
    if (root !== null) {
      root.classList.toggle("composer-disabled", disabled);
    }
    // A slow-mode send gate does not freeze the composer, but the send control
    // must read as unavailable, and the reason becomes its title.
    const sendBtn = controlButtons[0];
    if (sendBtn !== undefined && !disabled) {
      const gated = sendGateReason !== null;
      sendBtn.classList.toggle("send-gated", gated);
      sendBtn.title = gated ? sendGateReason! : "";
    }
  }

  function setDisabled(reason: string | null): void {
    if (uploadErrorEl?.textContent === disabledReason) {
      if (reason === null) clearUploadError();
      else showUploadError(reason);
    }
    disabledReason = reason;
    applyDisabledState();
  }

  function setSendGate(reason: string | null): void {
    if (uploadErrorEl?.textContent === sendGateReason) {
      if (reason === null) clearUploadError();
      else showUploadError(reason);
    }
    sendGateReason = reason;
    applyDisabledState();
  }

  function setSlowModeNote(text: string | null): void {
    slowModeNote = text;
    applySlowModeNote();
  }

  function applySlowModeNote(): void {
    if (slowModeNoteEl === null) return;
    slowModeNoteEl.hidden = slowModeNote === null;
    slowModeNoteEl.textContent = slowModeNote ?? "";
  }

  function handleSend(): void {
    // A send gate (slow mode) refuses the send but, unlike `disabledReason`,
    // leaves the draft editable — the user can keep typing and retry.
    const refusal = disabledReason ?? sendGateReason;
    if (refusal !== null) {
      showUploadError(refusal);
      return;
    }
    if (textarea === null) return;
    // Built-in slash commands rewrite the text here, so the attachment and
    // send-while-uploading paths below carry the rewritten message too. A bare
    // /spoiler or /me has nothing to send and leaves the draft as typed.
    const slash = applySlashCommand(textarea.value);
    if (slash !== null && "empty" in slash) {
      showUploadError(messagingText("slash.needsText", { name: slash.name }));
      return;
    }
    const typed = replaceEmojiShortcodes(slash === null ? textarea.value.trim() : slash.text);
    const content = applyPickedMentions(typed, idMentionsEnabled() ? pickedMentions : []);
    const hasAttachments = pendingAttachments.length > 0;
    if (content.length === 0 && !hasAttachments) return;

    // The spread counts code points, which is what the server counts. A
    // `.length` check here would count UTF-16 units and refuse ~2000 astral
    // emoji the server accepts. Checked before the debounce stamp below so a
    // refused send does not suppress the next one.
    if ([...typed].length > MAX_MESSAGE_LEN) {
      showUploadError(
        messagingText("error.tooLong", { max: String(MAX_MESSAGE_LEN) }),
        canAttachLongText(textarea.value.trim())
          ? {
              label: messagingText("error.tooLongAsFile", { name: LONG_PASTE_FILENAME }),
              onClick: sendDraftAsFile,
            }
          : undefined,
      );
      return;
    }

    // The age timer can fire late (a sleeping machine, a throttled window), so
    // Send checks the age itself and never posts an id the sweep may have taken.
    const stale = pendingAttachments.filter((a) => a.expired === true || isStale(a));
    if (stale.length > 0) {
      for (const a of stale) refreshStale(a);
      showUploadError(
        messagingText(
          stale.some((a) => a.expired === true)
            ? "error.attachmentExpired"
            : "error.attachmentRefreshing",
        ),
      );
      return;
    }

    // Debounce to prevent double-click duplicate sends
    const now = Date.now();
    if (now - lastSendTime < SEND_DEBOUNCE_MS) return;
    lastSendTime = now;

    // Only include attachments that have finished uploading (have a real server
    // ID); a chip refreshing a stale id is still uploading, its old id unsent.
    const files = pendingAttachments.flatMap((a): SentAttachment[] =>
      a.upload !== undefined || a.id.startsWith("pending-")
        ? []
        : [{ id: a.id, filename: a.filename, ...(a.file === undefined ? {} : { file: a.file }) }],
    );
    // An upload still running does not hold the message back: the host queues
    // it, takes the handles over and posts once they all land (3A-9).
    const queued = pendingAttachments.some((a) => a.upload !== undefined)
      ? pendingAttachments.map((a): QueuedAttachment => {
          if (a.upload !== undefined) a.upload.onProgress = null;
          return {
            filename: a.filename,
            ...(a.file === undefined ? {} : { file: a.file }),
            ...(a.upload === undefined
              ? { id: a.id, ...(a.uploadedAt === undefined ? {} : { uploadedAt: a.uploadedAt }) }
              : { upload: a.upload }),
          };
        })
      : undefined;
    options.onSend(
      content,
      state.replyTo?.messageId ?? null,
      files.map((f) => f.id),
      files,
      replyPing(),
      ...(queued === undefined ? [] : [queued]),
    );
    clearReply();
    clearPendingAttachments();

    textarea.value = "";
    pickedMentions = [];
    closeSlashPopup();
    autoResize();
    textarea.focus();
    clearUploadError();
  }

  /** True when `text` could go up as the long-text file: uploads are wired and
   *  allowed, the name and size pass the server's policy, and there is room
   *  in the queue. */
  function canAttachLongText(text: string): boolean {
    if (options.onUploadFile === undefined) return false;
    if (disabledReason !== null || uploadsDisabledByServer()) return false;
    const maxBytes = authStore.getState().uploadPolicy?.max_upload_bytes ?? FALLBACK_MAX_FILE_SIZE;
    return (
      refusedExtension(LONG_PASTE_FILENAME) === null &&
      new Blob([text]).size <= maxBytes &&
      pendingAttachments.length < MAX_ATTACHMENTS
    );
  }

  /** Moves a draft that is too long to send into a pending message.txt. The
   *  text is read now, not when Send was refused: formatting shortcuts change
   *  it without an input event that would clear the refusal. */
  function sendDraftAsFile(): void {
    if (textarea === null) return;
    const draft = textarea.value.trim();
    if (!canAttachLongText(draft)) return;
    const file = new File([draft], LONG_PASTE_FILENAME, { type: "text/plain" });
    textarea.value = "";
    pickedMentions = [];
    autoResize();
    clearUploadError();
    textarea.focus();
    void handlePasteFile(file, draft);
  }

  /** A paste that would take the message past the limit goes up as
   *  message.txt, as Discord does, instead of a draft that can never send.
   *  When the file could not be attached the paste stays plain text. */
  function pasteLongTextAsFile(e: ClipboardEvent): void {
    if (textarea === null) return;
    const text = e.clipboardData?.getData("text/plain") ?? "";
    if (text === "") return;
    const { value, selectionStart, selectionEnd } = textarea;
    const after = value.slice(0, selectionStart) + text + value.slice(selectionEnd);
    if ([...after.trim()].length <= MAX_MESSAGE_LEN) return;
    if (!canAttachLongText(text)) return;
    const file = new File([text], LONG_PASTE_FILENAME, { type: "text/plain" });
    e.preventDefault();
    void handlePasteFile(file);
  }

  /** "Upload to #channel" over the chat while a file from the OS is dragged
   *  over a slot that takes the drop. It ignores the pointer, so the drop
   *  still lands on the slot underneath. */
  function wireDropOverlay(container: Element): void {
    if (root === null) return;
    const area = container.closest(".chat-area") ?? container;
    const overlay = createElement("div", {
      class: "drop-overlay",
      "data-testid": "drop-overlay",
      "aria-hidden": "true",
    });
    const card = createElement("div", { class: "drop-overlay-card" });
    appendChildren(
      card,
      createElement("strong", {}, messagingText("drop.title", { channel: options.channelName })),
      createElement("span", {}, messagingText("drop.hint")),
    );
    overlay.appendChild(card);
    overlay.hidden = true;
    root.appendChild(overlay);
    const hide = (): void => {
      overlay.hidden = true;
    };
    document.addEventListener(
      "dragover",
      (e: DragEvent) => {
        if (e.dataTransfer?.types.includes("Files") !== true) return;
        const target = e.target;
        const accepts =
          target instanceof Element &&
          target.closest(DROP_SLOTS) !== null &&
          disabledReason === null &&
          !uploadsDisabledByServer() &&
          !dialogOpen();
        if (!accepts) {
          hide();
          return;
        }
        if (!overlay.hidden) return;
        const r = area.getBoundingClientRect();
        overlay.style.top = `${r.top}px`;
        overlay.style.left = `${r.left}px`;
        overlay.style.width = `${r.width}px`;
        overlay.style.height = `${r.height}px`;
        overlay.hidden = false;
      },
      { signal },
    );
    // A null relatedTarget is the drag leaving the window.
    document.addEventListener(
      "dragleave",
      (e: DragEvent) => {
        if (e.relatedTarget === null) hide();
      },
      { signal },
    );
    document.addEventListener("drop", hide, { signal });
    document.addEventListener("dragend", hide, { signal });
  }

  /** Unique counter for preview items (before upload completes and we have a server ID). */
  let previewCounter = 0;

  function isStale(a: (typeof pendingAttachments)[number]): boolean {
    return a.uploadedAt !== undefined && Date.now() - a.uploadedAt >= ATTACHMENT_TTL_MS;
  }

  /** Re-upload a stale chip from its file, or mark it expired when there is none. */
  function refreshStale(a: (typeof pendingAttachments)[number]): void {
    if (a.upload !== undefined || a.expired === true) return;
    if (a.file !== undefined) {
      // The old copy goes first, so a user near their quota has room for
      // the new one. It is never sent again either way.
      void runUpload(a, a.file, discard(a.id));
      return;
    }
    a.expired = true;
    a.previewEl.classList.add("expired");
    a.previewEl.title = messagingText("attach.expired");
  }

  /** Mark a chip with no file expired once it reaches ATTACHMENT_TTL_MS. A
   *  chip that has its file waits for Send to re-upload it, so an idle
   *  composer never uploads in the background. */
  function scheduleExpiry(a: (typeof pendingAttachments)[number]): void {
    if (a.uploadedAt === undefined || a.file !== undefined) return;
    setOwnedTimeout(
      signal,
      () => {
        if (pendingAttachments.includes(a)) refreshStale(a);
      },
      Math.max(0, a.uploadedAt + ATTACHMENT_TTL_MS - Date.now()),
    );
  }

  /** Withdraw a settled upload's server copy. The promise resolves when that
   *  is done or has failed, never rejecting; undefined when nothing withdraws. */
  function discard(id: string): Promise<void> | undefined {
    // A chip that never landed has no server copy to withdraw.
    if (id.startsWith("pending-")) return undefined;
    return options.onDiscardUpload?.(id).catch(() => {});
  }

  function removePreviewItem(el: HTMLDivElement): void {
    const idx = pendingAttachments.findIndex((a) => a.previewEl === el);
    const att = idx !== -1 ? pendingAttachments[idx] : undefined;
    if (att !== undefined) {
      // Removing an in-flight attachment cancels its upload and frees
      // Send immediately, instead of leaving a doomed request running and the
      // composer blocked on it until the request settles.
      att.upload?.owner.destroy();
      const img = att.previewEl.querySelector("img");
      if (img !== null && img.src.startsWith("blob:")) {
        URL.revokeObjectURL(img.src);
      }
      att.previewEl.remove();
      pendingAttachments.splice(idx, 1);
      if (pendingAttachments.length === 0 && attachmentPreviewBar?.childElementCount === 0) {
        attachmentPreviewBar.classList.remove("visible");
      }
    }
  }

  /** Read a File as a data: URL (more reliable than createObjectURL in WebView2). */
  // oxlint-disable-next-line consistent-function-scoping -- co-located with handlePasteFile for readability
  function readFileAsDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.addEventListener("load", () => resolve(reader.result as string));
      // i18n-exempt: internal read failure, surfaced only as the caller's own upload toast
      reader.addEventListener("error", () => reject(new Error("Failed to read file")));
      reader.readAsDataURL(file);
    });
  }

  /** The chip's picture: the image itself when the webview can draw it from
   *  the picked bytes, else the file icon and name. A restored chip without
   *  its file has only the name. */
  function appendPreview(item: HTMLDivElement, file: File | undefined, filename: string): void {
    if (file === undefined || !isPreviewableImage(file)) {
      appendFileLabel(item, filename);
      return;
    }
    // Read file as data URL for preview (works reliably in WebView2)
    const img = createElement("img", { class: "attachment-preview-img", alt: filename });
    item.appendChild(img);
    // A type the webview cannot decode (a camera RAW, PSD, ...) would leave
    // a broken-image icon; the file chip is the honest preview for it.
    const showFileChip = (): void => {
      if (signal.aborted || !img.isConnected) return;
      img.replaceWith(...fileLabel(img.alt));
    };
    img.addEventListener("error", showFileChip, { once: true, signal });
    readFileAsDataUrl(file)
      .then((dataUrl) => {
        if (signal.aborted) return;
        img.src = dataUrl;
      })
      .catch(showFileChip);
  }

  /** The chip's × button; removing the chip cancels its upload, if any. */
  function appendRemoveButton(item: HTMLDivElement, filename: string): void {
    const removeBtn = createElement("button", {
      class: "attachment-preview-remove",
      "data-testid": "attachment-remove",
      "aria-label": messagingText("attach.remove", { filename }),
    });
    removeBtn.appendChild(createIcon("x", 14));
    removeBtn.addEventListener(
      "click",
      (e) => {
        e.stopPropagation();
        const att = pendingAttachments.find((a) => a.previewEl === item);
        if (att !== undefined && att.upload === undefined && att.uploadedAt !== undefined) {
          void discard(att.id);
        }
        removePreviewItem(item);
      },
      { signal },
    );
    item.appendChild(removeBtn);
  }

  /** Flip the spoiler mark of a chip's file (6.12). The name is part of the
   *  upload, so the file goes up again under the new name, and only once that
   *  copy has landed is the old one withdrawn: a failed re-upload loses nothing.
   *  The chip is stale meanwhile, so a failed re-upload leaves it for Send to
   *  retry from its file, and the old id is never sent. A running upload is
   *  cancelled by a further toggle, which supersedes it. */
  function toggleSpoiler(att: (typeof pendingAttachments)[number], btn: HTMLButtonElement): void {
    const upload = options.onUploadFile;
    const file = att.file;
    if (upload === undefined || file === undefined) return;
    const renamed = new File([file], toggleSpoilerFilename(file.name), {
      type: file.type,
      lastModified: file.lastModified,
    });
    // The chip's id is the last copy the server holds, until a new one lands.
    const oldId = att.id.startsWith("pending-") ? undefined : att.id;
    att.upload?.owner.destroy();
    att.previewEl.querySelector("progress")?.remove();
    att.file = renamed;
    att.filename = renamed.name;
    att.uploadedAt = 0;
    relabelChip(att.previewEl, renamed.name);
    paintSpoilerButton(btn, renamed.name);
    const handle = startUpload(upload, renamed);
    handle.result.then(
      (r) => {
        // A cancelled upload that landed anyway is a copy nobody will send.
        if (handle.owner.signal.aborted) void discard(r.id);
        else if (oldId !== undefined && r.id !== oldId) void discard(oldId);
      },
      () => {},
    );
    void followUpload(att, handle);
  }

  /** The chip's spoiler toggle; only a chip with its file can rename it. */
  function appendSpoilerButton(item: HTMLDivElement, file: File | undefined): void {
    if (file === undefined) return;
    const btn = createElement("button", {
      class: "attachment-preview-spoiler",
      type: "button",
      "data-testid": "attachment-spoiler",
      "aria-label": messagingText("attach.markSpoiler"),
      title: messagingText("attach.markSpoiler"),
    });
    btn.appendChild(createIcon("eye-off", 14));
    paintSpoilerButton(btn, file.name);
    btn.addEventListener(
      "click",
      (e) => {
        e.stopPropagation();
        const att = pendingAttachments.find((a) => a.previewEl === item);
        if (att !== undefined) toggleSpoiler(att, btn);
      },
      { signal },
    );
    item.appendChild(btn);
  }

  async function handlePasteFile(file: File, draftText?: string): Promise<void> {
    if (options.onUploadFile === undefined || attachmentPreviewBar === null) return;
    if (disabledReason !== null) return;
    if (uploadsDisabledByServer()) {
      showUploadError(messagingText("attach.serverDisabled"));
      return;
    }

    // Any file type the server's file-type policy allows may be attached:
    // the server also sniffs the content, refuses its blocked types and
    // serves unsafe ones as downloads.
    const refused = refusedExtension(file.name);
    if (refused !== null) {
      showUploadError(
        refused === ""
          ? messagingText("error.fileTypeNoExtension", { filename: file.name })
          : messagingText("error.fileTypeBlocked", { filename: file.name, ext: refused }),
      );
      return;
    }
    const maxBytes = authStore.getState().uploadPolicy?.max_upload_bytes ?? FALLBACK_MAX_FILE_SIZE;
    if (file.size > maxBytes) {
      showUploadError(
        messagingText("error.fileTooLarge", {
          filename: file.name,
          limit: String(Math.floor(maxBytes / (1024 * 1024))),
        }),
      );
      return;
    }

    // Cap the queue at the server's hard limit. Refusing here -- before the
    // upload starts -- keeps the composer's state and the eventual send in
    // sync with what the server will actually accept.
    if (pendingAttachments.length >= MAX_ATTACHMENTS) {
      showUploadError(messagingText("error.tooManyAttachments", { max: String(MAX_ATTACHMENTS) }));
      return;
    }

    const tempId = `pending-${++previewCounter}`;

    // A valid attachment is the user acting on any earlier refusal.
    clearUploadError();
    attachmentPreviewBar.classList.add("visible");

    const item = createElement("div", { class: "attachment-preview-item uploading" });

    appendPreview(item, file, file.name);

    appendRemoveButton(item, file.name);
    appendSpoilerButton(item, file);
    attachmentPreviewBar.appendChild(item);
    const pending: (typeof pendingAttachments)[number] = {
      id: tempId,
      filename: file.name,
      previewEl: item,
      file,
      ...(draftText === undefined ? {} : { draftText }),
    };
    pendingAttachments.push(pending);
    await runUpload(pending, file);
  }

  /** Start uploading `file`, after `before` when given; the returned upload
   *  outlives any one chip. */
  function startUpload(
    upload: NonNullable<MessageInputOptions["onUploadFile"]>,
    file: File,
    before?: Promise<void>,
  ): DraftUpload {
    const owner = new Disposable();
    let settledAt: number | undefined;
    let fraction: number | null = null;
    const onProgress = (f: number): void => {
      fraction = f;
      handle.onProgress?.(f);
    };
    const result =
      before === undefined
        ? upload(file, owner.signal, onProgress)
        : before.then(() => {
            owner.signal.throwIfAborted();
            return upload(file, owner.signal, onProgress);
          });
    // Also keeps a rejection in a draft that is never restored from
    // surfacing as unhandled; whichever chip follows the upload reads it.
    result.then(
      () => (settledAt = Date.now()),
      () => {},
    );
    const handle: DraftUpload = {
      filename: file.name,
      file,
      owner,
      get settledAt() {
        return settledAt;
      },
      get fraction() {
        return fraction;
      },
      onProgress: null,
      refreshing: null,
      result,
    };
    return handle;
  }

  /** Upload `file` for `pending`'s chip; also re-uploads a stale chip. */
  async function runUpload(
    pending: (typeof pendingAttachments)[number],
    file: File,
    before?: Promise<void>,
  ): Promise<void> {
    const upload = options.onUploadFile;
    if (upload === undefined) return;
    await followUpload(pending, startUpload(upload, file, before));
  }

  /** Show `handle` on `pending`'s chip until it settles. */
  /** A draft whose file failed to upload goes back in front of anything typed since. */
  function restoreDraftText(text: string | undefined): void {
    if (text === undefined || textarea === null) return;
    const typed = textarea.value.trim();
    textarea.value = typed === "" ? text : `${text}\n${typed}`;
    autoResize();
  }

  async function followUpload(
    pending: (typeof pendingAttachments)[number],
    handle: DraftUpload,
  ): Promise<void> {
    const item = pending.previewEl;
    // A native progress bar on the chip: indeterminate (no value) while the
    // transport reports nothing, determinate from its first tick.
    const progressBar = createElement("progress", { "aria-label": handle.filename });
    if (handle.fraction !== null) progressBar.value = handle.fraction;
    item.insertBefore(progressBar, item.querySelector(".attachment-preview-remove"));
    item.classList.add("uploading");
    pending.upload = handle;
    handle.onProgress = (fraction) => (progressBar.value = fraction);
    /** Set when refreshing a stale chip; a failed refresh keeps the chip. */
    const staleUploadedAt = pending.uploadedAt;
    if (staleUploadedAt !== undefined) {
      handle.refreshing = { id: pending.id, uploadedAt: staleUploadedAt };
    }
    pending.uploadedAt = undefined;
    // Removed preview (cancelled), composer torn down (handed to a draft), or
    // the chip left with a queued send, which reads the result itself (3A-9).
    const abandoned = (): boolean =>
      handle.owner.signal.aborted || signal.aborted || !pendingAttachments.includes(pending);

    try {
      const result = await handle.result;
      if (abandoned()) return;
      pending.id = result.id;
      pending.filename = result.filename;
      pending.upload = undefined;
      pending.uploadedAt = handle.settledAt ?? Date.now();
      if (pending.unsent === true) {
        pending.unsent = false;
        item.classList.remove("unsent");
        item.removeAttribute("title");
      }
      item.classList.remove("uploading");
      progressBar.remove();
      if (uploadErrorEl?.textContent === messagingText("error.attachmentRefreshing")) {
        clearUploadError();
      }
    } catch (err) {
      // A user-cancelled upload (removed preview) is not a failure: the
      // preview is already gone and there is nothing to report.
      if (abandoned()) return;
      if (staleUploadedAt !== undefined) {
        // A failed refresh keeps the chip stale, so the next Send retries it
        // and still never sends the old id.
        pending.upload = undefined;
        pending.uploadedAt = staleUploadedAt;
        item.classList.remove("uploading");
        progressBar.remove();
      } else {
        removePreviewItem(item);
        restoreDraftText(pending.draftText);
      }
      const errMsg = errorText(err, messagingText("error.uploadFailed"));
      showUploadError(messagingText("error.uploadFailedDetail", { detail: errMsg }));
    }
  }

  function setReplyTo(
    messageId: number,
    username: string,
    opts: Pick<ReplyTarget, "ping" | "self"> = {},
  ): void {
    state = { replyTo: { messageId, username, ...opts } };
    showReplyBar();
    textarea?.focus();
    options.onDraftChange?.();
  }

  function clearReply(): void {
    state = { ...state, replyTo: null };
    hideReplyBar();
    options.onDraftChange?.();
  }

  function focus(): void {
    textarea?.focus();
  }

  function isIdle(): boolean {
    return (
      (textarea?.value ?? "") === "" && state.replyTo === null && pendingAttachments.length === 0
    );
  }

  function mount(container: Element): void {
    root = createElement("div", { class: "message-input-wrap", "data-testid": "message-input" });

    replyBar = createElement("div", { class: "reply-bar" });
    const replyInner = createElement("div", { class: "reply-bar-inner" });
    replyText = createElement("strong", {});
    replyInner.appendChild(replyText);
    replyPingBtn = createElement("button", {
      class: "reply-ping",
      type: "button",
      "data-testid": "reply-ping",
      title: messagingText("reply.pingLabel"),
      "aria-label": messagingText("reply.pingLabel"),
    });
    replyPingBtn.addEventListener(
      "click",
      () => {
        if (state.replyTo === null) return;
        state = { ...state, replyTo: { ...state.replyTo, ping: !replyPing() } };
        showReplyBar();
        options.onDraftChange?.();
        textarea?.focus();
      },
      { signal },
    );
    replyInner.appendChild(replyPingBtn);
    const replyClose = createElement("button", {
      class: "reply-close",
      "aria-label": messagingText("reply.cancel"),
    });
    replyClose.appendChild(createIcon("x", 14));
    replyClose.addEventListener("click", clearReply, { signal });
    replyInner.appendChild(replyClose);
    replyBar.appendChild(replyInner);

    attachmentPreviewBar = createElement("div", { class: "attachment-preview-bar" });

    const inputBox = createElement("div", { class: "message-input-box" });
    const attachBtn = createElement(
      "button",
      { class: "input-btn attach-btn", "aria-label": messagingText("attach.label") },
      "+",
    );

    // File picker via attach button
    if (options.onUploadFile !== undefined) {
      const fileInput = createElement("input", {
        type: "file",
        multiple: "",
        style: "display: none;",
      });
      fileInput.addEventListener(
        "change",
        () => {
          // Copied first: clearing the value empties the live FileList.
          const files = [...(fileInput.files ?? [])];
          fileInput.value = "";
          for (const file of files) void handlePasteFile(file);
        },
        { signal },
      );
      attachBtn.addEventListener("click", () => fileInput.click(), { signal });
      openPicker = () => {
        if (disabledReason !== null || uploadsDisabledByServer()) return;
        fileInput.click();
      };
      root?.appendChild(fileInput);
    } else {
      attachBtn.setAttribute("disabled", "true");
      attachBtn.title = messagingText("attach.unavailable");
    }
    textarea = createElement("textarea", {
      class: "msg-textarea",
      placeholder: idlePlaceholder(),
      rows: "1",
      "data-testid": "msg-textarea",
    });
    const emojiBtn = createElement("button", {
      class: "input-btn emoji-btn",
      "aria-label": messagingText("emoji.label"),
    });
    emojiBtn.appendChild(createIcon("smile", 20));
    const gifBtn = createElement(
      "button",
      { class: "input-btn gif-btn", "aria-label": messagingText("gif.button") },
      messagingText("gif.button"),
    );
    if (gifUnavailable) {
      markGifUnavailable(gifBtn, messagingText("gif.disabled"));
    }
    // The Sticker button: only where the host can send one and the server has stickers.
    const sendSticker = options.onSendSticker;
    const stickerBtn =
      sendSticker !== undefined && stickersEnabled()
        ? createElement("button", {
            class: "input-btn sticker-btn",
            type: "button",
            title: stickersText("button.label"),
            "aria-label": stickersText("button.label"),
            "data-testid": "sticker-btn",
          })
        : null;
    stickerBtn?.appendChild(createIcon("sticker", 20));
    // The Poll button: only where the host can open the dialog and the server has polls.
    const createPoll = options.onCreatePoll;
    const pollBtn =
      createPoll !== undefined && pollsEnabled()
        ? createElement(
            "button",
            {
              class: "input-btn poll-btn",
              type: "button",
              title: messagingText("poll.buttonTitle"),
              "aria-label": messagingText("poll.buttonTitle"),
              "data-testid": "poll-btn",
            },
            messagingText("poll.button"),
          )
        : null;
    pollBtn?.addEventListener("click", () => createPoll?.(), { signal });
    const sendBtn = createElement("button", {
      class: "input-btn send-btn",
      "aria-label": messagingText("send.label"),
      "data-testid": "send-btn",
    });
    sendBtn.appendChild(createIcon("send", 20));
    // The mic: where the composer can upload at all, unless a text-only composer.
    const micBtn =
      options.onUploadFile !== undefined && options.noAttach !== true
        ? createElement("button", {
            class: "input-btn mic-btn",
            type: "button",
            title: voiceMessagesText("mic.label"),
            "aria-label": voiceMessagesText("mic.label"),
            "data-testid": "voice-mic-btn",
          })
        : null;
    micBtn?.appendChild(createIcon("mic", 20));
    micBtn?.setAttribute("hidden", "");
    // Register interactive controls so the disabled state can toggle them.
    controlButtons.length = 0;
    controlButtons.push(sendBtn, emojiBtn, gifBtn);
    if (stickerBtn !== null) controlButtons.push(stickerBtn);
    if (pollBtn !== null) controlButtons.push(pollBtn);
    if (micBtn !== null) controlButtons.push(micBtn);
    if (options.onUploadFile !== undefined) {
      controlButtons.push(attachBtn);
      disposable.onStoreChange(
        authStore,
        (s) => s.uploadPolicy?.max_upload_bytes,
        () => applyDisabledState(),
      );
    }

    textarea.addEventListener(
      "input",
      () => {
        autoResizeOnInput();
        maybeEmitTyping();
        // A cleared draft forgets what was picked into it.
        if (textarea?.value === "") pickedMentions = [];
        syncAutocomplete();
        // An edit is the user acting on the refusal, so the line goes away.
        clearUploadError();
      },
      { signal },
    );
    textarea.addEventListener(
      "keydown",
      (e: KeyboardEvent) => {
        // Whichever popup is open owns navigation keys, so Enter completes the
        // token instead of sending a half-typed message.
        if (slashPopup?.handleKeydown(e) === true) return;
        if (mentionPopup?.handleKeydown(e) === true) return;
        if (channelPopup?.handleKeydown(e) === true) return;
        if (emojiPopup?.handleKeydown(e) === true) return;

        // Ctrl+B / Ctrl+I / Ctrl+U wrap the selection in markdown markers.
        // The composer owns Ctrl+U while it has focus, so the propagation stop
        // is load-bearing: without it the global upload shortcut would fire on
        // top of the underline.
        if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
          const marker = FORMAT_MARKERS[e.key.toLowerCase()];
          if (marker !== undefined) {
            e.preventDefault();
            e.stopPropagation();
            applyFormatting(marker);
            return;
          }
        }

        if (e.key === "Enter" && !e.shiftKey) {
          // A CJK IME commits the current candidate on Enter, firing keydown
          // with isComposing true (or the legacy keyCode 229). Sending here
          // would ship the raw composition text instead of the committed word.
          if (isImeCommit(e)) return;
          e.preventDefault();
          handleSend();
        }
        // An Escape that cancels something is used up: the app-wide Escape
        // (mark the channel read) leaves a prevented key alone.
        if (e.key === "Escape" && !isImeCommit(e)) {
          if (state.replyTo !== null) {
            e.preventDefault();
            clearReply();
          }
        }
        if (
          e.key === "ArrowUp" &&
          !(e.shiftKey || e.altKey || e.ctrlKey || e.metaKey || e.isComposing) &&
          disabledReason === null &&
          textarea !== null &&
          textarea.value.length === 0
        ) {
          // The browser's own ArrowUp would move the caret in the (empty)
          // composer as the inline editor takes focus.
          e.preventDefault();
          root?.dispatchEvent(new CustomEvent("edit-last-message", { bubbles: true }));
        }
      },
      { signal },
    );

    // Clipboard paste: detect images/files
    textarea.addEventListener(
      "paste",
      (e: ClipboardEvent) => {
        const items = e.clipboardData?.items;
        if (items === undefined) return;
        let pastedFile = false;
        for (const item of items) {
          if (item.kind !== "file") continue;
          const file = item.getAsFile();
          if (file === null) continue;
          e.preventDefault();
          pastedFile = true;
          void handlePasteFile(file);
        }
        if (!pastedFile) pasteLongTextAsFile(e);
      },
      { signal },
    );

    // Files dragged in from the OS: accepted over the channel view only, and
    // never while an overlay covers it. Other drops are left to the app-wide
    // fileDropGuard, which cancels them without uploading.
    if (options.onUploadFile !== undefined) {
      document.addEventListener(
        "drop",
        (e: DragEvent) => {
          const dt = e.dataTransfer;
          if (dt === null || !dt.types.includes("Files")) return;
          const target = e.target;
          if (!(target instanceof Element)) return;
          if (target.closest(DROP_SLOTS) === null) return;
          if (dialogOpen()) return;
          e.preventDefault();
          for (const file of dt.files) void handlePasteFile(file);
        },
        { signal },
      );
      wireDropOverlay(container);
    }

    // Caret moves that aren't typing (click, arrow/Home/End keys, blur) also
    // decide the popup's fate — without this, completing a mention/emoji
    // after moving the caret away with the keyboard splices at a stale offset.
    textarea.addEventListener("click", syncAutocomplete, { signal });
    textarea.addEventListener(
      "keyup",
      (e: KeyboardEvent) => {
        if (CARET_MOVE_KEYS.has(e.key)) syncAutocomplete();
      },
      { signal },
    );
    textarea.addEventListener(
      "blur",
      () => {
        closeSlashPopup();
        closeMentionPopup();
        closeChannelPopup();
        closeEmojiPopup();
      },
      { signal },
    );

    sendBtn.addEventListener("click", handleSend, { signal });

    // The GIF, sticker and emoji buttons share one tabbed popup. Each
    // button opens it on its own tab; the active tab's button closes it.
    let popup: ExpressionPopup | null = null;
    // One outside-click owner for the open popup, destroyed when it closes.
    let popupDismiss: Disposable | null = null;

    function tabButton(tab: ExpressionTab): HTMLButtonElement | null {
      if (tab === "gif") return gifBtn;
      return tab === "sticker" ? stickerBtn : emojiBtn;
    }

    /** Close the popup (a no-op when closed). Escape hands focus back to the button of the tab it was on. */
    function closePopup(returnFocus = false): void {
      const closing = popup;
      if (closing === null) return;
      const tab = closing.activeTab();
      popup = null;
      popupDismiss?.destroy();
      popupDismiss = null;
      closing.element.remove();
      closing.destroy();
      if (!returnFocus) return;
      const btn = tabButton(tab);
      // A button the user hid in settings cannot take focus; the textarea can.
      if (btn !== null && !btn.hidden) btn.focus();
      else textarea?.focus();
    }

    function handlePopupClickOutside(e: MouseEvent): void {
      if (popup === null) return;
      const target = e.target as Node;
      if ((target as Element).closest?.(".modal-overlay")) return;
      if (popup.element.contains(target)) return;
      for (const tab of ["gif", "sticker", "emoji"] as const) {
        const btn = tabButton(tab);
        if (btn !== null && (target === btn || btn.contains(target))) return;
      }
      closePopup();
    }

    /** Send a picked sticker at once, under the same gates as a GIF. */
    function sendPickedSticker(sticker: { readonly id: number; readonly name: string }): void {
      const refusal = disabledReason ?? sendGateReason;
      if (refusal !== null) {
        showUploadError(refusal);
        return;
      }
      const now = Date.now();
      if (now - lastSendTime < SEND_DEBOUNCE_MS) return;
      lastSendTime = now;
      options.onSendSticker?.(sticker, state.replyTo?.messageId ?? null, replyPing());
      clearReply();
    }

    /** Build the picker for a tab, loading its code on first use. */
    async function buildPanel(tab: ExpressionTab): Promise<ExpressionPanel | null> {
      const wanted = (): boolean => popup === null || popup.activeTab() === tab;
      if (tab === "emoji") {
        const screen = await emojiPickerScreen.load(wanted);
        if (screen === null) return null;
        return screen.createEmojiPicker({
          // Read the set at open time, not at mount: an emoji_update while the
          // composer is alive must be in the next picker the user opens.
          customEmoji: listCustomEmoji(),
          onSelect: (emoji: string, select) => {
            const keepOpen = select?.keepOpen === true;
            if (textarea !== null) {
              const start = textarea.selectionStart;
              const end = textarea.selectionEnd;
              const before = textarea.value.slice(0, start);
              const after = textarea.value.slice(end);
              textarea.value = before + emoji + after;
              textarea.selectionStart = textarea.selectionEnd = start + emoji.length;
              // Shift-pick keeps focus in the picker so the next pick lands at
              // the caret just advanced.
              if (!keepOpen) textarea.focus();
            }
            if (!keepOpen) closePopup();
          },
          onClose: () => closePopup(true),
        });
      }
      if (tab === "sticker") {
        const screen = await stickerPickerScreen.load(wanted);
        if (screen === null) return null;
        return screen.createStickerPicker({
          canManage: currentUserRoleHasPermission(Permission.MANAGE_SERVER),
          onSelect: (sticker) => {
            sendPickedSticker(sticker);
            closePopup();
          },
          onClose: () => closePopup(true),
        });
      }
      const gifApi = options.gifApi;
      if (gifApi === undefined) return null;
      const screen = await gifPickerScreen.load(wanted);
      if (screen === null) return null;
      return screen.createGifPicker({
        api: gifApi,
        onUnavailable: (reason: string) => {
          gifUnavailable = true;
          markGifUnavailable(gifBtn, reason);
        },
        onSelect: (gifUrl: string) => {
          // Send the GIF directly instead of routing it through the textarea
          // (handleSend's read of textarea.value): that overwrote — and
          // discarded — whatever draft the user had typed, and on slow
          // mode / mid-upload / debounced sends left the raw GIF URL sitting
          // in the composer instead of the draft. Guarded by the same
          // refusal/debounce checks as a normal send; an in-progress
          // edit and any typed draft are left untouched.
          const refusal = disabledReason ?? sendGateReason;
          if (refusal !== null) {
            showUploadError(refusal);
          } else {
            const now = Date.now();
            if (now - lastSendTime >= SEND_DEBOUNCE_MS) {
              lastSendTime = now;
              options.onSend(gifUrl, state.replyTo?.messageId ?? null, [], [], replyPing());
              clearReply();
            }
          }
          closePopup();
        },
        onClose: () => closePopup(true),
      });
    }

    function openPopup(tab: ExpressionTab): void {
      // The tabs on offer: no GIF tab where GIFs are off, no sticker tab where
      // the server has none.
      const tabs: ExpressionTab[] = [];
      if (options.gifApi !== undefined && !gifUnavailable) tabs.push("gif");
      if (stickerBtn !== null) tabs.push("sticker");
      tabs.push("emoji");
      if (!tabs.includes(tab)) return;
      const opened = createExpressionPopup({
        tabs,
        initial: tab,
        mountPanel: buildPanel,
        onClose: () => closePopup(true),
      });
      popup = opened;
      root?.appendChild(opened.element);
      // Focus starts inside the popup, so Escape closes it even before the
      // lazy picker has mounted and moved focus to its search box.
      opened.element.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();
      const dismiss = new Disposable();
      popupDismiss = dismiss;
      // Defer so the click that opened the popup doesn't immediately close it.
      setOwnedTimeout(
        dismiss.signal,
        () =>
          document.addEventListener("mousedown", handlePopupClickOutside, {
            signal: dismiss.signal,
          }),
        0,
      );
    }

    function toggleTab(tab: ExpressionTab): void {
      if (popup === null) {
        openPopup(tab);
      } else if (popup.activeTab() === tab) {
        closePopup();
      } else {
        popup.showTab(tab);
      }
    }

    emojiBtn.addEventListener("click", () => toggleTab("emoji"), { signal });
    gifBtn.addEventListener("click", () => toggleTab("gif"), { signal });
    stickerBtn?.addEventListener("click", () => toggleTab("sticker"), { signal });

    togglePickerOf = (kind) => {
      const btn = tabButton(kind);
      if (btn === null || btn.disabled) return;
      toggleTab(kind);
    };

    // Store picker cleanup for destroy()
    cleanupPickers = () => {
      closePopup();
      closeSlashPopup();
      closeMentionPopup();
      closeChannelPopup();
      closeEmojiPopup();
    };

    charCounter = createElement("span", {
      class: "char-counter",
      "data-testid": "char-counter",
    });
    charCounter.hidden = true;
    if (options.noAttach !== true) inputBox.appendChild(attachBtn);
    // Emoji, sticker, GIF: the sticker button sits between the other two.
    appendChildren(inputBox, textarea, emojiBtn);
    if (stickerBtn !== null) inputBox.appendChild(stickerBtn);
    inputBox.appendChild(gifBtn);
    if (pollBtn !== null) inputBox.appendChild(pollBtn);
    if (micBtn !== null) inputBox.appendChild(micBtn);
    appendChildren(inputBox, charCounter, sendBtn);
    // Settings → Text & Images can hide each of these; the switch applies live.
    const applyButtonPrefs = (): void => {
      emojiBtn.hidden = !composerButtonShown("emoji");
      gifBtn.hidden = !composerButtonShown("gif");
      if (stickerBtn !== null) stickerBtn.hidden = !composerButtonShown("sticker");
      if (pollBtn !== null) pollBtn.hidden = !composerButtonShown("poll");
      applyDisabledState();
    };
    applyButtonPrefs();
    onPrefChange(COMPOSER_BUTTON_PREF_KEYS, applyButtonPrefs, signal);
    slowModeNoteEl = createElement("div", {
      class: "composer-slow-note",
      "data-testid": "slow-mode-note",
    });
    appendChildren(root, replyBar, attachmentPreviewBar, inputBox, slowModeNoteEl);
    const upload = options.onUploadFile;
    if (micBtn !== null && upload !== undefined) {
      const voiceHost = root;
      // The recorder and its bar load on the first mic click, so they stay out of the app chunk.
      let voiceLoading = false;
      const startVoice = async (): Promise<void> => {
        if (voice === null) {
          if (voiceLoading) return;
          voiceLoading = true;
          let mod: typeof import("../features/voice-messages/voiceComposer");
          try {
            mod = await import("../features/voice-messages/voiceComposer");
          } catch {
            voiceLoading = false;
            if (!signal.aborted) showUploadError(voiceMessagesText("error.failed"));
            return;
          }
          voiceLoading = false;
          // The composer was destroyed while the code loaded.
          if (signal.aborted) return;
          voice ??= mod.createVoiceComposer({
            host: voiceHost,
            before: inputBox,
            root: voiceHost,
            signal,
            upload: (file, meta, uploadSignal) => upload(file, uploadSignal, undefined, meta),
            ...(options.onDiscardUpload === undefined
              ? {}
              : { discardUpload: options.onDiscardUpload }),
            send: (attachment) => {
              // A message of its own: no text, the reply stays (as on Discord).
              options.onSend(
                "",
                state.replyTo?.messageId ?? null,
                [attachment.id],
                [attachment],
                replyPing(),
              );
              clearReply();
            },
            gate: () =>
              disabledReason ??
              sendGateReason ??
              (uploadsDisabledByServer() ? messagingText("attach.serverDisabled") : null),
            onError: showUploadError,
            onClearError: clearUploadError,
            onActiveChange: (active) => {
              if (!active) textarea?.focus();
            },
          });
        }
        voice.start();
      };
      micBtn.addEventListener("click", () => void startVoice(), { signal });
    }
    applySlowModeNote();
    container.appendChild(root);
    releaseComposer?.();
    const mentionTarget = { insertMention: insertMentionAtCaret, canMention: canTakeText };
    releaseComposer = claimComposer(mentionTarget);
    // With a thread's composer beside this one, a Mention goes where the user is.
    root.addEventListener("focusin", () => focusComposer(mentionTarget), {
      signal: disposable.signal,
    });
    // Apply any initial disabled reason before focusing.
    applyDisabledState();
    if (disabledReason === null) {
      textarea.focus();
    }
  }

  function destroy(): void {
    releaseComposer?.();
    releaseComposer = null;
    // Close any open pickers and their document listeners before aborting
    cleanupPickers?.();
    cleanupPickers = null;
    // Clear all pending timers
    for (const t of activeTimers) clearTimeout(t);
    activeTimers.clear();
    if (resizeFrame !== null) {
      cancelAnimationFrame(resizeFrame);
      resizeFrame = null;
    }
    // An unmount must not leave an upload running against a composer
    // that no longer exists, unless getDraft() handed it to the draft.
    for (const att of pendingAttachments) {
      if (att.upload === undefined) continue;
      att.upload.onProgress = null;
      if (!handedOff.has(att.upload)) att.upload.owner.destroy();
    }
    handedOff.clear();
    // The microphone and a clip not yet sent go with the composer.
    voice?.destroy();
    voice = null;
    disposable.destroy();
    // Image previews now use data: URLs (via readFileAsDataUrl) which don't
    // require revocation — just clear the array and let GC reclaim them.
    pendingAttachments.length = 0;
    slowModeNoteEl = null;
    root?.remove();
    root = null;
    textarea = null;
    replyBar = null;
    replyText = null;
    replyPingBtn = null;
    attachmentPreviewBar = null;
    uploadErrorEl = null;
    charCounter = null;
    openPicker = null;
    togglePickerOf = null;
  }

  function openFilePicker(): void {
    openPicker?.();
  }

  /** Whether the composer would take text right now. */
  function canTakeText(): boolean {
    return textarea !== null && disabledReason === null && !textarea.readOnly && !textarea.disabled;
  }

  /** Insert `@username ` at the caret, spaced from a preceding word. */
  function insertMentionAtCaret(username: string): boolean {
    if (textarea === null || !canTakeText()) return false;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const before = textarea.value.slice(0, start);
    const after = textarea.value.slice(end);
    const lead = before.length > 0 && !/\s$/.test(before) ? " " : "";
    const inserted = `${lead}@${username} `;
    textarea.value = before + inserted + after;
    const pos = before.length + inserted.length;
    textarea.selectionStart = pos;
    textarea.selectionEnd = pos;
    autoResize();
    textarea.focus();
    return true;
  }

  function togglePicker(kind: "emoji" | "gif" | "sticker"): void {
    togglePickerOf?.(kind);
  }

  /** Capture the unsent state for a channel switch. Settled attachments carry
   *  their server id; an upload still in flight is handed to the draft, and
   *  destroy() then leaves it running for the composer that restores it.
   *  The caller owns those uploads: store the draft or destroy each owner.
   */
  function peekDraft(): { content: string; replyTo: ReplyTarget | null } {
    return { content: textarea?.value ?? "", replyTo: state.replyTo };
  }

  function getDraft(): ComposerDraft {
    const uploads: DraftUpload[] = [];
    for (const a of pendingAttachments) {
      if (a.upload === undefined) continue;
      handedOff.add(a.upload);
      uploads.push(a.upload);
    }
    return {
      content: textarea?.value ?? "",
      replyTo: state.replyTo,
      ...(pickedMentions.length === 0 ? {} : { picks: [...pickedMentions] }),
      attachments: pendingAttachments.flatMap((a) =>
        a.uploadedAt === undefined
          ? []
          : [
              {
                id: a.id,
                filename: a.filename,
                uploadedAt: a.uploadedAt,
                ...(a.file === undefined ? {} : { file: a.file }),
                ...(a.unsent === true ? { unsent: true } : {}),
              },
            ],
      ),
      ...(uploads.length === 0 ? {} : { uploads }),
    };
  }

  /** Restore a captured draft into this (fresh) composer: text, reply bar, a
   *  ready chip (no spinner) per still-live upload, so its id sends without
   *  re-uploading, and an uploading chip per upload still in flight. A chip
   *  past its age with its file stays and re-uploads at Send. */
  function restoreDraft(draft: ComposerDraft): void {
    if (textarea !== null) {
      textarea.value = draft.content;
      autoResize();
    }
    pickedMentions = [...(draft.picks ?? [])];
    if (draft.replyTo !== null) {
      const { messageId, username, ...opts } = draft.replyTo;
      setReplyTo(messageId, username, opts);
    }
    const now = Date.now();
    const live = draft.attachments.filter(
      (a) => a.unsent === true || a.file !== undefined || now - a.uploadedAt < ATTACHMENT_TTL_MS,
    );
    const unsent = live.filter((a) => a.unsent === true);
    for (const att of live) {
      if (attachmentPreviewBar === null) break;
      if (att.unsent === true) continue;
      const item = createElement("div", { class: "attachment-preview-item" });
      appendPreview(item, att.file, att.filename);
      appendRemoveButton(item, att.filename);
      appendSpoilerButton(item, att.file);
      attachmentPreviewBar.classList.add("visible");
      attachmentPreviewBar.appendChild(item);
      const restored = { ...att, previewEl: item };
      pendingAttachments.push(restored);
      scheduleExpiry(restored);
    }
    for (const handle of draft.uploads ?? []) {
      if (handle.owner.signal.aborted) continue;
      if (attachmentPreviewBar === null) {
        handle.owner.destroy();
        continue;
      }
      const item = createElement("div", { class: "attachment-preview-item" });
      appendPreview(item, handle.file, handle.filename);
      appendRemoveButton(item, handle.filename);
      appendSpoilerButton(item, handle.file);
      attachmentPreviewBar.classList.add("visible");
      attachmentPreviewBar.appendChild(item);
      const pending: (typeof pendingAttachments)[number] = {
        id: handle.refreshing?.id ?? `pending-${++previewCounter}`,
        filename: handle.filename,
        previewEl: item,
        file: handle.file,
      };
      if (handle.refreshing !== null) pending.uploadedAt = handle.refreshing.uploadedAt;
      pendingAttachments.push(pending);
      void followUpload(pending, handle);
    }
    if (unsent.length > 0) restoreUnsent(unsent, "skipped");
    if (live.length < draft.attachments.length) {
      showUploadError(messagingText("error.draftAttachmentExpired"));
    }
  }

  /** A chip for a file the server did not attach. It is stale from the start,
   *  so Send re-uploads it from its file and never posts the old id again; with
   *  no file it is expired and only removing it frees Send. */
  function addUnsentChip(att: SentAttachment): boolean {
    if (pendingAttachments.some((a) => a.id === att.id)) return true;
    if (attachmentPreviewBar === null || pendingAttachments.length >= MAX_ATTACHMENTS) return false;
    const item = createElement("div", {
      class: "attachment-preview-item unsent",
      title: messagingText("attach.notSent"),
    });
    appendPreview(item, att.file, att.filename);
    appendRemoveButton(item, att.filename);
    appendSpoilerButton(item, att.file);
    attachmentPreviewBar.classList.add("visible");
    attachmentPreviewBar.appendChild(item);
    pendingAttachments.push({
      id: att.id,
      filename: att.filename,
      previewEl: item,
      uploadedAt: 0,
      unsent: true,
      ...(att.file === undefined ? { expired: true } : { file: att.file }),
    });
    return true;
  }

  function restoreUnsent(
    files: readonly SentAttachment[],
    reason: "skipped" | "unavailable",
    replyTo?: ComposerDraft["replyTo"],
  ): void {
    if (attachmentPreviewBar === null) return;
    if (replyTo != null && state.replyTo === null) {
      const { messageId, username, ...opts } = replyTo;
      setReplyTo(messageId, username, opts);
    }
    const dropped = files.filter((f) => !addUnsentChip(f)).length;
    showUploadError(
      dropped > 0
        ? messagingText("error.tooManyAttachments", { max: String(MAX_ATTACHMENTS) })
        : messagingText(
            reason === "unavailable" ? "error.attachmentsUnavailable" : "error.attachmentsNotSent",
          ),
    );
  }

  return {
    mount,
    destroy,
    setReplyTo,
    clearReply,
    focus,
    insertMention: insertMentionAtCaret,
    isIdle,
    setDisabled,
    setSendGate,
    setSlowModeNote,
    openFilePicker,
    togglePicker,
    getDraft,
    restoreDraft,
    peekDraft,
    restoreUnsent,
  };
}
