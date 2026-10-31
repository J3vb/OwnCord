import { describe, it, expect, vi, afterEach } from "vitest";
import * as mocks from "../../helpers/messageInputMocks";
import { createMessageInput } from "@components/MessageInput";
import {
  makeOptions,
  mountInput,
  selectFiles,
  useMessageInputContainer,
} from "../../helpers/messageInputHarness";
import { clearHost, hostAndroidApp, hostDesktopApp } from "../../helpers/androidHost";

vi.mock("@components/EmojiPicker", () => mocks.emojiPickerMock());
vi.mock("@components/GifPicker", () => mocks.gifPickerMock());

describe("MessageInput", () => {
  let container: HTMLDivElement;
  useMessageInputContainer((el) => {
    container = el;
  });

  afterEach(() => {
    clearHost();
  });

  it("mounts with message-input-wrap class", () => {
    const { comp } = mountInput(container);

    expect(container.querySelector(".message-input-wrap")).not.toBeNull();

    comp.destroy?.();
  });

  it("has textarea with correct placeholder", () => {
    const { comp } = mountInput(container, { channelName: "random" });

    const textarea = container.querySelector(".msg-textarea") as HTMLTextAreaElement;
    expect(textarea).not.toBeNull();
    expect(textarea.placeholder).toBe("Message #random");

    comp.destroy?.();
  });

  it("send button click calls onSend with textarea content", () => {
    const { opts, comp } = mountInput(container);

    const textarea = container.querySelector(".msg-textarea") as HTMLTextAreaElement;
    textarea.value = "Hello world";

    const sendBtn = container.querySelector(".send-btn") as HTMLButtonElement;
    sendBtn.click();

    expect(opts.onSend).toHaveBeenCalledWith("Hello world", null, [], [], false);

    comp.destroy?.();
  });

  it("enter key sends message", () => {
    const { opts, comp } = mountInput(container);

    const textarea = container.querySelector(".msg-textarea") as HTMLTextAreaElement;
    textarea.value = "Enter message";

    textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    expect(opts.onSend).toHaveBeenCalledWith("Enter message", null, [], [], false);

    comp.destroy?.();
  });

  it("Enter during an IME composition does not send the half-composed text (F3)", () => {
    // CJK IMEs commit a candidate on Enter, firing keydown with isComposing
    // true. Sending there would ship the raw kana/composition string.
    const { opts, comp } = mountInput(container);

    const textarea = container.querySelector(".msg-textarea") as HTMLTextAreaElement;
    textarea.value = "\u3042"; // composing kana

    textarea.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true }),
    );

    expect(opts.onSend).not.toHaveBeenCalled();

    comp.destroy?.();
  });

  it("the desktop app sends on Enter and keeps the default Enter key hint", () => {
    hostDesktopApp();
    const { opts, comp } = mountInput(container);

    const textarea = container.querySelector(".msg-textarea") as HTMLTextAreaElement;
    expect(textarea.hasAttribute("enterkeyhint")).toBe(false);
    textarea.value = "Hello";
    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    textarea.dispatchEvent(enter);

    expect(enter.defaultPrevented).toBe(true);
    expect(opts.onSend).toHaveBeenCalledTimes(1);

    comp.destroy?.();
  });

  it("the Android app adds a new line on Enter and sends only from the send button", () => {
    hostAndroidApp();
    const { opts, comp } = mountInput(container);

    const textarea = container.querySelector(".msg-textarea") as HTMLTextAreaElement;
    expect(textarea.getAttribute("enterkeyhint")).toBe("enter");
    textarea.value = "Hello";
    // Not prevented, so the field inserts its own line break.
    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    textarea.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(false);
    expect(opts.onSend).not.toHaveBeenCalled();
    expect(textarea.value).toBe("Hello");

    const sendBtn = container.querySelector(".send-btn") as HTMLButtonElement;
    sendBtn.click();
    expect(opts.onSend).toHaveBeenCalledWith("Hello", null, [], [], false);

    comp.destroy?.();
  });

  it("shift+enter does NOT send (just newlines)", () => {
    const { opts, comp } = mountInput(container);

    const textarea = container.querySelector(".msg-textarea") as HTMLTextAreaElement;
    textarea.value = "Line 1";

    textarea.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true }),
    );

    expect(opts.onSend).not.toHaveBeenCalled();

    comp.destroy?.();
  });

  it("empty textarea does not send", () => {
    const { opts, comp } = mountInput(container);

    const textarea = container.querySelector(".msg-textarea") as HTMLTextAreaElement;
    textarea.value = "";

    const sendBtn = container.querySelector(".send-btn") as HTMLButtonElement;
    sendBtn.click();

    expect(opts.onSend).not.toHaveBeenCalled();

    comp.destroy?.();
  });

  it("refuses a send past the server's 4000 code point limit", () => {
    const { opts, comp } = mountInput(container);

    const textarea = container.querySelector(".msg-textarea") as HTMLTextAreaElement;
    textarea.value = "a".repeat(4001);

    const sendBtn = container.querySelector(".send-btn") as HTMLButtonElement;
    sendBtn.click();

    expect(opts.onSend).not.toHaveBeenCalled();
    const errEl = container.querySelector(".attachment-upload-error");
    expect(errEl).not.toBeNull();
    expect(errEl?.textContent).toContain("4000");

    comp.destroy?.();
  });

  it("dismisses the refusal line with its close button", () => {
    const { comp } = mountInput(container);

    const textarea = container.querySelector(".msg-textarea") as HTMLTextAreaElement;
    textarea.value = "a".repeat(4001);
    (container.querySelector(".send-btn") as HTMLButtonElement).click();

    const dismiss = container.querySelector(
      ".attachment-upload-error-dismiss",
    ) as HTMLButtonElement | null;
    expect(dismiss?.getAttribute("aria-label")).toBe("Dismiss");
    dismiss!.click();

    expect(container.querySelector(".attachment-upload-error")).toBeNull();
    expect(container.querySelector(".attachment-preview-bar")?.classList.contains("visible")).toBe(
      false,
    );
    expect(textarea.hasAttribute("aria-describedby")).toBe(false);
    expect(document.activeElement).toBe(textarea);

    comp.destroy?.();
  });

  it("keeps the dismiss button, and its focus, when the shown reason changes", () => {
    const { comp } = mountInput(container);

    comp.setSendGate("Slow mode: wait 5s");
    (container.querySelector(".send-btn") as HTMLButtonElement).click();
    const dismiss = container.querySelector(
      ".attachment-upload-error-dismiss",
    ) as HTMLButtonElement;
    dismiss.focus();

    comp.setSendGate("Slow mode: wait 4s");

    expect(container.querySelector(".attachment-upload-error")?.textContent).toBe(
      "Slow mode: wait 4s",
    );
    expect(container.querySelector(".attachment-upload-error-dismiss")).toBe(dismiss);
    expect(document.activeElement).toBe(dismiss);

    comp.destroy?.();
  });

  it("accepts content of exactly 4000 code points", () => {
    const { opts, comp } = mountInput(container);

    const textarea = container.querySelector(".msg-textarea") as HTMLTextAreaElement;
    textarea.value = "a".repeat(4000);

    const sendBtn = container.querySelector(".send-btn") as HTMLButtonElement;
    sendBtn.click();

    expect(opts.onSend).toHaveBeenCalledTimes(1);

    comp.destroy?.();
  });

  it("counts astral characters as one code point, not two UTF-16 units", () => {
    // 2001 astral code points is 4002 UTF-16 units: the server's
    // utf8.RuneCountInString accepts it, a `.length` guard would wrongly refuse it.
    const { opts, comp } = mountInput(container);

    const textarea = container.querySelector(".msg-textarea") as HTMLTextAreaElement;
    textarea.value = "\u{1F600}".repeat(2001);

    const sendBtn = container.querySelector(".send-btn") as HTMLButtonElement;
    sendBtn.click();

    expect(opts.onSend).toHaveBeenCalledTimes(1);

    comp.destroy?.();
  });

  it("setReplyTo shows reply bar", () => {
    const { comp } = mountInput(container);

    comp.setReplyTo(42, "testuser");

    const replyBar = container.querySelector(".reply-bar") as HTMLDivElement;
    expect(replyBar.classList.contains("visible")).toBe(true);
    expect(replyBar.textContent).toContain("testuser");

    comp.destroy?.();
  });

  it("clearReply hides reply bar", () => {
    const { comp } = mountInput(container);

    comp.setReplyTo(42, "testuser");
    comp.clearReply();

    const replyBar = container.querySelector(".reply-bar") as HTMLDivElement;
    expect(replyBar.classList.contains("visible")).toBe(false);

    comp.destroy?.();
  });

  it("isIdle is true only with no text or reply", () => {
    const comp = createMessageInput(makeOptions());
    comp.mount(container);
    const textarea = container.querySelector(".msg-textarea") as HTMLTextAreaElement;
    expect(comp.isIdle()).toBe(true);

    textarea.value = "draft";
    expect(comp.isIdle()).toBe(false);
    textarea.value = "";

    comp.setReplyTo(42, "testuser");
    expect(comp.isIdle()).toBe(false);
    comp.clearReply();

    expect(comp.isIdle()).toBe(true);

    comp.destroy?.();
  });

  // ── P1-08: an edit keeps what you were typing ──

  it("typing emits onTyping (throttled)", () => {
    vi.useFakeTimers();
    const { opts, comp } = mountInput(container);

    const textarea = container.querySelector(".msg-textarea") as HTMLTextAreaElement;

    // First input should trigger onTyping
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    expect(opts.onTyping).toHaveBeenCalledTimes(1);

    // Immediate second input should NOT trigger (throttled at 3s)
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    expect(opts.onTyping).toHaveBeenCalledTimes(1);

    // After 3 seconds, should fire again
    vi.advanceTimersByTime(3000);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    expect(opts.onTyping).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
    comp.destroy?.();
  });

  it("attach button is disabled with tooltip", () => {
    const { comp } = mountInput(container);

    const attachBtn = container.querySelector(".attach-btn") as HTMLButtonElement;
    expect(attachBtn).not.toBeNull();
    expect(attachBtn.disabled).toBe(true);
    expect(attachBtn.title).toBe("File uploads not available");

    comp.destroy?.();
  });

  it("debounces rapid sends", () => {
    vi.useFakeTimers();
    const { opts, comp } = mountInput(container);

    const textarea = container.querySelector(".msg-textarea") as HTMLTextAreaElement;
    const sendBtn = container.querySelector(".send-btn") as HTMLButtonElement;

    textarea.value = "msg1";
    sendBtn.click();
    expect(opts.onSend).toHaveBeenCalledTimes(1);

    // Immediately try to send again (within 200ms debounce)
    textarea.value = "msg2";
    sendBtn.click();
    expect(opts.onSend).toHaveBeenCalledTimes(1); // still 1

    // After debounce period
    vi.advanceTimersByTime(200);
    textarea.value = "msg3";
    sendBtn.click();
    expect(opts.onSend).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
    comp.destroy?.();
  });

  it("sends an attachment-only message with no text", async () => {
    const uploadResult = { id: "srv-7", url: "http://server/pic.png", filename: "pic.png" };
    const onUploadFile = vi.fn(async () => uploadResult);
    const { opts, comp } = mountInput(container, { onUploadFile });

    const testFile = new File(["image data"], "pic.png", { type: "image/png" });
    selectFiles(container, [testFile]);
    await vi.waitFor(() => {
      expect(onUploadFile).toHaveBeenCalledWith(
        testFile,
        expect.any(AbortSignal),
        expect.any(Function),
      );
    });
    const previewBar = container.querySelector(".attachment-preview-bar");
    await vi.waitFor(() => {
      expect(previewBar!.querySelector(".uploading")).toBeNull();
    });

    const sendBtn = container.querySelector(".send-btn") as HTMLButtonElement;
    sendBtn.click();

    expect(opts.onSend).toHaveBeenCalledWith(
      "",
      null,
      ["srv-7"],
      [expect.objectContaining({ id: "srv-7" })],
      false,
    );

    comp.destroy?.();
  });

  // ── Reply context is included in send ──

  it("sending with reply includes replyTo messageId", () => {
    const { opts, comp } = mountInput(container);

    comp.setReplyTo(55, "replyuser");

    const textarea = container.querySelector(".msg-textarea") as HTMLTextAreaElement;
    textarea.value = "reply content";

    const sendBtn = container.querySelector(".send-btn") as HTMLButtonElement;
    sendBtn.click();

    expect(opts.onSend).toHaveBeenCalledWith("reply content", 55, [], [], true);

    // Reply bar should be hidden after send
    const replyBar = container.querySelector(".reply-bar") as HTMLDivElement;
    expect(replyBar.classList.contains("visible")).toBe(false);

    comp.destroy?.();
  });

  // ── Escape key behavior ──

  it("escape key clears reply when not in edit mode", () => {
    const { comp } = mountInput(container);

    comp.setReplyTo(44, "replyuser");

    const textarea = container.querySelector(".msg-textarea") as HTMLTextAreaElement;
    textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    const replyBar = container.querySelector(".reply-bar") as HTMLDivElement;
    expect(replyBar.classList.contains("visible")).toBe(false);

    comp.destroy?.();
  });

  it("an Escape that cancels a reply is used up; one with nothing to cancel is not", () => {
    const comp = createMessageInput(makeOptions());
    comp.mount(container);
    const textarea = container.querySelector(".msg-textarea") as HTMLTextAreaElement;
    const escape = (): KeyboardEvent => {
      const e = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
      textarea.dispatchEvent(e);
      return e;
    };

    comp.setReplyTo(44, "replyuser");
    expect(escape().defaultPrevented).toBe(true);
    // Nothing left to cancel: the app-wide Escape (mark read) may have it.
    expect(escape().defaultPrevented).toBe(false);

    comp.destroy?.();
  });

  it("an Escape that cancels an IME candidate keeps the reply", () => {
    const comp = createMessageInput(makeOptions());
    comp.mount(container);
    const textarea = container.querySelector(".msg-textarea") as HTMLTextAreaElement;
    const escape = (isComposing: boolean): KeyboardEvent => {
      const e = new KeyboardEvent("keydown", {
        key: "Escape",
        isComposing,
        bubbles: true,
        cancelable: true,
      });
      textarea.dispatchEvent(e);
      return e;
    };

    comp.setReplyTo(44, "replyuser");
    expect(escape(true).defaultPrevented).toBe(false);
    expect(container.querySelector(".reply-bar")?.classList.contains("visible")).toBe(true);
    expect(escape(false).defaultPrevented).toBe(true);

    comp.destroy?.();
  });

  // ── ArrowUp on empty textarea dispatches edit-last-message ──

  it("ArrowUp on empty textarea dispatches edit-last-message custom event", () => {
    const { comp } = mountInput(container);

    const textarea = container.querySelector(".msg-textarea") as HTMLTextAreaElement;
    textarea.value = "";

    const listener = vi.fn();
    container.addEventListener("edit-last-message", listener);

    textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));

    expect(listener).toHaveBeenCalledTimes(1);

    comp.destroy?.();
  });

  it("MessageInput has no edit mode: ArrowUp only dispatches edit-last-message", () => {
    const comp = createMessageInput(makeOptions());
    comp.mount(container);

    const textarea = container.querySelector(".msg-textarea") as HTMLTextAreaElement;
    const listener = vi.fn();
    container.addEventListener("edit-last-message", listener);

    const event = new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true });
    textarea.dispatchEvent(event);

    // The event is the whole hand-off: the caret move is cancelled, the
    // composer text is left alone, and there is no edit bar or edit API.
    expect(listener).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
    expect(textarea.value).toBe("");
    expect(container.querySelectorAll(".reply-bar").length).toBe(1);
    expect("startEdit" in comp).toBe(false);
    expect("cancelEdit" in comp).toBe(false);

    comp.destroy?.();
  });

  it("Shift+ArrowUp on an empty textarea does not open an edit", () => {
    const comp = createMessageInput(makeOptions());
    comp.mount(container);

    const textarea = container.querySelector(".msg-textarea") as HTMLTextAreaElement;
    const listener = vi.fn();
    container.addEventListener("edit-last-message", listener);

    textarea.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowUp", shiftKey: true, bubbles: true }),
    );

    expect(listener).not.toHaveBeenCalled();

    comp.destroy?.();
  });

  it("ArrowUp with content in textarea does NOT dispatch edit-last-message", () => {
    const { comp } = mountInput(container);

    const textarea = container.querySelector(".msg-textarea") as HTMLTextAreaElement;
    textarea.value = "some text";

    const listener = vi.fn();
    container.addEventListener("edit-last-message", listener);

    textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));

    expect(listener).not.toHaveBeenCalled();

    comp.destroy?.();
  });

  // ── UX-1: per-channel drafts and focus retention ──

  describe("draft capture and restore", () => {
    it("captures the typed text, reply target and settled attachment ids", async () => {
      const onUploadFile = vi.fn(async () => ({ id: "srv-1", url: "/f/1", filename: "a.png" }));
      const comp = createMessageInput(makeOptions({ onUploadFile }));
      comp.mount(container);

      const textarea = container.querySelector(".msg-textarea") as HTMLTextAreaElement;
      textarea.value = "half-written";
      comp.setReplyTo(7, "alice");
      const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
      Object.defineProperty(fileInput, "files", {
        value: [new File(["x"], "a.png", { type: "image/png" })],
        writable: true,
      });
      fileInput.dispatchEvent(new Event("change", { bubbles: true }));
      await vi.waitFor(() => expect(onUploadFile).toHaveBeenCalled());

      const draft = comp.getDraft();
      expect(draft.content).toBe("half-written");
      expect(draft.replyTo).toEqual({ messageId: 7, username: "alice" });
      expect(draft.attachments).toEqual([
        { id: "srv-1", filename: "a.png", uploadedAt: expect.any(Number), file: expect.any(File) },
      ]);
      comp.destroy?.();
    });

    it("drops restored attachments past the server's unlinked-upload sweep, with one notice", () => {
      const { opts, comp } = mountInput(container);
      const now = Date.now();

      comp.restoreDraft({
        content: "with files",
        replyTo: null,
        attachments: [
          { id: "old-1", filename: "old1.pdf", uploadedAt: now - 51 * 60 * 1000 },
          { id: "old-2", filename: "old2.pdf", uploadedAt: now - 2 * 60 * 60 * 1000 },
          { id: "fresh", filename: "fresh.pdf", uploadedAt: now - 10 * 60 * 1000 },
        ],
      });

      const chips = container.querySelectorAll(".attachment-preview-item");
      expect(chips.length).toBe(1);
      expect(chips[0]!.textContent).toContain("fresh.pdf");
      const notices = container.querySelectorAll(".attachment-upload-error");
      expect(notices.length).toBe(1);
      expect(notices[0]!.textContent).toMatch(/expired/i);

      (container.querySelector(".send-btn") as HTMLButtonElement).click();
      expect(opts.onSend).toHaveBeenCalledWith(
        "with files",
        null,
        ["fresh"],
        [expect.objectContaining({ id: "fresh" })],
        false,
      );
      comp.destroy?.();
    });

    it("restores text, reply bar and attachment chips into a fresh composer", () => {
      const comp = createMessageInput(makeOptions());
      comp.mount(container);

      comp.restoreDraft({
        content: "draft text",
        replyTo: { messageId: 9, username: "bob" },
        attachments: [{ id: "srv-9", filename: "doc.pdf", uploadedAt: Date.now() }],
      });

      const textarea = container.querySelector(".msg-textarea") as HTMLTextAreaElement;
      expect(textarea.value).toBe("draft text");
      const replyBars = container.querySelectorAll(".reply-bar");
      expect(replyBars[0]!.classList.contains("visible")).toBe(true);
      expect(replyBars[0]!.textContent).toContain("bob");
      expect(container.querySelectorAll(".attachment-preview-item").length).toBe(1);
      // The restored chip is already uploaded: no spinner, and it rides send.
      expect(
        container.querySelector(".attachment-preview-item")!.classList.contains("uploading"),
      ).toBe(false);
      comp.destroy?.();
    });

    it("restores a draft with no reply or attachments", () => {
      const comp = createMessageInput(makeOptions());
      comp.mount(container);

      comp.restoreDraft({ content: "just text", replyTo: null, attachments: [] });

      expect((container.querySelector(".msg-textarea") as HTMLTextAreaElement).value).toBe(
        "just text",
      );
      expect(container.querySelectorAll(".attachment-preview-item").length).toBe(0);
      comp.destroy?.();
    });
  });

  describe("focus retention while gated", () => {
    it("keeps the caret and focus when the composer is disabled", () => {
      const comp = createMessageInput(makeOptions());
      comp.mount(container);
      const textarea = container.querySelector(".msg-textarea") as HTMLTextAreaElement;
      textarea.focus();
      expect(document.activeElement).toBe(textarea);
      textarea.value = "mid-sentence";

      comp.setDisabled("Reconnecting…");

      // Focus must survive: a `disabled` textarea drops it to <body> and loses
      // the caret mid-sentence.
      expect(document.activeElement).toBe(textarea);
      expect(textarea.value).toBe("mid-sentence");
      expect(textarea.getAttribute("aria-disabled")).toBe("true");
      expect(textarea.readOnly).toBe(true);
      comp.destroy?.();
    });

    it("refuses Send with the reason while gated, then sends once re-enabled", () => {
      const { opts, comp } = mountInput(container);
      const textarea = container.querySelector(".msg-textarea") as HTMLTextAreaElement;
      textarea.value = "queued";

      comp.setDisabled("Reconnecting…");
      (container.querySelector(".send-btn") as HTMLButtonElement).click();
      expect(opts.onSend).not.toHaveBeenCalled();

      comp.setDisabled(null);
      (container.querySelector(".send-btn") as HTMLButtonElement).click();
      expect(opts.onSend).toHaveBeenCalledWith("queued", null, [], [], false);
      comp.destroy?.();
    });

    it("keeps the refusal line in sync as the slow-mode countdown ticks", () => {
      const { opts, comp } = mountInput(container);
      const textarea = container.querySelector(".msg-textarea") as HTMLTextAreaElement;
      textarea.value = "next message";
      comp.setDisabled("Slow mode — 5s");
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

      comp.setDisabled("Slow mode — 4s");

      const reason = container.querySelector(".attachment-upload-error") as HTMLElement | null;
      expect(reason).not.toBeNull();
      expect(reason!.textContent).toBe("Slow mode — 4s");
      expect(textarea.getAttribute("aria-describedby")).toBe(reason!.id);
      expect(opts.onSend).not.toHaveBeenCalled();
      comp.destroy?.();
    });

    it("shows a slow-mode note under the composer and hides it again, never gating Send", () => {
      const { opts, comp } = mountInput(container);
      const note = (): HTMLElement | null =>
        container.querySelector<HTMLElement>("[data-testid='slow-mode-note']");
      expect(note()?.hidden).toBe(true);

      comp.setSlowModeNote("Slow mode is on: one message every 5s");
      expect(note()?.hidden).toBe(false);
      expect(note()?.textContent).toBe("Slow mode is on: one message every 5s");

      // The note is information only: the first send still goes.
      const textarea = container.querySelector(".msg-textarea") as HTMLTextAreaElement;
      textarea.value = "first message";
      (container.querySelector(".send-btn") as HTMLButtonElement).click();
      expect(opts.onSend).toHaveBeenCalledWith("first message", null, [], [], false);

      comp.setSlowModeNote(null);
      expect(note()?.hidden).toBe(true);
      expect(note()?.textContent).toBe("");
      comp.destroy?.();
    });

    it("keeps a slow-mode note set before mount", () => {
      const comp = createMessageInput(makeOptions());
      comp.setSlowModeNote("Slow mode is on: one message every 9s");
      comp.mount(container);
      expect(container.querySelector("[data-testid='slow-mode-note']")?.textContent).toBe(
        "Slow mode is on: one message every 9s",
      );
      comp.destroy?.();
    });

    it("keeps the composer editable under a send gate, only refusing Send (#12)", () => {
      const { opts, comp } = mountInput(container);
      const textarea = container.querySelector(".msg-textarea") as HTMLTextAreaElement;
      textarea.focus();
      textarea.value = "typing through the cooldown";

      comp.setSendGate("Slow mode — 5s");

      // The composer is NOT frozen: it stays editable and focused, unlike
      // setDisabled.
      expect(textarea.readOnly).toBe(false);
      expect(textarea.getAttribute("aria-disabled")).toBe("false");
      expect(document.activeElement).toBe(textarea);
      expect(
        (container.querySelector(".send-btn") as HTMLButtonElement).classList.contains(
          "send-gated",
        ),
      ).toBe(true);

      // Send is refused with the reason shown.
      (container.querySelector(".send-btn") as HTMLButtonElement).click();
      expect(opts.onSend).not.toHaveBeenCalled();
      expect(container.querySelector(".attachment-upload-error")!.textContent).toBe(
        "Slow mode — 5s",
      );

      // Lifting the gate allows the send.
      comp.setSendGate(null);
      (container.querySelector(".send-btn") as HTMLButtonElement).click();
      expect(opts.onSend).toHaveBeenCalledWith("typing through the cooldown", null, [], [], false);
      comp.destroy?.();
    });

    it("keeps the send-gate refusal line in step with the countdown and clears it at the end", () => {
      const { comp } = mountInput(container);
      const textarea = container.querySelector(".msg-textarea") as HTMLTextAreaElement;
      textarea.value = "next message";
      comp.setSendGate("Slow mode — 7s");
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      expect(container.querySelector(".attachment-upload-error")!.textContent).toBe(
        "Slow mode — 7s",
      );

      comp.setSendGate("Slow mode — 6s");
      expect(container.querySelector(".attachment-upload-error")!.textContent).toBe(
        "Slow mode — 6s",
      );

      comp.setSendGate(null);
      expect(container.querySelector(".attachment-upload-error")).toBeNull();
      expect(textarea.value).toBe("next message");
      comp.destroy?.();
    });

    it("shows the reason when Enter is pressed mid-sentence during reconnect", () => {
      const { opts, comp } = mountInput(container);
      const textarea = container.querySelector(".msg-textarea") as HTMLTextAreaElement;
      textarea.value = "mid-sentence";
      comp.setDisabled("Reconnecting…");

      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

      expect(opts.onSend).not.toHaveBeenCalled();
      const reason = container.querySelector(".attachment-upload-error") as HTMLElement;
      expect(reason.textContent).toBe("Reconnecting…");
      expect(reason.closest(".attachment-preview-bar")!.classList.contains("visible")).toBe(true);
      expect(textarea.getAttribute("aria-describedby")).toBe(reason.id);
      expect(textarea.value).toBe("mid-sentence");

      // Reconnected: the stale reason goes away and Enter sends.
      comp.setDisabled(null);
      expect(container.querySelector(".attachment-upload-error")).toBeNull();
      expect(textarea.hasAttribute("aria-describedby")).toBe(false);
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      expect(opts.onSend).toHaveBeenCalledWith("mid-sentence", null, [], [], false);
      comp.destroy?.();
    });

    it("refuses a pasted file while gated", async () => {
      const onUploadFile = vi.fn(async () => ({ id: "p1", url: "http://x", filename: "p.png" }));
      const comp = createMessageInput(makeOptions({ onUploadFile }));
      comp.mount(container);
      comp.setDisabled("Not connected");
      const textarea = container.querySelector(".msg-textarea") as HTMLTextAreaElement;
      const pasteEvent = new Event("paste", { bubbles: true });
      Object.defineProperty(pasteEvent, "clipboardData", {
        value: {
          items: [
            {
              kind: "file",
              type: "image/png",
              getAsFile: () => new File(["img"], "p.png", { type: "image/png" }),
            },
          ],
        },
      });

      textarea.dispatchEvent(pasteEvent);
      await Promise.resolve();

      expect(onUploadFile).not.toHaveBeenCalled();
      expect(container.querySelectorAll(".attachment-preview-item").length).toBe(0);
      comp.destroy?.();
    });

    it("does not ask for an edit on ArrowUp while gated", () => {
      const comp = createMessageInput(makeOptions());
      comp.mount(container);
      comp.setDisabled("Slow mode — 5s");
      const listener = vi.fn();
      container.addEventListener("edit-last-message", listener);
      const textarea = container.querySelector(".msg-textarea") as HTMLTextAreaElement;

      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));

      expect(listener).not.toHaveBeenCalled();
      comp.destroy?.();
    });
  });

  // ── File attachment via onUploadFile ──

  it("attach button is enabled when onUploadFile is provided", () => {
    const { comp } = mountInput(container, {
      onUploadFile: vi.fn(async () => ({ id: "a1", url: "http://x.png", filename: "x.png" })),
    });

    const attachBtn = container.querySelector(".attach-btn") as HTMLButtonElement;
    expect(attachBtn.disabled).toBe(false);

    comp.destroy?.();
  });

  it("file picker does not restrict file types (the server decides)", () => {
    const { comp } = mountInput(container, {
      onUploadFile: vi.fn(async () => ({ id: "a1", url: "http://x.png", filename: "x.png" })),
    });

    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    expect(fileInput.accept).toBe("");

    comp.destroy?.();
  });
});
