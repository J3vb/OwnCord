/**
 * The message input's own state: reply bar, height, character counter, typing
 * pings, formatting shortcuts and the disabled, send-gate and slow-mode states.
 */
import { setText } from "@lib/dom";
import { wrapWithMarker } from "../../features/messaging/markdownMarkers";
import { MAX_MESSAGE_LEN } from "../../features/messaging/messageLimits";
import { voiceMessagesEnabled } from "@lib/net/serverCapabilities";
import { composerButtonShown } from "../../features/messaging/composerButtons";
import { messagingText } from "../../i18n/messaging";
import {
  TYPING_THROTTLE_MS,
  MAX_TEXTAREA_HEIGHT,
  uploadsDisabledByServer,
  COUNTER_FROM_REMAINING,
} from "./inputShared";
import type { InputState, InputApi } from "./inputState";
import type { ReplyTarget } from "../MessageInput";

export function createInputComposer(st: InputState, api: InputApi) {
  /** Apply a formatting marker to the current textarea selection. */
  function applyFormatting(marker: string): void {
    if (st.textarea === null || st.disabledReason !== null) return;
    const result = wrapWithMarker(
      st.textarea.value,
      st.textarea.selectionStart,
      st.textarea.selectionEnd,
      marker,
    );
    st.textarea.value = result.value;
    st.textarea.selectionStart = result.selectionStart;
    st.textarea.selectionEnd = result.selectionEnd;
    autoResize();
    maybeEmitTyping();
  }

  function showReplyBar(): void {
    const reply = st.state.replyTo;
    if (st.replyBar === null || st.replyText === null || reply === null) return;
    setText(st.replyText, messagingText("reply.replyingTo", { username: reply.username }));
    if (st.replyPingBtn !== null) {
      const on = reply.ping !== false;
      st.replyPingBtn.hidden = reply.self === true;
      st.replyPingBtn.classList.toggle("off", !on);
      st.replyPingBtn.setAttribute("aria-pressed", String(on));
      setText(st.replyPingBtn, messagingText(on ? "reply.pingOn" : "reply.pingOff"));
    }
    st.replyBar.classList.add("visible");
  }

  /** The reply's @ON/@OFF: false for no reply or a reply to yourself. */
  function replyPing(): boolean {
    const reply = st.state.replyTo;
    return reply !== null && reply.self !== true && reply.ping !== false;
  }

  function hideReplyBar(): void {
    st.replyBar?.classList.remove("visible");
  }

  /** The one auto/measure cycle: setting "auto" then reading scrollHeight
   *  forces a synchronous layout, so it runs once per frame at most. Any
   *  frame still pending is dropped, its work done here. */
  function measureTextarea(): void {
    if (st.resizeFrame !== null) {
      cancelAnimationFrame(st.resizeFrame);
      st.resizeFrame = null;
    }
    if (st.textarea === null) return;
    st.textarea.style.height = "auto";
    st.textarea.style.height = `${Math.min(st.textarea.scrollHeight, MAX_TEXTAREA_HEIGHT)}px`;
  }

  /** Programmatic changes (send, draft restore, completions, formatting)
   *  resize synchronously so the next read sees the final height. */
  function autoResize(): void {
    if (st.textarea === null) return;
    measureTextarea();
    updateCounter();
    st.options.onDraftChange?.();
  }

  /** Typing: the counter and draft hook stay per-keystroke, but the layout
   *  measure is coalesced to one per animation frame (before paint, so the
   *  user sees the same height as a synchronous resize). A textarea never
   *  measured yet gets its first height at once. */
  function autoResizeOnInput(): void {
    if (st.textarea === null) return;
    if (st.textarea.style.height === "") {
      autoResize();
      return;
    }
    st.resizeFrame ??= requestAnimationFrame(() => {
      st.resizeFrame = null;
      measureTextarea();
    });
    updateCounter();
    st.options.onDraftChange?.();
  }

  /** Characters left near the limit, red past it. Every change to the text,
   *  typed or programmatic (formatting, completions), goes through
   *  autoResize(), so the counter and the draft hook are driven from there. */
  function updateCounter(): void {
    if (st.charCounter === null || st.textarea === null) return;
    const left = MAX_MESSAGE_LEN - [...st.textarea.value.trim()].length;
    const show = left <= COUNTER_FROM_REMAINING;
    st.charCounter.hidden = !show;
    if (!show) return;
    setText(st.charCounter, String(left));
    st.charCounter.classList.toggle("over", left < 0);
    st.charCounter.title = messagingText(left < 0 ? "counter.over" : "counter.left", {
      count: String(Math.abs(left)),
    });
  }

  function maybeEmitTyping(): void {
    const now = Date.now();
    if (now - st.lastTypingTime >= TYPING_THROTTLE_MS) {
      st.lastTypingTime = now;
      st.options.onTyping();
    }
  }

  function idlePlaceholder(): string {
    return (
      st.options.placeholder ??
      messagingText("composer.placeholder", { channel: st.options.channelName })
    );
  }

  /** Reflect the current disabledReason onto the DOM (textarea + controls). */
  function applyDisabledState(): void {
    if (st.textarea === null) return;
    const disabled = st.disabledReason !== null;
    // DESIGN_SYSTEM "Disabled": a gated composer uses aria-disabled +
    // readOnly rather than the `disabled` attribute, because disabling a
    // focused element drops focus to <body> and loses the caret mid-sentence.
    // Send is refused in handleSend() with the reason; the buttons stay
    // `disabled` (they are not focus targets the user is typing into).
    st.textarea.readOnly = disabled;
    st.textarea.setAttribute("aria-disabled", String(disabled));
    st.textarea.placeholder = disabled ? st.disabledReason! : idlePlaceholder();
    const uploadsOff = uploadsDisabledByServer();
    for (const btn of st.controlButtons) {
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
        if (btn.classList.contains("gif-btn") && st.gifUnavailable) continue;
        btn.removeAttribute("disabled");
      }
    }
    if (st.root !== null) {
      st.root.classList.toggle("composer-disabled", disabled);
    }
    // A slow-mode send gate does not freeze the composer, but the send control
    // must read as unavailable, and the reason becomes its title.
    const sendBtn = st.controlButtons[0];
    if (sendBtn !== undefined && !disabled) {
      const gated = st.sendGateReason !== null;
      sendBtn.classList.toggle("send-gated", gated);
      sendBtn.title = gated ? st.sendGateReason! : "";
    }
  }

  function setDisabled(reason: string | null): void {
    if (st.uploadErrorEl?.textContent === st.disabledReason) {
      if (reason === null) api.clearUploadError();
      else api.showUploadError(reason);
    }
    st.disabledReason = reason;
    applyDisabledState();
  }

  function setSendGate(reason: string | null): void {
    if (st.uploadErrorEl?.textContent === st.sendGateReason) {
      if (reason === null) api.clearUploadError();
      else api.showUploadError(reason);
    }
    st.sendGateReason = reason;
    applyDisabledState();
  }

  function setSlowModeNote(text: string | null): void {
    st.slowModeNote = text;
    applySlowModeNote();
  }

  function applySlowModeNote(): void {
    if (st.slowModeNoteEl === null) return;
    st.slowModeNoteEl.hidden = st.slowModeNote === null;
    st.slowModeNoteEl.textContent = st.slowModeNote ?? "";
  }

  function setReplyTo(
    messageId: number,
    username: string,
    opts: Pick<ReplyTarget, "ping" | "self"> = {},
  ): void {
    st.state = { replyTo: { messageId, username, ...opts } };
    showReplyBar();
    st.textarea?.focus();
    st.options.onDraftChange?.();
  }

  function clearReply(): void {
    st.state = { ...st.state, replyTo: null };
    hideReplyBar();
    st.options.onDraftChange?.();
  }

  function focus(): void {
    st.textarea?.focus();
  }

  function isIdle(): boolean {
    return (
      (st.textarea?.value ?? "") === "" &&
      st.state.replyTo === null &&
      st.pendingAttachments.length === 0
    );
  }

  /** Whether the composer would take text right now. */
  function canTakeText(): boolean {
    return (
      st.textarea !== null &&
      st.disabledReason === null &&
      !st.textarea.readOnly &&
      !st.textarea.disabled
    );
  }

  function togglePicker(kind: "emoji" | "gif" | "sticker"): void {
    st.togglePickerOf?.(kind);
  }

  return {
    applyFormatting,
    showReplyBar,
    replyPing,
    hideReplyBar,
    measureTextarea,
    autoResize,
    autoResizeOnInput,
    updateCounter,
    maybeEmitTyping,
    idlePlaceholder,
    applyDisabledState,
    setDisabled,
    setSendGate,
    setSlowModeNote,
    applySlowModeNote,
    setReplyTo,
    clearReply,
    focus,
    isIdle,
    canTakeText,
    togglePicker,
  };
}
