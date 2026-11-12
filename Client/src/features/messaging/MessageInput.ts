/**
 * MessageInput component — textarea with send and reply bar.
 * Step 5.42 of the Tauri v2 migration.
 */

import { Disposable } from "@lib/disposable";
import { isPhoneLayout, onPhoneLayoutChange } from "@lib/ui/bottomSheet";
import { createElement, appendChildren } from "@lib/dom";
import type { MountableComponent } from "@lib/text/safeRender";
import { claimComposer, focusComposer } from "./activeComposer";
import { acceptSharesFor } from "../share/shareInbox";
import type { PickedMention } from "@lib/text/pickedMentions";
import { wrapWithMarker } from "./markdownMarkers";
import { onPrefChange } from "@lib/prefs/preferences";
import { COMPOSER_BUTTON_PREF_KEYS } from "./composerButtons";
import type { VoiceUploadMeta } from "@lib/types";
import type { GifApi, GifFavoritesApi } from "@lib/media/gifProvider";
import type { InputState, InputApi } from "./composer/inputState";
import { createInputAutocomplete } from "./composer/inputAutocomplete";
import { createInputComposer } from "./composer/inputComposer";
import { createInputSend } from "./composer/inputSend";
import { createInputAttachments } from "./composer/inputAttachments";
import { createInputDraft } from "./composer/inputDraft";
import { wireCaretEvents, wireFileDrop, wireTextareaInput } from "./composer/inputEvents";
import { wireExpressionPopup } from "./composer/inputPopups";
import {
  applyButtonPrefs,
  buildReplyBar,
  createComposerButtons,
  createComposerTextarea,
  registerControls,
  wirePlusMenu,
  wireVoiceMic,
} from "./composer/inputWidgets";

export { wrapWithMarker };

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
  /** The message the reply bar answers changed (null: the bar closed), so the
   *  list can mark that row. */
  readonly onReplyTargetChange?: (messageId: number | null) => void;
  /** Initial disabled reason (e.g. read-only / no-permission / offline). */
  readonly disabledReason?: string | null;
  /** Replaces the "Message #channel" placeholder (a text-only thread composer). */
  readonly placeholder?: string;
  /** Leave the "+" attach button out (a text-only composer). */
  readonly noAttach?: boolean;
  /** Where a file dragged in from the OS is taken, and the area the drop
   *  overlay covers; by default the channel view. */
  readonly dropZone?: string;
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
  /** A too-long draft being sent as a file: put back in the composer that
   *  follows this upload if it fails. */
  draftText?: string;
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
}; // i18n-exempt: a file name, not UI text
/** Makes each composer's refusal-line id unique for aria-describedby. */
let nextComposerId = 0;

