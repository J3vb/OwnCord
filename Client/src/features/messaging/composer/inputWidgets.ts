/**
 * The composer's static parts: the reply bar, the button row, the "+" menu,
 * the voice-message mic and the settings-driven button visibility.
 */
import { createElement } from "@lib/dom";
import { createIcon } from "@lib/icons";
import { authStore } from "@stores/auth.store";
import { pollsEnabled, stickersEnabled } from "@lib/net/serverCapabilities";
import { isPhoneLayout } from "@lib/ui/bottomSheet";
import { isAndroidApp } from "../../voice/native/platform";
import { composerButtonShown } from "../composerButtons";
import { createAttachPickers } from "../attachSheet";
import { voiceMessagesText } from "../../../i18n/voiceMessages";
import { messagingText } from "../../../i18n/messaging";
import { stickersText } from "../../../i18n/stickers";
import { markGifUnavailable, uploadsDisabledByServer } from "./inputShared";
import type { InputState, InputApi } from "./inputState";

/** Reply bar: who is being answered, the ping toggle and a close button. */
export function buildReplyBar(st: InputState, api: InputApi): HTMLElement {
  const bar = createElement("div", { class: "reply-bar" });
  st.replyBar = bar;
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
  bar.appendChild(replyInner);
  return bar;
}

/** Every button in the composer's bar; the optional ones are absent where the
 *  host or the server does not offer them. */
export interface ComposerButtons {
  readonly attachBtn: HTMLButtonElement;
  readonly emojiBtn: HTMLButtonElement;
  readonly gifBtn: HTMLButtonElement;
  readonly stickerBtn: HTMLButtonElement | null;
  readonly pollBtn: HTMLButtonElement | null;
  readonly sendBtn: HTMLButtonElement;
  readonly micBtn: HTMLButtonElement | null;
  /** Whether "+" opens a menu of tiles (a composer that can upload and is not text-only). */
  readonly hasPlusMenu: boolean;
}

/** The textarea; the Android app's Enter key adds a line, the send button sends. */
export function createComposerTextarea(api: InputApi): HTMLTextAreaElement {
  return createElement("textarea", {
    class: "msg-textarea",
    placeholder: api.idlePlaceholder(),
    rows: "1",
    "data-testid": "msg-textarea",
    ...(isAndroidApp() ? { enterkeyhint: "enter" } : {}),
  });
}

/** The Sticker button: only where the host can send one and the server has stickers. */
function createStickerButton(st: InputState): HTMLButtonElement | null {
  if (st.options.onSendSticker === undefined || !stickersEnabled()) return null;
  const btn = createElement("button", {
    class: "input-btn sticker-btn",
    type: "button",
    title: stickersText("button.label"),
    "aria-label": stickersText("button.label"),
    "data-testid": "sticker-btn",
  });
  btn.appendChild(createIcon("sticker", 20));
  return btn;
}

/** The Poll button: only where the host can open the dialog and the server has polls. */
function createPollButton(st: InputState): HTMLButtonElement | null {
  const createPoll = st.options.onCreatePoll;
  if (createPoll === undefined || !pollsEnabled()) return null;
  const btn = createElement(
    "button",
    {
      class: "input-btn poll-btn",
      type: "button",
      title: messagingText("poll.buttonTitle"),
      "aria-label": messagingText("poll.buttonTitle"),
      "data-testid": "poll-btn",
    },
    messagingText("poll.button"),
  );
  btn.addEventListener("click", () => createPoll(), { signal: st.signal });
  return btn;
}

/** The mic: where the composer can upload at all, unless a text-only composer. */
function createMicButton(st: InputState): HTMLButtonElement | null {
  if (st.options.onUploadFile === undefined || st.options.noAttach === true) return null;
  const btn = createElement("button", {
    class: "input-btn mic-btn",
    type: "button",
    title: voiceMessagesText("mic.label"),
    "aria-label": voiceMessagesText("mic.label"),
    "data-testid": "voice-mic-btn",
  });
  btn.appendChild(createIcon("mic", 20));
  btn.setAttribute("hidden", "");
  return btn;
}

export function createComposerButtons(st: InputState): ComposerButtons {
  const attachBtn = createElement(
    "button",
    { class: "input-btn attach-btn", "aria-label": messagingText("attach.label") },
    "+",
  );
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
  if (st.gifUnavailable) markGifUnavailable(gifBtn, messagingText("gif.disabled"));
  const stickerBtn = createStickerButton(st);
  const pollBtn = createPollButton(st);
  const sendBtn = createElement("button", {
    class: "input-btn send-btn",
    "aria-label": messagingText("send.label"),
    "data-testid": "send-btn",
  });
  sendBtn.appendChild(createIcon("send", 20));
  const micBtn = createMicButton(st);
  const hasPlusMenu = st.options.onUploadFile !== undefined && st.options.noAttach !== true;
  return { attachBtn, emojiBtn, gifBtn, stickerBtn, pollBtn, sendBtn, micBtn, hasPlusMenu };
}

/** "+" opens a menu of tiles: the file sources, then Poll and (off the
 *  phone) Sticker. Their bar buttons stay in the DOM, always hidden, as the
 *  targets the tiles click, so gates and the picker tabs work as before. */
