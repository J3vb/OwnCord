/**
 * MessageInput component — textarea with send and reply bar.
 * Step 5.42 of the Tauri v2 migration.
 */

import { Disposable } from "@lib/disposable";
import { isImeCommit } from "@lib/text/ime";
import { isAndroidApp } from "../features/voice/native/platform";
import { dialogOpen } from "@lib/ui/dialogOpen";
import { isPhoneLayout, openBottomSheet, type BottomSheet } from "@lib/ui/bottomSheet";
import { createElement, appendChildren, setOwnedTimeout } from "@lib/dom";
import { createIcon } from "@lib/icons";
import type { MountableComponent } from "@lib/text/safeRender";
import { listCustomEmoji } from "@stores/emoji.store";
import { claimComposer, focusComposer } from "../features/messaging/activeComposer";
import type { PickedMention } from "@lib/text/pickedMentions";
import { FORMAT_MARKERS, wrapWithMarker } from "../features/messaging/markdownMarkers";
import { authStore } from "@stores/auth.store";
import { pollsEnabled, stickersEnabled } from "@lib/net/serverCapabilities";
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
import { voiceMessagesText } from "../i18n/voiceMessages";
import { messagingText } from "../i18n/messaging";
import { stickersText } from "../i18n/stickers";
import type { GifApi, GifFavoritesApi } from "@lib/media/gifProvider";
import {
  emojiPickerScreen,
  gifPickerScreen,
  stickerPickerScreen,
  SEND_DEBOUNCE_MS,
  uploadsDisabledByServer,
  DROP_SLOTS,
  CARET_MOVE_KEYS,
  markGifUnavailable,
} from "./message-input/inputShared";
import type { InputState, InputApi } from "./message-input/inputState";
import { createInputAutocomplete } from "./message-input/inputAutocomplete";
import { createInputComposer } from "./message-input/inputComposer";
import { createInputSend } from "./message-input/inputSend";
import { createInputAttachments } from "./message-input/inputAttachments";
import { createInputDraft } from "./message-input/inputDraft";

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
    st.root = createElement("div", { class: "message-input-wrap", "data-testid": "message-input" });

    st.replyBar = createElement("div", { class: "reply-bar" });
    const replyInner = createElement("div", { class: "reply-bar-inner" });
    st.replyText = createElement("strong", {});
    replyInner.appendChild(st.replyText);
    st.replyPingBtn = createElement("button", {
      class: "reply-ping",
      type: "button",
      "data-testid": "reply-ping",
      title: messagingText("reply.pingLabel"),
      "aria-label": messagingText("reply.pingLabel"),
    });
    st.replyPingBtn.addEventListener(
      "click",
      () => {
        if (st.state.replyTo === null) return;
        st.state = { ...st.state, replyTo: { ...st.state.replyTo, ping: !api.replyPing() } };
        api.showReplyBar();
        st.options.onDraftChange?.();
        st.textarea?.focus();
      },
      { signal: st.signal },
    );
    replyInner.appendChild(st.replyPingBtn);
    const replyClose = createElement("button", {
      class: "reply-close",
      "aria-label": messagingText("reply.cancel"),
    });
    replyClose.appendChild(createIcon("x", 14));
    replyClose.addEventListener("click", api.clearReply, { signal: st.signal });
    replyInner.appendChild(replyClose);
    st.replyBar.appendChild(replyInner);

    st.attachmentPreviewBar = createElement("div", { class: "attachment-preview-bar" });

    const inputBox = createElement("div", { class: "message-input-box" });
    const attachBtn = createElement(
      "button",
      { class: "input-btn attach-btn", "aria-label": messagingText("attach.label") },
      "+",
    );

    // File picker via attach button
    if (st.options.onUploadFile !== undefined) {
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
          for (const file of files) void api.handlePasteFile(file);
        },
        { signal: st.signal },
      );
      attachBtn.addEventListener("click", () => fileInput.click(), { signal: st.signal });
      st.openPicker = () => {
        if (st.disabledReason !== null || uploadsDisabledByServer()) return;
        fileInput.click();
      };
      st.root?.appendChild(fileInput);
    } else {
      attachBtn.setAttribute("disabled", "true");
      attachBtn.title = messagingText("attach.unavailable");
    }
    st.textarea = createElement("textarea", {
      class: "msg-textarea",
      placeholder: api.idlePlaceholder(),
      rows: "1",
      "data-testid": "msg-textarea",
      // The Android app's Enter key adds a line; the send button sends.
      ...(isAndroidApp() ? { enterkeyhint: "enter" } : {}),
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
    if (st.gifUnavailable) {
      markGifUnavailable(gifBtn, messagingText("gif.disabled"));
    }
    // The Sticker button: only where the host can send one and the server has stickers.
    const sendSticker = st.options.onSendSticker;
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
    const createPoll = st.options.onCreatePoll;
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
    pollBtn?.addEventListener("click", () => createPoll?.(), { signal: st.signal });
    const sendBtn = createElement("button", {
      class: "input-btn send-btn",
      "aria-label": messagingText("send.label"),
      "data-testid": "send-btn",
    });
    sendBtn.appendChild(createIcon("send", 20));
    // The mic: where the composer can upload at all, unless a text-only composer.
    const micBtn =
      st.options.onUploadFile !== undefined && st.options.noAttach !== true
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
    st.controlButtons.length = 0;
    st.controlButtons.push(sendBtn, emojiBtn, gifBtn);
    if (stickerBtn !== null) st.controlButtons.push(stickerBtn);
    if (pollBtn !== null) st.controlButtons.push(pollBtn);
    if (micBtn !== null) st.controlButtons.push(micBtn);
    if (st.options.onUploadFile !== undefined) {
      st.controlButtons.push(attachBtn);
      st.disposable.onStoreChange(
        authStore,
        (s) => s.uploadPolicy?.max_upload_bytes,
        () => api.applyDisabledState(),
      );
    }

    st.textarea.addEventListener(
      "input",
      () => {
        api.autoResizeOnInput();
        api.maybeEmitTyping();
        // A cleared draft forgets what was picked into it.
        if (st.textarea?.value === "") st.pickedMentions = [];
        api.syncAutocomplete();
        // An edit is the user acting on the refusal, so the line goes away.
        api.clearUploadError();
      },
      { signal: st.signal },
    );
    st.textarea.addEventListener(
      "keydown",
      (e: KeyboardEvent) => {
        // Whichever popup is open owns navigation keys, so Enter completes the
        // token instead of sending a half-typed message.
        if (st.slashPopup?.handleKeydown(e) === true) return;
        if (st.mentionPopup?.handleKeydown(e) === true) return;
        if (st.channelPopup?.handleKeydown(e) === true) return;
        if (st.emojiPopup?.handleKeydown(e) === true) return;

        // Ctrl+B / Ctrl+I / Ctrl+U wrap the selection in markdown markers.
        // The composer owns Ctrl+U while it has focus, so the propagation stop
        // is load-bearing: without it the global upload shortcut would fire on
        // top of the underline.
        if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
          const marker = FORMAT_MARKERS[e.key.toLowerCase()];
          if (marker !== undefined) {
            e.preventDefault();
            e.stopPropagation();
            api.applyFormatting(marker);
            return;
          }
        }

        if (e.key === "Enter" && !e.shiftKey) {
          // A CJK IME commits the current candidate on Enter, firing keydown
          // with isComposing true (or the legacy keyCode 229). Sending here
          // would ship the raw composition text instead of the committed word.
          if (isImeCommit(e)) return;
          // On the Android app Enter adds a new line, and the send button sends.
          if (isAndroidApp()) return;
          e.preventDefault();
          api.handleSend();
        }
        // An Escape that cancels something is used up: the app-wide Escape
        // (mark the channel read) leaves a prevented key alone.
        if (e.key === "Escape" && !isImeCommit(e)) {
          if (st.state.replyTo !== null) {
            e.preventDefault();
            api.clearReply();
          }
        }
        if (
          e.key === "ArrowUp" &&
          !(e.shiftKey || e.altKey || e.ctrlKey || e.metaKey || e.isComposing) &&
          st.disabledReason === null &&
          st.textarea !== null &&
          st.textarea.value.length === 0
        ) {
          // The browser's own ArrowUp would move the caret in the (empty)
          // composer as the inline editor takes focus.
          e.preventDefault();
          st.root?.dispatchEvent(new CustomEvent("edit-last-message", { bubbles: true }));
        }
      },
      { signal: st.signal },
    );

    // Clipboard paste: detect images/files
    st.textarea.addEventListener(
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
          void api.handlePasteFile(file);
        }
        if (!pastedFile) api.pasteLongTextAsFile(e);
      },
      { signal: st.signal },
    );

    // Files dragged in from the OS: accepted over the channel view only, and
    // never while an overlay covers it. Other drops are left to the app-wide
    // fileDropGuard, which cancels them without uploading.
    if (st.options.onUploadFile !== undefined) {
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
          for (const file of dt.files) void api.handlePasteFile(file);
        },
        { signal: st.signal },
      );
      api.wireDropOverlay(container);
    }

    // Caret moves that aren't typing (click, arrow/Home/End keys, blur) also
    // decide the popup's fate — without this, completing a mention/emoji
    // after moving the caret away with the keyboard splices at a stale offset.
    st.textarea.addEventListener("click", api.syncAutocomplete, { signal: st.signal });
    st.textarea.addEventListener(
      "keyup",
      (e: KeyboardEvent) => {
        if (CARET_MOVE_KEYS.has(e.key)) api.syncAutocomplete();
      },
      { signal: st.signal },
    );
    st.textarea.addEventListener(
      "blur",
      () => {
        api.closeSlashPopup();
        api.closeMentionPopup();
        api.closeChannelPopup();
        api.closeEmojiPopup();
      },
      { signal: st.signal },
    );

    sendBtn.addEventListener("click", api.handleSend, { signal: st.signal });

    // The GIF, sticker and emoji buttons share one tabbed popup. Each
    // button opens it on its own tab; the active tab's button closes it.
    let popup: ExpressionPopup | null = null;
    // One outside-click owner for the open popup, destroyed when it closes.
    let popupDismiss: Disposable | null = null;
    // On a phone the popup lives in a bottom sheet instead, which owns dismissal.
    let popupSheet: BottomSheet | null = null;

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
      const sheet = popupSheet;
      popupSheet = null;
      sheet?.close();
      closing.element.remove();
      closing.destroy();
      if (!returnFocus) return;
      const btn = tabButton(tab);
      // A button the user hid in settings cannot take focus; the textarea can.
      if (btn !== null && !btn.hidden) btn.focus();
      else st.textarea?.focus();
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
      const refusal = st.disabledReason ?? st.sendGateReason;
      if (refusal !== null) {
        api.showUploadError(refusal);
        return;
      }
      const now = Date.now();
      if (now - st.lastSendTime < SEND_DEBOUNCE_MS) return;
      st.lastSendTime = now;
      st.options.onSendSticker?.(sticker, st.state.replyTo?.messageId ?? null, api.replyPing());
      api.clearReply();
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
            if (st.textarea !== null) {
              const start = st.textarea.selectionStart;
              const end = st.textarea.selectionEnd;
              const before = st.textarea.value.slice(0, start);
              const after = st.textarea.value.slice(end);
              st.textarea.value = before + emoji + after;
              st.textarea.selectionStart = st.textarea.selectionEnd = start + emoji.length;
              // Shift-pick keeps focus in the picker so the next pick lands at
              // the caret just advanced.
              if (!keepOpen) st.textarea.focus();
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
      const gifApi = st.options.gifApi;
      if (gifApi === undefined) return null;
      const screen = await gifPickerScreen.load(wanted);
      if (screen === null) return null;
      return screen.createGifPicker({
        api: gifApi,
        onUnavailable: (reason: string) => {
          st.gifUnavailable = true;
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
          const refusal = st.disabledReason ?? st.sendGateReason;
          if (refusal !== null) {
            api.showUploadError(refusal);
          } else {
            const now = Date.now();
            if (now - st.lastSendTime >= SEND_DEBOUNCE_MS) {
              st.lastSendTime = now;
              st.options.onSend(
                gifUrl,
                st.state.replyTo?.messageId ?? null,
                [],
                [],
                api.replyPing(),
              );
              api.clearReply();
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
      if (st.options.gifApi !== undefined && !st.gifUnavailable) tabs.push("gif");
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
      if (isPhoneLayout()) {
        opened.element.classList.add("in-sheet");
        const sheet = openBottomSheet({
          label: stickersText("popup.label"),
          content: opened.element,
          size: "tall",
          className: "picker-sheet",
          testId: "expression-sheet",
          focusFirst: false,
          signal: st.signal,
          onClosed: () => {
            if (popupSheet === sheet) closePopup();
          },
        });
        popupSheet = sheet;
        opened.element.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();
        return;
      }
      st.root?.appendChild(opened.element);
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

    emojiBtn.addEventListener("click", () => toggleTab("emoji"), { signal: st.signal });
    gifBtn.addEventListener("click", () => toggleTab("gif"), { signal: st.signal });
    stickerBtn?.addEventListener("click", () => toggleTab("sticker"), { signal: st.signal });

    st.togglePickerOf = (kind) => {
      const btn = tabButton(kind);
      if (btn === null || btn.disabled) return;
      toggleTab(kind);
    };

    // Store picker cleanup for destroy()
    st.cleanupPickers = () => {
      closePopup();
      api.closeSlashPopup();
      api.closeMentionPopup();
      api.closeChannelPopup();
      api.closeEmojiPopup();
    };

    st.charCounter = createElement("span", {
      class: "char-counter",
      "data-testid": "char-counter",
    });
    st.charCounter.hidden = true;
    if (st.options.noAttach !== true) inputBox.appendChild(attachBtn);
    // Emoji, sticker, GIF: the sticker button sits between the other two.
    appendChildren(inputBox, st.textarea, emojiBtn);
    if (stickerBtn !== null) inputBox.appendChild(stickerBtn);
    inputBox.appendChild(gifBtn);
    if (pollBtn !== null) inputBox.appendChild(pollBtn);
    if (micBtn !== null) inputBox.appendChild(micBtn);
    appendChildren(inputBox, st.charCounter, sendBtn);
    // Settings → Text & Images can hide each of these; the switch applies live.
    const applyButtonPrefs = (): void => {
      emojiBtn.hidden = !composerButtonShown("emoji");
      gifBtn.hidden = !composerButtonShown("gif");
      if (stickerBtn !== null) stickerBtn.hidden = !composerButtonShown("sticker");
      if (pollBtn !== null) pollBtn.hidden = !composerButtonShown("poll");
      api.applyDisabledState();
    };
    applyButtonPrefs();
    onPrefChange(COMPOSER_BUTTON_PREF_KEYS, applyButtonPrefs, st.signal);
    st.slowModeNoteEl = createElement("div", {
      class: "composer-slow-note",
      "data-testid": "slow-mode-note",
    });
    appendChildren(st.root, st.replyBar, st.attachmentPreviewBar, inputBox, st.slowModeNoteEl);
    const upload = st.options.onUploadFile;
    if (micBtn !== null && upload !== undefined) {
      const voiceHost = st.root;
      // The recorder and its bar load on the first mic click, so they stay out of the app chunk.
      let voiceLoading = false;
      const startVoice = async (): Promise<void> => {
        if (st.voice === null) {
          if (voiceLoading) return;
          voiceLoading = true;
          let mod: typeof import("../features/voice-messages/voiceComposer");
          try {
            mod = await import("../features/voice-messages/voiceComposer");
          } catch {
            voiceLoading = false;
            if (!st.signal.aborted) api.showUploadError(voiceMessagesText("error.failed"));
            return;
          }
          voiceLoading = false;
          // The composer was destroyed while the code loaded.
          if (st.signal.aborted) return;
          st.voice ??= mod.createVoiceComposer({
            host: voiceHost,
            before: inputBox,
            root: voiceHost,
            signal: st.signal,
            upload: (file, meta, uploadSignal) => upload(file, uploadSignal, undefined, meta),
            ...(st.options.onDiscardUpload === undefined
              ? {}
              : { discardUpload: st.options.onDiscardUpload }),
            send: (attachment) => {
              // A message of its own: no text, the reply stays (as on Discord).
              st.options.onSend(
                "",
                st.state.replyTo?.messageId ?? null,
                [attachment.id],
                [attachment],
                api.replyPing(),
              );
              api.clearReply();
            },
            gate: () =>
              st.disabledReason ??
              st.sendGateReason ??
              (uploadsDisabledByServer() ? messagingText("attach.serverDisabled") : null),
            onError: api.showUploadError,
            onClearError: api.clearUploadError,
            onActiveChange: (active) => {
              if (!active) st.textarea?.focus();
            },
          });
        }
        st.voice.start();
      };
      micBtn.addEventListener("click", () => void startVoice(), { signal: st.signal });
    }
    api.applySlowModeNote();
    container.appendChild(st.root);
    st.releaseComposer?.();
    const mentionTarget = { insertMention: api.insertMentionAtCaret, canMention: api.canTakeText };
    st.releaseComposer = claimComposer(mentionTarget);
    // With a thread's composer beside this one, a Mention goes where the user is.
    st.root.addEventListener("focusin", () => focusComposer(mentionTarget), {
      signal: st.disposable.signal,
    });
    // Apply any initial disabled reason before focusing.
    api.applyDisabledState();
    if (st.disabledReason === null) {
      st.textarea.focus();
    }
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