export function createMessageInput(options: MessageInputOptions): MessageInputComponent {
  const disposable = new Disposable();
  const st: InputState = {
    options,
    disposable,
    signal: disposable.signal,
    root: null,
    state: {
      replyTo: null as ReplyTarget | null,
    },
    lastTypingTime: 0,
    lastSendTime: 0,
    textarea: null,
    releaseComposer: null,
    replyBar: null,
    replyText: null,
    replyPingBtn: null,
    disabledReason: options.disabledReason ?? null,
    sendGateReason: null,
    gifUnavailable: options.gifApi === undefined,
    controlButtons: [],
    voice: null,
    attachmentPreviewBar: null,
    uploadErrorEl: null,
    slowModeNote: null,
    slowModeNoteEl: null,
    charCounter: null,
    uploadErrorId: `composer-refusal-${++nextComposerId}`,
    openPicker: null,
    attachHasActions: () => false,
    closeAttachMenu: null,
    togglePickerOf: null,
    mentionPopup: null,
    pickedMentions: [],
    pendingPick: null,
    mentionStart: -1,
    emojiPopup: null,
    emojiStart: -1,
    channelPopup: null,
    channelStart: -1,
    slashPopup: null,
    pendingAttachments: [],
    handedOff: new Set<DraftUpload>(),
    cleanupPickers: null,
    resizeFrame: null,
    activeTimers: new Set(),
    previewCounter: 0,
  };
  const api = {} as InputApi;
  Object.assign(
    api,
    createInputAutocomplete(st, api),
    createInputComposer(st, api),
    createInputSend(st, api),
    createInputAttachments(st, api),
    createInputDraft(st, api),
  );

  function mount(container: Element): void {
    const root = createElement("div", {
      class: "message-input-wrap",
      "data-testid": "message-input",
    });
    st.root = root;
    const replyBar = buildReplyBar(st, api);
    const previewBar = createElement("div", { class: "attachment-preview-bar" });
    st.attachmentPreviewBar = previewBar;

    const inputBox = createElement("div", { class: "message-input-box" });
    const textarea = createComposerTextarea(api);
    st.textarea = textarea;
    const buttons = createComposerButtons(st);
    const { attachBtn, emojiBtn, gifBtn, stickerBtn, pollBtn, sendBtn, micBtn } = buttons;
    wirePlusMenu(st, api, buttons);
    registerControls(st, api, buttons);

    wireTextareaInput(st, api, textarea);
    if (st.options.onUploadFile !== undefined) wireFileDrop(st, api, container);
    wireCaretEvents(st, api, textarea);
    sendBtn.addEventListener("click", api.handleSend, { signal: st.signal });
    wireExpressionPopup(st, api, buttons);

    st.charCounter = createElement("span", {
      class: "char-counter",
      "data-testid": "char-counter",
    });
    st.charCounter.hidden = true;
    if (st.options.noAttach !== true) inputBox.appendChild(attachBtn);
    // Emoji, sticker, GIF: the sticker button sits between the other two.
    appendChildren(inputBox, textarea, emojiBtn);
    if (stickerBtn !== null) inputBox.appendChild(stickerBtn);
    inputBox.appendChild(gifBtn);
    if (pollBtn !== null) inputBox.appendChild(pollBtn);
    if (micBtn !== null) inputBox.appendChild(micBtn);
    appendChildren(inputBox, st.charCounter, sendBtn);
    const refreshButtons = (): void => applyButtonPrefs(st, api, buttons);
    refreshButtons();
    onPrefChange(COMPOSER_BUTTON_PREF_KEYS, refreshButtons, st.signal);
    onPhoneLayoutChange(refreshButtons, st.signal);
    // The open menu belongs to the old layout; the next "+" opens the new one.
    onPhoneLayoutChange(() => st.closeAttachMenu?.(), st.signal);
    const slowNote = createElement("div", {
      class: "composer-slow-note",
      "data-testid": "slow-mode-note",
    });
    st.slowModeNoteEl = slowNote;
    appendChildren(root, replyBar, previewBar, inputBox, slowNote);
    const upload = st.options.onUploadFile;
    if (micBtn !== null && upload !== undefined) wireVoiceMic(st, api, micBtn, upload, inputBox);
    api.applySlowModeNote();
    container.appendChild(root);
    claimForMentions();
    // Apply any initial disabled reason before focusing. On a phone a focus
    // raises the keyboard over the chat the user just opened, so it waits for
    // a tap on the text box.
    api.applyDisabledState();
    if (st.disabledReason === null && !isPhoneLayout()) textarea.focus();
  }

  /** Makes this the composer a Mention goes to, and accepts shares for its chat. */
  function claimForMentions(): void {
    st.releaseComposer?.();
    const mentionTarget = { insertMention: api.insertMentionAtCaret, canMention: api.canTakeText };
    st.releaseComposer = claimComposer(mentionTarget);
    // A share from another app picked for this chat (features/share).
    const releaseShares = acceptSharesFor(options.channelId, (share) => {
      api.restoreDraftText(share.text === "" ? undefined : share.text);
      void api.handleNativeFiles(share.files);
    });
    st.signal.addEventListener("abort", releaseShares, { once: true });
    // With a thread's composer beside this one, a Mention goes where the user is.
    st.root?.addEventListener("focusin", () => focusComposer(mentionTarget), {
      signal: st.disposable.signal,
    });
  }

  function destroy(): void {
    st.releaseComposer?.();
    st.releaseComposer = null;
    // Close any open pickers and their document listeners before aborting
    st.cleanupPickers?.();
    st.cleanupPickers = null;
    // Clear all pending timers
    for (const t of st.activeTimers) clearTimeout(t);
    st.activeTimers.clear();
    if (st.resizeFrame !== null) {
      cancelAnimationFrame(st.resizeFrame);
      st.resizeFrame = null;
    }
    // An unmount must not leave an upload running against a composer
    // that no longer exists, unless getDraft() handed it to the draft.
    for (const att of st.pendingAttachments) {
      if (att.upload === undefined) continue;
      att.upload.onProgress = null;
      if (!st.handedOff.has(att.upload)) att.upload.owner.destroy();
    }
    st.handedOff.clear();
    // The microphone and a clip not yet sent go with the composer.
    st.voice?.destroy();
    st.voice = null;
    st.disposable.destroy();
    // Image previews now use data: URLs (via readFileAsDataUrl) which don't
    // require revocation — just clear the array and let GC reclaim them.
    st.pendingAttachments.length = 0;
    st.slowModeNoteEl = null;
    st.root?.remove();
    st.root = null;
    st.textarea = null;
    st.replyBar = null;
    st.replyText = null;
    st.replyPingBtn = null;
    st.attachmentPreviewBar = null;
    st.uploadErrorEl = null;
    st.charCounter = null;
    st.openPicker = null;
    st.closeAttachMenu = null;
    st.togglePickerOf = null;
  }

  return {
    mount,
    destroy,
    setReplyTo: api.setReplyTo,
    clearReply: api.clearReply,
    focus: api.focus,
    insertMention: api.insertMentionAtCaret,
    isIdle: api.isIdle,
    setDisabled: api.setDisabled,
    setSendGate: api.setSendGate,
    setSlowModeNote: api.setSlowModeNote,
    openFilePicker: api.openFilePicker,
    togglePicker: api.togglePicker,
    getDraft: api.getDraft,
    restoreDraft: api.restoreDraft,
    peekDraft: api.peekDraft,
    restoreUnsent: api.restoreUnsent,
  };
}