export function wirePlusMenu(st: InputState, api: InputApi, buttons: ComposerButtons): void {
  const { attachBtn, pollBtn, stickerBtn } = buttons;
  if (st.options.onUploadFile === undefined) {
    attachBtn.setAttribute("disabled", "true");
    attachBtn.title = messagingText("attach.unavailable");
    return;
  }
  const pickers = createAttachPickers({
    onFile: (file) => void api.handlePasteFile(file),
    canAttach: () => st.disabledReason === null && !uploadsDisabledByServer(),
    signal: st.signal,
    menuHost: () => st.root,
    actions: [
      {
        id: "poll",
        icon: "chart-column",
        label: messagingText("attach.poll"),
        available: () =>
          pollBtn !== null && st.disabledReason === null && composerButtonShown("poll"),
        run: () => pollBtn?.click(),
      },
      {
        id: "sticker",
        icon: "sticker",
        label: messagingText("attach.sticker"),
        layout: "desktop",
        available: () =>
          stickerBtn !== null && st.disabledReason === null && composerButtonShown("sticker"),
        run: () => stickerBtn?.click(),
      },
    ],
  });
  attachBtn.addEventListener("click", () => pickers.open(attachBtn), { signal: st.signal });
  st.openPicker = pickers.openFiles;
  st.attachHasActions = pickers.hasActions;
  st.closeAttachMenu = pickers.close;
  st.root?.append(...pickers.inputs);
}

/** Register interactive controls so the disabled state can toggle them. */
export function registerControls(st: InputState, api: InputApi, buttons: ComposerButtons): void {
  const { sendBtn, emojiBtn, gifBtn, stickerBtn, pollBtn, micBtn, attachBtn } = buttons;
  st.controlButtons.length = 0;
  st.controlButtons.push(sendBtn, emojiBtn, gifBtn);
  if (stickerBtn !== null) st.controlButtons.push(stickerBtn);
  if (pollBtn !== null) st.controlButtons.push(pollBtn);
  if (micBtn !== null) st.controlButtons.push(micBtn);
  if (st.options.onUploadFile === undefined) return;
  st.controlButtons.push(attachBtn);
  st.disposable.onStoreChange(
    authStore,
    (s) => s.uploadPolicy?.max_upload_bytes,
    () => api.applyDisabledState(),
  );
}

/** On a phone, Emoji and GIF give way while the box holds text, so short
 *  text does not wrap; they return once it is empty. Shortcuts still work. */
function typingOnPhone(st: InputState, phone: boolean): boolean {
  return phone && st.textarea !== null && st.textarea.value !== "";
}

/** A text-change hook that re-applies the button prefs only when the
 *  typing state differs from the one applyButtonPrefs last applied, whatever
 *  ran it (a pref change, a layout change or this hook). */
export function trackTypingButtons(st: InputState, refresh: () => void): () => void {
  return () => {
    if (typingOnPhone(st, isPhoneLayout()) !== st.typingButtonsHidden) refresh();
  };
}

/** Which of the row's optional buttons are hidden, as one comparable value. */
function rowShape(buttons: ComposerButtons): string {
  const { emojiBtn, gifBtn, stickerBtn, pollBtn, micBtn } = buttons;
  return [emojiBtn, gifBtn, stickerBtn, pollBtn, micBtn].map((b) => b?.hidden === true).join();
}

/** Settings → Text & Images can hide each button; Sticker and Poll live in
 *  the "+" menu. On a phone the smiley also holds the sticker tab. A row that
 *  gains or loses a button changes the textarea's width, so text already in
 *  it is measured again once the buttons are settled. */
export function applyButtonPrefs(st: InputState, api: InputApi, buttons: ComposerButtons): void {
  const before = rowShape(buttons);
  applyButtonVisibility(st, buttons);
  api.applyDisabledState();
  if (rowShape(buttons) !== before && st.textarea !== null && st.textarea.value !== "") {
    api.measureTextarea();
  }
}

function applyButtonVisibility(st: InputState, buttons: ComposerButtons): void {
  const { emojiBtn, gifBtn, stickerBtn, pollBtn, hasPlusMenu } = buttons;
  const phone = isPhoneLayout();
  const typing = typingOnPhone(st, phone);
  st.typingButtonsHidden = typing;
  // GIF has its own button; on a phone the smiley also stands for stickers.
  const anyExpression =
    composerButtonShown("emoji") || (stickerBtn !== null && composerButtonShown("sticker"));
  emojiBtn.hidden = typing || (phone ? !anyExpression : !composerButtonShown("emoji"));
  const emojiLabel = messagingText(phone ? "expression.label" : "emoji.label");
  emojiBtn.setAttribute("aria-label", emojiLabel);
  emojiBtn.title = phone ? emojiLabel : "";
  gifBtn.hidden = typing || !composerButtonShown("gif");
  // A composer without "+" (a thread's) keeps Sticker in its bar.
  if (stickerBtn !== null) {
    stickerBtn.hidden = hasPlusMenu || phone || !composerButtonShown("sticker");
  }
  if (pollBtn !== null) pollBtn.hidden = hasPlusMenu || phone || !composerButtonShown("poll");
}

/** The recorder and its bar load on the first mic click, so they stay out of the app chunk. */
export function wireVoiceMic(
  st: InputState,
  api: InputApi,
  micBtn: HTMLButtonElement,
  upload: NonNullable<InputState["options"]["onUploadFile"]>,
  inputBox: HTMLElement,
): void {
  const voiceHost = st.root;
  if (voiceHost === null) return;
  let voiceLoading = false;
  const startVoice = async (): Promise<void> => {
    if (st.voice === null) {
      if (voiceLoading) return;
      voiceLoading = true;
      let mod: typeof import("../../voice-messages/voiceComposer");
      try {
        mod = await import("../../voice-messages/voiceComposer");
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
