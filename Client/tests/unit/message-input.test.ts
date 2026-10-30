import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/** Captured emoji picker callbacks so tests can simulate selection. */
let lastEmojiPickerOptions: {
  onSelect: (emoji: string, select?: { keepOpen: boolean }) => void;
  onClose: () => void;
} | null = null;

vi.mock("@components/EmojiPicker", () => ({
  createEmojiPicker: (opts: NonNullable<typeof lastEmojiPickerOptions>) => {
    lastEmojiPickerOptions = opts;
    const element = document.createElement("div");
    element.classList.add("emoji-picker");
    return { element, destroy: vi.fn() };
  },
}));

/** Captured GIF picker callbacks so tests can simulate selection. */
type CapturedGifPickerOptions = {
  onSelect: (url: string) => void;
  onClose: () => void;
  onUnavailable?: (reason: string) => void;
};
let lastGifPickerOptions: CapturedGifPickerOptions | null = null;

vi.mock("@components/GifPicker", () => ({
  createGifPicker: (opts: CapturedGifPickerOptions) => {
    lastGifPickerOptions = opts;
    const element = document.createElement("div");
    element.classList.add("gif-picker");
    return { element, destroy: vi.fn() };
  },
}));

import {
  createMessageInput,
  wrapWithMarker,
  type MessageInputOptions,
} from "@components/MessageInput";
import type { GifApi, GifFavoritesApi } from "@lib/media/gifProvider";
import { authStore } from "@stores/auth.store";
import { canMention, mentionInComposer } from "../../src/features/messaging/activeComposer";

/** GIF endpoints on the user's own server (never api.klipy.com). */
const stubGifApi: GifApi & GifFavoritesApi = {
  gifSearch: vi.fn(async () => ({ results: [] })),
  gifTrending: vi.fn(async () => ({ results: [] })),
  gifFavorites: vi.fn(async () => ({ favorites: [] })),
  addGifFavorite: vi.fn(async () => undefined),
  removeGifFavorite: vi.fn(async () => undefined),
};

function makeOptions(overrides: Partial<MessageInputOptions> = {}): MessageInputOptions {
  return {
    channelId: 1,
    channelName: "general",
    gifApi: stubGifApi,
    onSend: vi.fn(),
    onTyping: vi.fn(),
    ...overrides,
  };
}

describe("MessageInput", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    lastEmojiPickerOptions = null;
    lastGifPickerOptions = null;
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("mounts with message-input-wrap class", () => {
    const opts = makeOptions();
    const comp = createMessageInput(opts);
    comp.mount(container);

    expect(container.querySelector(".message-input-wrap")).not.toBeNull();

    comp.destroy?.();
  });

  it("has textarea with correct placeholder", () => {
    const opts = makeOptions({ channelName: "random" });
    const comp = createMessageInput(opts);
    comp.mount(container);

    const textarea = container.querySelector(".msg-textarea") as HTMLTextAreaElement;
    expect(textarea).not.toBeNull();
    expect(textarea.placeholder).toBe("Message #random");

    comp.destroy?.();
  });

  it("send button click calls onSend with textarea content", () => {
    const opts = makeOptions();
    const comp = createMessageInput(opts);
    comp.mount(container);

    const textarea = container.querySelector(".msg-textarea") as HTMLTextAreaElement;
    textarea.value = "Hello world";

    const sendBtn = container.querySelector(".send-btn") as HTMLButtonElement;
    sendBtn.click();

    expect(opts.onSend).toHaveBeenCalledWith("Hello world", null, [], [], false);

    comp.destroy?.();
  });

  it("enter key sends message", () => {
    const opts = makeOptions();
    const comp = createMessageInput(opts);
    comp.mount(container);

    const textarea = container.querySelector(".msg-textarea") as HTMLTextAreaElement;
    textarea.value = "Enter message";

    textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    expect(opts.onSend).toHaveBeenCalledWith("Enter message", null, [], [], false);

    comp.destroy?.();
  });

  it("Enter during an IME composition does not send the half-composed text (F3)", () => {
    // CJK IMEs commit a candidate on Enter, firing keydown with isComposing
    // true. Sending there would ship the raw kana/composition string.
    const opts = makeOptions();
    const comp = createMessageInput(opts);
    comp.mount(container);

    const textarea = container.querySelector(".msg-textarea") as HTMLTextAreaElement;
    textarea.value = "\u3042"; // composing kana

    textarea.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true }),
    );

    expect(opts.onSend).not.toHaveBeenCalled();

    comp.destroy?.();
  });

  it("shift+enter does NOT send (just newlines)", () => {
    const opts = makeOptions();
    const comp = createMessageInput(opts);
    comp.mount(container);

    const textarea = container.querySelector(".msg-textarea") as HTMLTextAreaElement;
    textarea.value = "Line 1";

    textarea.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true }),
    );

    expect(opts.onSend).not.toHaveBeenCalled();

    comp.destroy?.();
  });

  it("empty textarea does not send", () => {
    const opts = makeOptions();
    const comp = createMessageInput(opts);
    comp.mount(container);

    const textarea = container.querySelector(".msg-textarea") as HTMLTextAreaElement;
    textarea.value = "";

    const sendBtn = container.querySelector(".send-btn") as HTMLButtonElement;
    sendBtn.click();

    expect(opts.onSend).not.toHaveBeenCalled();

    comp.destroy?.();
  });

  it("refuses a send past the server's 4000 code point limit", () => {
    const opts = makeOptions();
    const comp = createMessageInput(opts);
    comp.mount(container);

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
    const opts = makeOptions();
    const comp = createMessageInput(opts);
    comp.mount(container);

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
    const opts = makeOptions();
    const comp = createMessageInput(opts);
    comp.mount(container);

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
    const opts = makeOptions();
    const comp = createMessageInput(opts);
    comp.mount(container);

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
    const opts = makeOptions();
    const comp = createMessageInput(opts);
    comp.mount(container);

    const textarea = container.querySelector(".msg-textarea") as HTMLTextAreaElement;
    textarea.value = "\u{1F600}".repeat(2001);

    const sendBtn = container.querySelector(".send-btn") as HTMLButtonElement;
    sendBtn.click();

    expect(opts.onSend).toHaveBeenCalledTimes(1);

    comp.destroy?.();
  });

  it("setReplyTo shows reply bar", () => {
    const opts = makeOptions();
    const comp = createMessageInput(opts);
    comp.mount(container);

    comp.setReplyTo(42, "testuser");

    const replyBar = container.querySelector(".reply-bar") as HTMLDivElement;
    expect(replyBar.classList.contains("visible")).toBe(true);
    expect(replyBar.textContent).toContain("testuser");

    comp.destroy?.();
  });

  it("clearReply hides reply bar", () => {
    const opts = makeOptions();
    const comp = createMessageInput(opts);
    comp.mount(container);

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
    const opts = makeOptions();
    const comp = createMessageInput(opts);
    comp.mount(container);

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
    const opts = makeOptions();
    const comp = createMessageInput(opts);
    comp.mount(container);

    const attachBtn = container.querySelector(".attach-btn") as HTMLButtonElement;
    expect(attachBtn).not.toBeNull();
    expect(attachBtn.disabled).toBe(true);
    expect(attachBtn.title).toBe("File uploads not available");

    comp.destroy?.();
  });

  it("debounces rapid sends", () => {
    vi.useFakeTimers();
    const opts = makeOptions();
    const comp = createMessageInput(opts);
    comp.mount(container);

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
    const opts = makeOptions({ onUploadFile });
    const comp = createMessageInput(opts);
    comp.mount(container);

    const testFile = new File(["image data"], "pic.png", { type: "image/png" });
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(fileInput, "files", { value: [testFile], writable: true });
    fileInput.dispatchEvent(new Event("change", { bubbles: true }));
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
    const opts = makeOptions();
    const comp = createMessageInput(opts);
    comp.mount(container);

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
    const opts = makeOptions();
    const comp = createMessageInput(opts);
    comp.mount(container);

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
    const opts = makeOptions();
    const comp = createMessageInput(opts);
    comp.mount(container);

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
    const opts = makeOptions();
    const comp = createMessageInput(opts);
    comp.mount(container);

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
      const opts = makeOptions();
      const comp = createMessageInput(opts);
      comp.mount(container);
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
      const opts = makeOptions();
      const comp = createMessageInput(opts);
      comp.mount(container);
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
      const opts = makeOptions();
      const comp = createMessageInput(opts);
      comp.mount(container);
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
      const opts = makeOptions();
      const comp = createMessageInput(opts);
      comp.mount(container);
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
      const opts = makeOptions();
      const comp = createMessageInput(opts);
      comp.mount(container);
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
      const opts = makeOptions();
      const comp = createMessageInput(opts);
      comp.mount(container);
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
      const opts = makeOptions();
      const comp = createMessageInput(opts);
      comp.mount(container);
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
    const opts = makeOptions({
      onUploadFile: vi.fn(async () => ({ id: "a1", url: "http://x.png", filename: "x.png" })),
    });
    const comp = createMessageInput(opts);
    comp.mount(container);

    const attachBtn = container.querySelector(".attach-btn") as HTMLButtonElement;
    expect(attachBtn.disabled).toBe(false);

    comp.destroy?.();
  });

  it("file picker does not restrict file types (the server decides)", () => {
    const opts = makeOptions({
      onUploadFile: vi.fn(async () => ({ id: "a1", url: "http://x.png", filename: "x.png" })),
    });
    const comp = createMessageInput(opts);
    comp.mount(container);

    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    expect(fileInput.accept).toBe("");

    comp.destroy?.();
  });

  it("file upload shows preview and sends attachment ID with message", async () => {
    const uploadResult = { id: "srv-123", url: "http://server/file.png", filename: "file.png" };
    const onUploadFile = vi.fn(async () => uploadResult);
    const opts = makeOptions({ onUploadFile });
    const comp = createMessageInput(opts);
    comp.mount(container);

    // Simulate file selection via the hidden input
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    expect(fileInput).not.toBeNull();

    const testFile = new File(["image data"], "test.png", { type: "image/png" });
    Object.defineProperty(fileInput, "files", { value: [testFile], writable: true });
    fileInput.dispatchEvent(new Event("change", { bubbles: true }));

    // Wait for the async upload to complete
    await vi.waitFor(() => {
      expect(onUploadFile).toHaveBeenCalledWith(
        testFile,
        expect.any(AbortSignal),
        expect.any(Function),
      );
    });

    // Preview bar should be visible
    const previewBar = container.querySelector(".attachment-preview-bar");
    expect(previewBar!.classList.contains("visible")).toBe(true);

    // Now send a message -- should include the attachment ID
    const textarea = container.querySelector(".msg-textarea") as HTMLTextAreaElement;
    textarea.value = "with attachment";
    const sendBtn = container.querySelector(".send-btn") as HTMLButtonElement;
    sendBtn.click();

    expect(opts.onSend).toHaveBeenCalledWith(
      "with attachment",
      null,
      ["srv-123"],
      [expect.objectContaining({ id: "srv-123" })],
      false,
    );

    comp.destroy?.();
  });

  it("rejects file exceeding 100 MB size limit", async () => {
    const onUploadFile = vi.fn(async () => ({ id: "x", url: "x", filename: "x" }));
    const opts = makeOptions({ onUploadFile });
    const comp = createMessageInput(opts);
    comp.mount(container);

    // Create a file > 100MB
    const bigFile = new File(["x"], "huge.bin", { type: "application/octet-stream" });
    Object.defineProperty(bigFile, "size", { value: 101 * 1024 * 1024 });

    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(fileInput, "files", { value: [bigFile], writable: true });
    fileInput.dispatchEvent(new Event("change", { bubbles: true }));

    // Give async handlers a tick
    await new Promise((r) => setTimeout(r, 10));

    // Upload should NOT have been called
    expect(onUploadFile).not.toHaveBeenCalled();

    // Error message should be displayed
    const error = container.querySelector(".attachment-upload-error");
    expect(error).not.toBeNull();
    expect(error!.textContent).toContain("too large");

    comp.destroy?.();
  });

  it("upload error makes the (initially hidden) preview bar visible", async () => {
    const onUploadFile = vi.fn(async () => ({ id: "x", url: "x", filename: "x" }));
    const opts = makeOptions({ onUploadFile });
    const comp = createMessageInput(opts);
    comp.mount(container);

    // Nothing queued yet, so the preview bar starts without the "visible"
    // class -- app.css only shows it via .visible.
    const previewBar = container.querySelector(".attachment-preview-bar");
    expect(previewBar!.classList.contains("visible")).toBe(false);

    const bigFile = new File(["x"], "huge.bin", { type: "application/octet-stream" });
    Object.defineProperty(bigFile, "size", { value: 101 * 1024 * 1024 });

    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(fileInput, "files", { value: [bigFile], writable: true });
    fileInput.dispatchEvent(new Event("change", { bubbles: true }));

    await new Promise((r) => setTimeout(r, 10));

    expect(container.querySelector(".attachment-upload-error")).not.toBeNull();
    expect(previewBar!.classList.contains("visible")).toBe(true);

    comp.destroy?.();
  });

  it("keeps the error until the user edits, then clears and hides the preview bar (A11Y-05)", async () => {
    vi.useFakeTimers();
    const onUploadFile = vi.fn(async () => ({ id: "x", url: "x", filename: "x" }));
    const opts = makeOptions({ onUploadFile });
    const comp = createMessageInput(opts);
    comp.mount(container);

    const bigFile = new File(["x"], "huge.bin", { type: "application/octet-stream" });
    Object.defineProperty(bigFile, "size", { value: 101 * 1024 * 1024 });
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(fileInput, "files", { value: [bigFile], writable: true });
    fileInput.dispatchEvent(new Event("change", { bubbles: true }));

    await vi.advanceTimersByTimeAsync(10);
    const previewBar = container.querySelector(".attachment-preview-bar");
    expect(previewBar!.classList.contains("visible")).toBe(true);

    // A refusal is not a 4s toast: it survives well past the old window so
    // the user can read it.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(container.querySelector(".attachment-upload-error")).not.toBeNull();
    expect(previewBar!.classList.contains("visible")).toBe(true);

    // Editing the textarea is the user acting on it -- the line clears.
    const textarea = container.querySelector(".msg-textarea") as HTMLTextAreaElement;
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    expect(container.querySelector(".attachment-upload-error")).toBeNull();
    expect(previewBar!.classList.contains("visible")).toBe(false);

    vi.useRealTimers();
    comp.destroy?.();
  });

  it("refuses a file over the server's advertised limit before uploading, naming the limit", async () => {
    authStore.setState((s) => ({ ...s, uploadPolicy: { max_upload_bytes: 10 * 1024 * 1024 } }));
    try {
      const onUploadFile = vi.fn(async () => ({ id: "x", url: "x", filename: "x" }));
      const comp = createMessageInput(makeOptions({ onUploadFile }));
      comp.mount(container);

      const file = new File(["x"], "clip.mp4", { type: "video/mp4" });
      Object.defineProperty(file, "size", { value: 11 * 1024 * 1024 });
      const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
      Object.defineProperty(fileInput, "files", { value: [file], writable: true });
      fileInput.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 10));

      expect(onUploadFile).not.toHaveBeenCalled();
      const error = container.querySelector(".attachment-upload-error");
      expect(error!.textContent).toContain("clip.mp4 exceeds 10 MB limit");

      comp.destroy?.();
    } finally {
      authStore.setState((s) => ({ ...s, uploadPolicy: null }));
    }
  });

  describe("server file-type policy", () => {
    async function pick(name: string) {
      const onUploadFile = vi.fn(async () => ({ id: "x", url: "x", filename: name }));
      const comp = createMessageInput(makeOptions({ onUploadFile }));
      comp.mount(container);
      const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
      Object.defineProperty(fileInput, "files", {
        value: [new File(["x"], name, { type: "" })],
        writable: true,
      });
      fileInput.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 10));
      const error = container.querySelector(".attachment-upload-error")?.textContent ?? null;
      comp.destroy?.();
      return { onUploadFile, error };
    }

    afterEach(() => authStore.setState((s) => ({ ...s, uploadPolicy: null })));

    it("refuses a blocked final extension before uploading, however it is spelled", async () => {
      authStore.setState((s) => ({
        ...s,
        uploadPolicy: { max_upload_bytes: 10 * 1024 * 1024, blocked_extensions: ["bat", "ps1"] },
      }));
      for (const name of ["cleanup.BAT", "report.pdf.bat", "photo.jpg.ps1", "run.bat. "]) {
        const { onUploadFile, error } = await pick(name);
        expect(onUploadFile, name).not.toHaveBeenCalled();
        expect(error, name).toMatch(/this server doesn't allow \.(bat|ps1) files$/);
        expect(error, name).toContain(name);
      }
      for (const name of ["notes.txt", "invoice.ps1.txt", "www.amazon.bat.png"]) {
        expect((await pick(name)).onUploadFile, name).toHaveBeenCalled();
      }
    });

    it("in allow-only mode refuses anything not listed, including no extension", async () => {
      authStore.setState((s) => ({
        ...s,
        uploadPolicy: { max_upload_bytes: 10 * 1024 * 1024, allowed_extensions: ["png", "pdf"] },
      }));
      expect((await pick("clip.mp4")).error).toBe(
        "clip.mp4 can't be uploaded: this server doesn't allow .mp4 files",
      );
      expect((await pick("README")).error).toBe(
        "README can't be uploaded: this server only accepts certain file types",
      );
      expect((await pick("Photo.PNG")).onUploadFile).toHaveBeenCalled();
    });

    it("uploads any type when the server sends no lists (an older server)", async () => {
      authStore.setState((s) => ({ ...s, uploadPolicy: { max_upload_bytes: 10 * 1024 * 1024 } }));
      expect((await pick("cleanup.bat")).onUploadFile).toHaveBeenCalled();
    });
  });

  it("uploads a file above 100 MB when the server advertises a larger limit", async () => {
    authStore.setState((s) => ({ ...s, uploadPolicy: { max_upload_bytes: 150 * 1024 * 1024 } }));
    try {
      const onUploadFile = vi.fn(async () => ({ id: "x", url: "x", filename: "big.bin" }));
      const comp = createMessageInput(makeOptions({ onUploadFile }));
      comp.mount(container);

      const file = new File(["x"], "big.bin", { type: "application/octet-stream" });
      Object.defineProperty(file, "size", { value: 120 * 1024 * 1024 });
      const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
      Object.defineProperty(fileInput, "files", { value: [file], writable: true });
      fileInput.dispatchEvent(new Event("change", { bubbles: true }));

      await vi.waitFor(() => expect(onUploadFile).toHaveBeenCalled());
      comp.destroy?.();
    } finally {
      authStore.setState((s) => ({ ...s, uploadPolicy: null }));
    }
  });

  it("disables attaching when the server advertises uploads disabled (0), even after mount", async () => {
    const onUploadFile = vi.fn(async () => ({ id: "x", url: "x", filename: "p.png" }));
    const comp = createMessageInput(makeOptions({ onUploadFile }));
    comp.mount(container);
    const attachBtn = container.querySelector(".attach-btn") as HTMLButtonElement;
    expect(attachBtn.disabled).toBe(false);
    try {
      authStore.setState((s) => ({ ...s, uploadPolicy: { max_upload_bytes: 0 } }));
      authStore.flush();

      expect(attachBtn.disabled).toBe(true);
      expect(attachBtn.title).toBe("Uploads are disabled on this server");

      comp.openFilePicker();
      const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
      Object.defineProperty(fileInput, "files", {
        value: [new File(["x"], "a.bin", { type: "application/octet-stream" })],
        writable: true,
      });
      fileInput.dispatchEvent(new Event("change", { bubbles: true }));
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
      await new Promise((r) => setTimeout(r, 10));

      expect(onUploadFile).not.toHaveBeenCalled();
      expect(container.querySelectorAll(".attachment-preview-item").length).toBe(0);
      expect(container.querySelector(".attachment-upload-error")!.textContent).toBe(
        "Uploads are disabled on this server",
      );

      // A later auth_ok that re-enables uploads re-enables the control.
      authStore.setState((s) => ({ ...s, uploadPolicy: { max_upload_bytes: 10 * 1024 * 1024 } }));
      authStore.flush();
      expect(attachBtn.disabled).toBe(false);
      expect(attachBtn.title).toBe("");
    } finally {
      authStore.setState((s) => ({ ...s, uploadPolicy: null }));
      comp.destroy?.();
    }
  });

  it("keeps the attach button disabled while gated even if uploads are enabled", () => {
    const comp = createMessageInput(
      makeOptions({ onUploadFile: vi.fn(async () => ({ id: "x", url: "x", filename: "x" })) }),
    );
    comp.mount(container);
    comp.setDisabled("Not connected");
    const attachBtn = container.querySelector(".attach-btn") as HTMLButtonElement;
    expect(attachBtn.disabled).toBe(true);
    comp.setDisabled(null);
    expect(attachBtn.disabled).toBe(false);
    comp.destroy?.();
  });

  // D1 (a): any type the server accepts can be attached; the server stays
  // authoritative and refuses its own blocked types.
  it("uploads a file of a type outside the old allowlist", async () => {
    const onUploadFile = vi.fn(async () => ({ id: "x", url: "x", filename: "a.7z" }));
    const comp = createMessageInput(makeOptions({ onUploadFile }));
    comp.mount(container);

    const file = new File(["7z"], "a.7z", { type: "application/x-7z-compressed" });
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(fileInput, "files", { value: [file], writable: true });
    fileInput.dispatchEvent(new Event("change", { bubbles: true }));

    await vi.waitFor(() => expect(onUploadFile).toHaveBeenCalled());
    expect(container.querySelector(".attachment-upload-error")).toBeNull();
    comp.destroy?.();
  });

  // SRV-05 (client): removing an in-flight attachment must abort its upload
  // and free Send immediately, instead of leaving a doomed request running
  // and the composer blocked on it.
  it("aborts an in-flight upload when its preview is removed", async () => {
    let capturedSignal: AbortSignal | undefined;
    const onUploadFile = vi.fn(
      (_file: File, signal?: AbortSignal) =>
        new Promise<{ id: string; url: string; filename: string }>((_resolve, reject) => {
          capturedSignal = signal;
          signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );
    const opts = makeOptions({ onUploadFile });
    const comp = createMessageInput(opts);
    comp.mount(container);

    const file = new File(["data"], "big.pdf", { type: "application/pdf" });
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(fileInput, "files", { value: [file], writable: true });
    fileInput.dispatchEvent(new Event("change", { bubbles: true }));

    await vi.waitFor(() => expect(onUploadFile).toHaveBeenCalledOnce());
    expect(capturedSignal).toBeDefined();
    expect(capturedSignal!.aborted).toBe(false);

    (container.querySelector("[data-testid='attachment-remove']") as HTMLButtonElement).click();

    // The request is cancelled and its preview is gone.
    expect(capturedSignal!.aborted).toBe(true);
    expect(container.querySelector(".attachment-preview-item")).toBeNull();

    // Send must be free immediately: an empty-edit send is refused for being
    // empty, not for uploads still pending.
    const textarea = container.querySelector(".msg-textarea") as HTMLTextAreaElement;
    textarea.value = "hello";
    (container.querySelector(".send-btn") as HTMLButtonElement).click();
    expect(opts.onSend).toHaveBeenCalledWith("hello", null, [], [], false);

    comp.destroy?.();
  });

  it("removing a finished upload leaves only the in-flight one in the queued send", async () => {
    const onUploadFile = vi
      .fn<
        (file: File, signal?: AbortSignal) => Promise<{ id: string; url: string; filename: string }>
      >()
      .mockResolvedValueOnce({ id: "srv-a", url: "/a", filename: "a.pdf" })
      .mockImplementationOnce(() => new Promise(() => {}));
    const opts = makeOptions({ onUploadFile });
    const comp = createMessageInput(opts);
    comp.mount(container);
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    const attach = (name: string): void => {
      Object.defineProperty(fileInput, "files", {
        value: [new File(["data"], name, { type: "application/pdf" })],
        configurable: true,
      });
      fileInput.dispatchEvent(new Event("change", { bubbles: true }));
    };

    attach("a.pdf");
    await vi.waitFor(() =>
      expect(container.querySelector(".attachment-preview-item.uploading")).toBeNull(),
    );
    (container.querySelector("[data-testid='attachment-remove']") as HTMLButtonElement).click();

    attach("b.pdf");
    await vi.waitFor(() => expect(onUploadFile).toHaveBeenCalledTimes(2));

    const textarea = container.querySelector(".msg-textarea") as HTMLTextAreaElement;
    textarea.value = "hello";
    (container.querySelector(".send-btn") as HTMLButtonElement).click();
    // 3A-9: the removed upload's id is never sent; only b.pdf is queued.
    expect(opts.onSend).toHaveBeenCalledOnce();
    const call = vi.mocked(opts.onSend).mock.calls[0]!;
    expect(call.slice(0, 5)).toEqual(["hello", null, [], [], false]);
    expect(call[5]).toEqual([
      {
        filename: "b.pdf",
        file: expect.any(File),
        upload: expect.objectContaining({ filename: "b.pdf" }),
      },
    ]);
    expect(container.querySelector(".attachment-preview-item")).toBeNull();

    comp.destroy?.();
  });

  it("shows no error when an upload is aborted by the user", async () => {
    const onUploadFile = vi.fn(
      (_file: File, signal?: AbortSignal) =>
        new Promise<{ id: string; url: string; filename: string }>((_resolve, reject) => {
          signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );
    const opts = makeOptions({ onUploadFile });
    const comp = createMessageInput(opts);
    comp.mount(container);

    const file = new File(["data"], "big.pdf", { type: "application/pdf" });
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(fileInput, "files", { value: [file], writable: true });
    fileInput.dispatchEvent(new Event("change", { bubbles: true }));

    await vi.waitFor(() => expect(onUploadFile).toHaveBeenCalledOnce());
    (container.querySelector("[data-testid='attachment-remove']") as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 10));

    // A deliberate cancel is not a failure: no refusal line.
    expect(container.querySelector(".attachment-upload-error")).toBeNull();

    comp.destroy?.();
  });

  it("shows upload error when onUploadFile rejects", async () => {
    const onUploadFile = vi.fn(async () => {
      throw new Error("Server exploded");
    });
    const opts = makeOptions({ onUploadFile });
    const comp = createMessageInput(opts);
    comp.mount(container);

    const file = new File(["data"], "doc.pdf", { type: "application/pdf" });
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(fileInput, "files", { value: [file], writable: true });
    fileInput.dispatchEvent(new Event("change", { bubbles: true }));

    // Wait for the async rejection
    await vi.waitFor(() => {
      const error = container.querySelector(".attachment-upload-error");
      expect(error).not.toBeNull();
      expect(error!.textContent).toContain("Server exploded");
    });

    comp.destroy?.();
  });

  it("queues the send while uploads are still in flight", async () => {
    // Create an upload that stays pending until the test resolves it
    let resolveUpload: ((v: { id: string; url: string; filename: string }) => void) | null = null;
    const onUploadFile = vi.fn(
      () =>
        new Promise<{ id: string; url: string; filename: string }>((res) => {
          resolveUpload = res;
        }),
    );
    const opts = makeOptions({ onUploadFile });
    const comp = createMessageInput(opts);
    comp.mount(container);

    const file = new File(["data"], "doc.txt", { type: "text/plain" });
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(fileInput, "files", { value: [file], writable: true });
    fileInput.dispatchEvent(new Event("change", { bubbles: true }));

    // The upload is in flight but not resolved
    const textarea = container.querySelector(".msg-textarea") as HTMLTextAreaElement;
    textarea.value = "trying to send";
    const sendBtn = container.querySelector(".send-btn") as HTMLButtonElement;
    sendBtn.click();

    // 3A-9: the send goes to the host as a queued one, the composer is empty
    // at once, and nothing is refused.
    expect(opts.onSend).toHaveBeenCalledOnce();
    const call = vi.mocked(opts.onSend).mock.calls[0]!;
    expect(call.slice(0, 5)).toEqual(["trying to send", null, [], [], false]);
    expect(call[5]).toEqual([
      { filename: "doc.txt", file, upload: expect.objectContaining({ filename: "doc.txt" }) },
    ]);
    expect(textarea.value).toBe("");
    expect(container.querySelector(".attachment-preview-item")).toBeNull();
    expect(container.querySelector(".attachment-upload-error")?.textContent ?? "").toBe("");

    // Once the upload resolves the composer sends nothing more and shows no error.
    resolveUpload!({ id: "done", url: "http://x", filename: "doc.txt" });
    await new Promise((r) => setTimeout(r, 10));
    expect(opts.onSend).toHaveBeenCalledOnce();
    expect(container.querySelector(".attachment-upload-error")?.textContent ?? "").toBe("");

    comp.destroy?.();
  });

  it("remove button removes attachment preview while upload is pending", async () => {
    // Use a long-running upload so we can click remove while it's still pending
    let resolveUpload: ((v: { id: string; url: string; filename: string }) => void) | null = null;
    const onUploadFile = vi.fn(
      () =>
        new Promise<{ id: string; url: string; filename: string }>((res) => {
          resolveUpload = res;
        }),
    );
    const opts = makeOptions({ onUploadFile });
    const comp = createMessageInput(opts);
    comp.mount(container);

    const file = new File(["text"], "file.txt", { type: "text/plain" });
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(fileInput, "files", { value: [file], writable: true });
    fileInput.dispatchEvent(new Event("change", { bubbles: true }));

    // Wait for the preview to appear (upload started but not resolved)
    await vi.waitFor(() => {
      expect(onUploadFile).toHaveBeenCalled();
    });

    // Preview bar should be visible with the uploading item
    const previewBar = container.querySelector(".attachment-preview-bar");
    expect(previewBar!.classList.contains("visible")).toBe(true);

    // Remove the attachment while upload is still pending (tempId still matches)
    const removeBtn = container.querySelector('[data-testid="attachment-remove"]') as HTMLElement;
    expect(removeBtn).not.toBeNull();
    removeBtn.click();

    // Preview bar should lose visible class (all attachments removed from list)
    expect(previewBar!.classList.contains("visible")).toBe(false);

    // The preview item DOM element should be removed from the bar
    expect(previewBar!.querySelector(".attachment-preview-item")).toBeNull();

    // Clean up the pending promise
    resolveUpload!({ id: "done", url: "http://x", filename: "file.txt" });
    await new Promise((r) => setTimeout(r, 10));

    comp.destroy?.();
  });

  it("remove button removes attachment preview after the upload has completed", async () => {
    const uploadResult = { id: "srv-123", url: "http://server/file.png", filename: "file.png" };
    const onUploadFile = vi.fn(async () => uploadResult);
    const opts = makeOptions({ onUploadFile });
    const comp = createMessageInput(opts);
    comp.mount(container);

    const testFile = new File(["image data"], "test.png", { type: "image/png" });
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(fileInput, "files", { value: [testFile], writable: true });
    fileInput.dispatchEvent(new Event("change", { bubbles: true }));

    // Wait for the upload to resolve — the entry's id is now the server id,
    // not the tempId the remove button was created with.
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

    const removeBtn = container.querySelector('[data-testid="attachment-remove"]') as HTMLElement;
    expect(removeBtn).not.toBeNull();
    removeBtn.click();

    expect(previewBar!.classList.contains("visible")).toBe(false);
    expect(previewBar!.querySelector(".attachment-preview-item")).toBeNull();

    // Sending now must not include the removed attachment.
    const textarea = container.querySelector(".msg-textarea") as HTMLTextAreaElement;
    textarea.value = "no attachment";
    const sendBtn = container.querySelector(".send-btn") as HTMLButtonElement;
    sendBtn.click();
    expect(opts.onSend).toHaveBeenCalledWith("no attachment", null, [], [], false);

    comp.destroy?.();
  });

  // ── Reply close button ──

  it("clicking reply close button hides reply bar", () => {
    const opts = makeOptions();
    const comp = createMessageInput(opts);
    comp.mount(container);

    comp.setReplyTo(42, "replyuser");
    const replyBar = container.querySelector(".reply-bar") as HTMLDivElement;
    expect(replyBar.classList.contains("visible")).toBe(true);

    const closeBtn = replyBar.querySelector(".reply-close") as HTMLElement;
    closeBtn.click();

    expect(replyBar.classList.contains("visible")).toBe(false);

    comp.destroy?.();
  });

  // ── Accessible names for icon-only composer controls (B9-22) ──

  it("names the reply close button", () => {
    const opts = makeOptions();
    const comp = createMessageInput(opts);
    comp.mount(container);

    comp.setReplyTo(1, "x");

    const replyClose = container.querySelector(".reply-bar .reply-close")!;
    expect(replyClose.getAttribute("aria-label")).toBe("Cancel reply");

    comp.destroy?.();
  });

  it("names the attachment remove button with its filename", async () => {
    const onUploadFile = vi.fn(async () => ({
      id: "srv-1",
      url: "http://x/f.png",
      filename: "f.png",
    }));
    const comp = createMessageInput(makeOptions({ onUploadFile }));
    comp.mount(container);

    const file = new File(["x"], "photo.png", { type: "image/png" });
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(fileInput, "files", { value: [file], writable: true });
    fileInput.dispatchEvent(new Event("change", { bubbles: true }));

    await vi.waitFor(() => {
      const btn = container.querySelector('[data-testid="attachment-remove"]');
      expect(btn).not.toBeNull();
      expect(btn!.getAttribute("aria-label")).toBe("Remove attachment photo.png");
    });

    comp.destroy?.();
  });

  // ── Textarea auto-resize ──

  it("textarea height adjusts on input (auto-resize)", () => {
    const opts = makeOptions();
    const comp = createMessageInput(opts);
    comp.mount(container);

    const textarea = container.querySelector(".msg-textarea") as HTMLTextAreaElement;
    // After mount, textarea should have style.height set
    // Just verify input event triggers without error (auto-resize runs)
    textarea.value = "Line 1\nLine 2\nLine 3";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));

    // Height should be set (not "auto")
    expect(textarea.style.height).not.toBe("");

    comp.destroy?.();
  });

  // ── Emoji picker ──

  it("clicking emoji button opens emoji picker", async () => {
    const opts = makeOptions();
    const comp = createMessageInput(opts);
    comp.mount(container);

    const emojiBtn = container.querySelector(".emoji-btn") as HTMLElement;
    emojiBtn.click();
    await vi.dynamicImportSettled();

    const picker = container.querySelector(".emoji-picker");
    expect(picker).not.toBeNull();

    comp.destroy?.();
  });

  it("selecting emoji inserts it into textarea at cursor position", async () => {
    const opts = makeOptions();
    const comp = createMessageInput(opts);
    comp.mount(container);

    const textarea = container.querySelector(".msg-textarea") as HTMLTextAreaElement;
    textarea.value = "Hello  world";
    textarea.selectionStart = 6;
    textarea.selectionEnd = 6;

    // Open picker
    const emojiBtn = container.querySelector(".emoji-btn") as HTMLElement;
    emojiBtn.click();
    await vi.dynamicImportSettled();

    expect(lastEmojiPickerOptions).not.toBeNull();
    lastEmojiPickerOptions!.onSelect("🎉");

    // Emoji should be inserted at cursor position
    expect(textarea.value).toBe("Hello 🎉 world");

    comp.destroy?.();
  });

  it("a plain pick closes the emoji picker", async () => {
    const comp = createMessageInput(makeOptions());
    comp.mount(container);
    (container.querySelector(".emoji-btn") as HTMLElement).click();
    await vi.dynamicImportSettled();

    lastEmojiPickerOptions!.onSelect("🎉");

    expect(container.querySelector(".emoji-picker")).toBeNull();
    comp.destroy?.();
  });

  it("a Shift-pick inserts at the caret and keeps the picker open for the next one", async () => {
    const comp = createMessageInput(makeOptions());
    comp.mount(container);
    const textarea = container.querySelector(".msg-textarea") as HTMLTextAreaElement;
    textarea.value = "ab";
    textarea.selectionStart = textarea.selectionEnd = 1;
    (container.querySelector(".emoji-btn") as HTMLElement).click();
    await vi.dynamicImportSettled();

    lastEmojiPickerOptions!.onSelect("🎉", { keepOpen: true });
    lastEmojiPickerOptions!.onSelect("🔥", { keepOpen: true });

    expect(textarea.value).toBe("a🎉🔥b");
    expect(textarea.selectionStart).toBe("a🎉🔥".length);
    expect(container.querySelector(".emoji-picker")).not.toBeNull();
    comp.destroy?.();
  });

  it("togglePicker opens and closes the emoji and GIF pickers like their buttons", async () => {
    const comp = createMessageInput(makeOptions());
    comp.mount(container);

    comp.togglePicker("emoji");
    await vi.dynamicImportSettled();
    expect(container.querySelector(".emoji-picker")).not.toBeNull();
    comp.togglePicker("gif");
    await vi.dynamicImportSettled();
    expect(container.querySelector(".emoji-picker")).toBeNull();
    expect(container.querySelector(".gif-picker")).not.toBeNull();
    comp.togglePicker("gif");
    await vi.dynamicImportSettled();
    expect(container.querySelector(".gif-picker")).toBeNull();

    comp.destroy?.();
  });

  it("togglePicker does nothing while the composer is disabled", async () => {
    const comp = createMessageInput(makeOptions());
    comp.mount(container);
    comp.setDisabled("No permission");

    comp.togglePicker("emoji");
    await vi.dynamicImportSettled();
    comp.togglePicker("gif");
    await vi.dynamicImportSettled();

    expect(container.querySelector(".emoji-picker")).toBeNull();
    expect(container.querySelector(".gif-picker")).toBeNull();
    comp.destroy?.();
  });

  // ── GIF picker ──

  it("clicking GIF button opens GIF picker", async () => {
    const opts = makeOptions();
    const comp = createMessageInput(opts);
    comp.mount(container);

    const gifBtn = container.querySelector(".gif-btn") as HTMLElement;
    gifBtn.click();
    await vi.dynamicImportSettled();

    const picker = container.querySelector(".gif-picker");
    expect(picker).not.toBeNull();

    comp.destroy?.();
  });

  it("selecting a GIF sends it as a message immediately", async () => {
    const opts = makeOptions();
    const comp = createMessageInput(opts);
    comp.mount(container);

    const gifBtn = container.querySelector(".gif-btn") as HTMLElement;
    gifBtn.click();
    await vi.dynamicImportSettled();

    expect(lastGifPickerOptions).not.toBeNull();
    lastGifPickerOptions!.onSelect("https://media.klipy.com/example.gif");

    expect(opts.onSend).toHaveBeenCalledWith(
      "https://media.klipy.com/example.gif",
      null,
      [],
      [],
      false,
    );

    comp.destroy?.();
  });

  it("selecting a GIF under a slow-mode send gate is refused with the reason", async () => {
    const opts = makeOptions();
    const comp = createMessageInput(opts);
    comp.mount(container);

    comp.setSendGate("Slow mode — 5s");
    (container.querySelector(".gif-btn") as HTMLElement).click();
    await vi.dynamicImportSettled();
    expect(lastGifPickerOptions).not.toBeNull();
    lastGifPickerOptions!.onSelect("https://media.klipy.com/example.gif");

    expect(opts.onSend).not.toHaveBeenCalled();
    expect(container.querySelector(".attachment-upload-error")!.textContent).toBe("Slow mode — 5s");

    comp.destroy?.();
  });

  it("selecting a GIF sends it without discarding a typed draft", async () => {
    const opts = makeOptions();
    const comp = createMessageInput(opts);
    comp.mount(container);

    const textarea = container.querySelector(".msg-textarea") as HTMLTextAreaElement;
    textarea.value = "wait for it...";

    const gifBtn = container.querySelector(".gif-btn") as HTMLElement;
    gifBtn.click();
    await vi.dynamicImportSettled();
    expect(lastGifPickerOptions).not.toBeNull();
    lastGifPickerOptions!.onSelect("https://media.klipy.com/example.gif");

    // The GIF is sent as its own message...
    expect(opts.onSend).toHaveBeenCalledWith(
      "https://media.klipy.com/example.gif",
      null,
      [],
      [],
      false,
    );
    // ...and the user's typed draft survives, instead of being overwritten
    // and thrown away.
    expect(textarea.value).toBe("wait for it...");

    comp.destroy?.();
  });

  it("opening GIF picker closes emoji picker", async () => {
    const opts = makeOptions();
    const comp = createMessageInput(opts);
    comp.mount(container);

    // Open emoji picker first
    const emojiBtn = container.querySelector(".emoji-btn") as HTMLElement;
    emojiBtn.click();
    await vi.dynamicImportSettled();
    expect(container.querySelector(".emoji-picker")).not.toBeNull();

    // Open GIF picker
    const gifBtn = container.querySelector(".gif-btn") as HTMLElement;
    gifBtn.click();
    await vi.dynamicImportSettled();

    // Emoji picker should be removed
    expect(container.querySelector(".emoji-picker")).toBeNull();
    // GIF picker should be present
    expect(container.querySelector(".gif-picker")).not.toBeNull();

    comp.destroy?.();
  });

  it("a mousedown inside a modal dialog keeps the GIF picker open", async () => {
    const comp = createMessageInput(makeOptions());
    comp.mount(container);
    (container.querySelector(".gif-btn") as HTMLElement).click();
    await vi.dynamicImportSettled();
    await new Promise((r) => setTimeout(r, 0));

    const overlay = document.createElement("div");
    overlay.className = "modal-overlay visible";
    const choice = document.createElement("button");
    overlay.appendChild(choice);
    document.body.appendChild(overlay);
    choice.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(container.querySelector(".gif-picker")).not.toBeNull();

    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(container.querySelector(".gif-picker")).toBeNull();

    overlay.remove();
    comp.destroy?.();
  });

  it("opening emoji picker closes GIF picker", async () => {
    const opts = makeOptions();
    const comp = createMessageInput(opts);
    comp.mount(container);

    // Open GIF picker first
    const gifBtn = container.querySelector(".gif-btn") as HTMLElement;
    gifBtn.click();
    await vi.dynamicImportSettled();
    expect(container.querySelector(".gif-picker")).not.toBeNull();

    // Open emoji picker
    const emojiBtn = container.querySelector(".emoji-btn") as HTMLElement;
    emojiBtn.click();
    await vi.dynamicImportSettled();

    // GIF picker should be removed
    expect(container.querySelector(".gif-picker")).toBeNull();
    // Emoji picker should be present
    expect(container.querySelector(".emoji-picker")).not.toBeNull();

    comp.destroy?.();
  });

  // ── Destroy cleans up ──

  it("destroy removes DOM and cleans up pickers", async () => {
    const opts = makeOptions();
    const comp = createMessageInput(opts);
    comp.mount(container);

    // Open a picker so there's state to clean up
    const emojiBtn = container.querySelector(".emoji-btn") as HTMLElement;
    emojiBtn.click();
    await vi.dynamicImportSettled();

    comp.destroy?.();

    expect(container.querySelector(".message-input-wrap")).toBeNull();
  });

  // ── Paste file handling ──

  it.each([
    ["paste.png", "image/png"],
    ["clip.mov", "video/quicktime"],
    ["clip.mp4", "video/mp4"],
  ])("pasting %s triggers upload", async (filename, type) => {
    const onUploadFile = vi.fn(async () => ({
      id: "paste-1",
      url: "http://x",
      filename,
    }));
    const opts = makeOptions({ onUploadFile });
    const comp = createMessageInput(opts);
    comp.mount(container);

    const textarea = container.querySelector(".msg-textarea") as HTMLTextAreaElement;
    const file = new File(["bytes"], filename, { type });

    // ClipboardEvent is not available in jsdom, so create a plain Event and
    // attach clipboardData manually
    const pasteEvent = new Event("paste", { bubbles: true }) as Event & {
      clipboardData?: { items: Array<{ kind: string; type: string; getAsFile(): File | null }> };
    };
    Object.defineProperty(pasteEvent, "clipboardData", {
      value: {
        items: [
          {
            kind: "file",
            type,
            getAsFile: () => file,
          },
        ],
      },
    });

    textarea.dispatchEvent(pasteEvent);

    await vi.waitFor(() => {
      expect(onUploadFile).toHaveBeenCalledWith(
        file,
        expect.any(AbortSignal),
        expect.any(Function),
      );
    });

    comp.destroy?.();
  });

  // ── Drag-and-drop file handling ──

  // jsdom has no DragEvent/DataTransfer: build a plain Event carrying the two
  // fields the handler reads.
  function fileDrop(files: File[], types: string[] = ["Files"]): Event {
    const ev = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(ev, "dataTransfer", { value: { types, files } });
    return ev;
  }

  function mountInChatArea(onUploadFile: NonNullable<MessageInputOptions["onUploadFile"]>) {
    const chatArea = document.createElement("div");
    chatArea.className = "chat-area";
    const messages = document.createElement("div");
    messages.className = "messages-slot";
    const input = document.createElement("div");
    input.className = "input-slot";
    const videoGrid = document.createElement("div");
    videoGrid.className = "video-grid-slot";
    chatArea.append(messages, input, videoGrid);
    container.appendChild(chatArea);
    const comp = createMessageInput(makeOptions({ onUploadFile }));
    comp.mount(input);
    return { comp, chatArea, messages, input, videoGrid };
  }

  const pngDrop = () => fileDrop([new File(["a"], "a.png", { type: "image/png" })]);

  it("dropping files over the channel view uploads each of them", async () => {
    const onUploadFile = vi.fn(async (file: File) => ({
      id: file.name,
      url: "http://x",
      filename: file.name,
    }));
    const { comp, input } = mountInChatArea(onUploadFile);

    const a = new File(["a"], "a.png", { type: "image/png" });
    const b = new File(["b"], "b.txt", { type: "text/plain" });
    const drop = fileDrop([a, b]);
    input.dispatchEvent(drop);

    expect(drop.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(onUploadFile).toHaveBeenCalledTimes(2));
    expect(onUploadFile.mock.calls.map(([f]) => f)).toEqual([a, b]);
    comp.destroy?.();
  });

  it("ignores a drop outside the channel view", () => {
    const onUploadFile = vi.fn();
    const { comp } = mountInChatArea(onUploadFile);

    const drop = fileDrop([new File(["a"], "a.png", { type: "image/png" })]);
    document.body.dispatchEvent(drop);

    expect(drop.defaultPrevented).toBe(false);
    expect(onUploadFile).not.toHaveBeenCalled();
    comp.destroy?.();
  });

  it("ignores a drop over the video grid, whose composer is hidden", () => {
    const onUploadFile = vi.fn();
    const { comp, videoGrid } = mountInChatArea(onUploadFile);

    const drop = pngDrop();
    videoGrid.dispatchEvent(drop);

    expect(drop.defaultPrevented).toBe(false);
    expect(onUploadFile).not.toHaveBeenCalled();
    comp.destroy?.();
  });

  it("ignores a drop while the settings overlay is open, accepts it once closed", async () => {
    const onUploadFile = vi.fn(async (file: File) => ({
      id: file.name,
      url: "http://x",
      filename: file.name,
    }));
    const { comp, input } = mountInChatArea(onUploadFile);
    const overlay = document.createElement("div");
    const panel = document.createElement("div");
    panel.setAttribute("aria-modal", "true");
    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    input.dispatchEvent(pngDrop());
    expect(onUploadFile).not.toHaveBeenCalled();

    overlay.style.display = "none";
    input.dispatchEvent(pngDrop());
    await vi.waitFor(() => expect(onUploadFile).toHaveBeenCalledTimes(1));
    overlay.remove();
    comp.destroy?.();
  });

  it("still accepts a drop when a video attachment sits in the message list", async () => {
    const onUploadFile = vi.fn(async (file: File) => ({
      id: file.name,
      url: "http://x",
      filename: file.name,
    }));
    const { comp, messages, input } = mountInChatArea(onUploadFile);
    const media = document.createElement("div");
    media.className = "msg-media-overlay";
    messages.appendChild(media);

    input.dispatchEvent(pngDrop());

    await vi.waitFor(() => expect(onUploadFile).toHaveBeenCalledTimes(1));
    comp.destroy?.();
  });

  it("ignores a drop that carries no files (a dragged text selection)", () => {
    const onUploadFile = vi.fn();
    const { comp, input } = mountInChatArea(onUploadFile);

    const drop = fileDrop([], ["text/plain"]);
    input.dispatchEvent(drop);

    expect(drop.defaultPrevented).toBe(false);
    expect(onUploadFile).not.toHaveBeenCalled();
    comp.destroy?.();
  });

  it("stops listening for drops once the composer is destroyed", () => {
    const onUploadFile = vi.fn();
    const { comp, input } = mountInChatArea(onUploadFile);
    comp.destroy?.();

    input.dispatchEvent(fileDrop([new File(["a"], "a.png", { type: "image/png" })]));

    expect(onUploadFile).not.toHaveBeenCalled();
  });

  // ── Files with an empty MIME type are uploaded; the server sniffs them (D1 a) ──

  it("files with empty MIME type are uploaded", async () => {
    const onUploadFile = vi.fn(async () => ({ id: "unk-1", url: "http://x", filename: "data" }));
    const opts = makeOptions({ onUploadFile });
    const comp = createMessageInput(opts);
    comp.mount(container);

    const noTypeFile = new File(["data"], "mystery", { type: "" });
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(fileInput, "files", { value: [noTypeFile], writable: true });
    fileInput.dispatchEvent(new Event("change", { bubbles: true }));

    await vi.waitFor(() => expect(onUploadFile).toHaveBeenCalled());
    expect(container.querySelector(".attachment-upload-error")).toBeNull();

    comp.destroy?.();
  });

  // ── Attachment count cap (server hard-rejects >10 attachments) ──

  it("refuses to queue an 11th attachment instead of uploading it", async () => {
    const onUploadFile = vi.fn(async () => ({ id: "x", url: "http://x", filename: "x" }));
    const opts = makeOptions({ onUploadFile });
    const comp = createMessageInput(opts);
    comp.mount(container);

    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;

    for (let i = 0; i < 11; i++) {
      const file = new File(["data"], `file${i}.txt`, { type: "text/plain" });
      Object.defineProperty(fileInput, "files", { value: [file], writable: true });
      fileInput.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 10));
    }

    // The server hard-rejects a chat_send with more than 10 attachments (as
    // a parse error with no attachment-specific messaging), so the composer
    // must never upload -- let alone queue -- an 11th one.
    expect(onUploadFile).toHaveBeenCalledTimes(10);
    expect(container.querySelectorAll(".attachment-preview-item").length).toBe(10);

    const error = container.querySelector(".attachment-upload-error");
    expect(error).not.toBeNull();
    expect(error!.textContent).toContain("10");

    comp.destroy?.();
  });

  // ── Toggling emoji picker closed ──

  it("clicking emoji button again closes the picker", async () => {
    const opts = makeOptions();
    const comp = createMessageInput(opts);
    comp.mount(container);

    const emojiBtn = container.querySelector(".emoji-btn") as HTMLElement;

    // Open
    emojiBtn.click();
    await vi.dynamicImportSettled();
    expect(container.querySelector(".emoji-picker")).not.toBeNull();

    // Close
    emojiBtn.click();
    await vi.dynamicImportSettled();
    expect(container.querySelector(".emoji-picker")).toBeNull();

    comp.destroy?.();
  });

  // ── GIF affordance degrades when the server has no GIF provider ───────────

  describe("GIF button degradation", () => {
    it("is enabled when a gifApi is wired", () => {
      const comp = createMessageInput(makeOptions());
      comp.mount(container);

      const gifBtn = container.querySelector(".gif-btn") as HTMLButtonElement;
      expect(gifBtn.hasAttribute("disabled")).toBe(false);

      comp.destroy?.();
    });

    it("renders disabled with a visible reason when no gifApi is wired", () => {
      const comp = createMessageInput(makeOptions({ gifApi: undefined }));
      comp.mount(container);

      const gifBtn = container.querySelector(".gif-btn") as HTMLButtonElement;
      expect(gifBtn.hasAttribute("disabled")).toBe(true);
      expect(gifBtn.title).toBe("GIFs are not enabled on this server");
      expect(gifBtn.getAttribute("aria-label")).toContain("not enabled");

      comp.destroy?.();
    });

    it("does not open a picker when no gifApi is wired", async () => {
      const comp = createMessageInput(makeOptions({ gifApi: undefined }));
      comp.mount(container);

      (container.querySelector(".gif-btn") as HTMLElement).click();
      await vi.dynamicImportSettled();
      expect(container.querySelector(".gif-picker")).toBeNull();

      comp.destroy?.();
    });

    it("disables the GIF button when the picker reports the server has GIFs off", async () => {
      const comp = createMessageInput(makeOptions());
      comp.mount(container);

      const gifBtn = container.querySelector(".gif-btn") as HTMLButtonElement;
      gifBtn.click();
      await vi.dynamicImportSettled();
      lastGifPickerOptions!.onUnavailable!("GIFs are not enabled on this server");

      expect(gifBtn.hasAttribute("disabled")).toBe(true);
      expect(gifBtn.title).toBe("GIFs are not enabled on this server");

      comp.destroy?.();
    });

    it("keeps the GIF button disabled after the composer is re-enabled", () => {
      const comp = createMessageInput(makeOptions({ gifApi: undefined }));
      comp.mount(container);

      comp.setDisabled("Read-only channel");
      comp.setDisabled(null);

      const gifBtn = container.querySelector(".gif-btn") as HTMLButtonElement;
      expect(gifBtn.hasAttribute("disabled")).toBe(true);

      comp.destroy?.();
    });
  });

  // -------------------------------------------------------------------------
  // Formatting shortcuts
  // -------------------------------------------------------------------------

  describe("formatting shortcuts", () => {
    /** Mount a composer with `value` selected from `start` to `end`. */
    function mountWithSelection(
      value: string,
      start: number,
      end: number,
    ): { textarea: HTMLTextAreaElement; destroy: () => void } {
      const comp = createMessageInput(makeOptions());
      comp.mount(container);
      const textarea = container.querySelector(".msg-textarea") as HTMLTextAreaElement;
      textarea.value = value;
      textarea.selectionStart = start;
      textarea.selectionEnd = end;
      return { textarea, destroy: () => comp.destroy?.() };
    }

    function press(textarea: HTMLTextAreaElement, key: string): KeyboardEvent {
      const event = new KeyboardEvent("keydown", {
        key,
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      });
      textarea.dispatchEvent(event);
      return event;
    }

    it("Ctrl+B wraps the selection in **", () => {
      const { textarea, destroy } = mountWithSelection("make this bold", 5, 9);
      const event = press(textarea, "b");
      expect(textarea.value).toBe("make **this** bold");
      expect(textarea.value.slice(textarea.selectionStart, textarea.selectionEnd)).toBe("this");
      expect(event.defaultPrevented).toBe(true);
      destroy();
    });

    it("Ctrl+I wraps the selection in *", () => {
      const { textarea, destroy } = mountWithSelection("hello", 0, 5);
      press(textarea, "i");
      expect(textarea.value).toBe("*hello*");
      destroy();
    });

    it("Ctrl+U wraps the selection in __ instead of opening the file picker", () => {
      const onUploadFile = vi.fn();
      const comp = createMessageInput(makeOptions({ onUploadFile }));
      comp.mount(container);
      const textarea = container.querySelector(".msg-textarea") as HTMLTextAreaElement;
      textarea.value = "hello";
      textarea.selectionStart = 0;
      textarea.selectionEnd = 5;

      // The global Ctrl+U shortcut listens on document — the composer must
      // stop the event before it gets there.
      const globalHandler = vi.fn();
      document.addEventListener("keydown", globalHandler);

      press(textarea, "u");

      expect(textarea.value).toBe("__hello__");
      expect(globalHandler).not.toHaveBeenCalled();
      expect(onUploadFile).not.toHaveBeenCalled();
      document.removeEventListener("keydown", globalHandler);
      comp.destroy?.();
    });

    it("inserts empty markers and parks the caret between them", () => {
      const { textarea, destroy } = mountWithSelection("ab", 1, 1);
      press(textarea, "b");
      expect(textarea.value).toBe("a****b");
      expect(textarea.selectionStart).toBe(3);
      expect(textarea.selectionEnd).toBe(3);
      destroy();
    });

    it("unwraps an already-bold selection", () => {
      const { textarea, destroy } = mountWithSelection("**this**", 0, 8);
      press(textarea, "b");
      expect(textarea.value).toBe("this");
      destroy();
    });

    it("leaves other Ctrl combos alone", () => {
      const { textarea, destroy } = mountWithSelection("hello", 0, 5);
      const event = press(textarea, "k");
      expect(textarea.value).toBe("hello");
      expect(event.defaultPrevented).toBe(false);
      destroy();
    });

    it("does nothing while the composer is disabled", () => {
      const comp = createMessageInput(makeOptions());
      comp.mount(container);
      comp.setDisabled("Read-only channel");
      const textarea = container.querySelector(".msg-textarea") as HTMLTextAreaElement;
      textarea.value = "hello";
      textarea.selectionStart = 0;
      textarea.selectionEnd = 5;
      press(textarea, "b");
      expect(textarea.value).toBe("hello");
      comp.destroy?.();
    });
  });

  describe("wrapWithMarker", () => {
    it("wraps a selection and reselects the inner text", () => {
      expect(wrapWithMarker("abc", 1, 2, "~~")).toEqual({
        value: "a~~b~~c",
        selectionStart: 3,
        selectionEnd: 4,
      });
    });

    it("unwraps markers that surround the selection", () => {
      expect(wrapWithMarker("a**b**c", 3, 4, "**")).toEqual({
        value: "abc",
        selectionStart: 1,
        selectionEnd: 2,
      });
    });

    it("does not mistake a short selection for a wrapped one", () => {
      expect(wrapWithMarker("**", 0, 2, "**").value).toBe("******");
    });

    it("wraps rather than mangles a selection spanning multiple already-wrapped spans", () => {
      // The selection starts and ends with "*" but is not itself a single
      // wrapped span — unwrapping it would destroy both interior spans.
      const result = wrapWithMarker("*hello* world *bye*", 0, 19, "*");
      expect(result.value).toBe("**hello* world *bye**");
    });

    it("wraps rather than downgrades bold text when italicizing", () => {
      const result = wrapWithMarker("**bold**", 0, 8, "*");
      expect(result.value).toBe("***bold***");
    });

    it("wraps rather than downgrades bold text when italicizing a double-clicked word", () => {
      // Selecting only the word (as a double-click would), not the "**"
      // markers themselves: start/end land just inside the bold pair, so
      // the single "*" immediately outside each edge belongs to a "**"
      // pair rather than being a matching "*" marker of its own.
      const result = wrapWithMarker("**bold**", 2, 6, "*");
      expect(result.value).toBe("***bold***");
    });
  });
});

// (22) the member menu's Mention writes through insertMention (WP 3C-3)
describe("MessageInput insertMention", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  function mountInput(overrides: Partial<MessageInputOptions> = {}) {
    const comp = createMessageInput(makeOptions(overrides));
    comp.mount(container);
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    return { comp, textarea };
  }

  it("inserts '@name ' into an empty composer and parks the caret after it", () => {
    const { comp, textarea } = mountInput();
    expect(comp.insertMention("Dave")).toBe(true);
    expect(textarea.value).toBe("@Dave ");
    expect(textarea.selectionStart).toBe(6);
    expect(textarea.selectionEnd).toBe(6);
    expect(document.activeElement).toBe(textarea);
    comp.destroy?.();
  });

  it("adds a leading space after a word, but not after whitespace", () => {
    const { comp, textarea } = mountInput();
    textarea.value = "hello";
    textarea.setSelectionRange(5, 5);
    comp.insertMention("Dave");
    expect(textarea.value).toBe("hello @Dave ");

    textarea.value = "hello ";
    textarea.setSelectionRange(6, 6);
    comp.insertMention("Eve");
    expect(textarea.value).toBe("hello @Eve ");
    comp.destroy?.();
  });

  it("inserts at the caret, keeping the text after it", () => {
    const { comp, textarea } = mountInput();
    textarea.value = "hi  there";
    textarea.setSelectionRange(3, 3);
    comp.insertMention("Dave");
    expect(textarea.value).toBe("hi @Dave  there");
    expect(textarea.selectionStart).toBe(9);
    comp.destroy?.();
  });

  it("returns false and leaves the draft alone while the composer is disabled", () => {
    const { comp, textarea } = mountInput();
    comp.setDisabled("You cannot send messages here");
    expect(comp.insertMention("Dave")).toBe(false);
    expect(textarea.value).toBe("");
    comp.setDisabled(null);
    expect(comp.insertMention("Dave")).toBe(true);
    comp.destroy?.();
  });

  it("returns false once the composer is destroyed", () => {
    const { comp } = mountInput();
    comp.destroy?.();
    expect(comp.insertMention("Dave")).toBe(false);
  });
});

// (23) MessageInput claims the active-composer slot the member menu reads (WP 3C-3)
describe("MessageInput active composer", () => {
  let a: HTMLDivElement;
  let b: HTMLDivElement;

  beforeEach(() => {
    a = document.createElement("div");
    b = document.createElement("div");
    document.body.append(a, b);
  });

  afterEach(() => {
    a.remove();
    b.remove();
  });

  it("is claimed on mount, follows the disabled state and is released on destroy", () => {
    const comp = createMessageInput(makeOptions());
    comp.mount(a);
    expect(canMention()).toBe(true);
    expect(mentionInComposer("Dave")).toBe(true);
    expect((a.querySelector("textarea") as HTMLTextAreaElement).value).toBe("@Dave ");
    comp.setDisabled("You cannot send messages here");
    expect(canMention()).toBe(false);
    comp.setDisabled(null);
    comp.destroy?.();
    expect(canMention()).toBe(false);
    expect(mentionInComposer("Dave")).toBe(false);
  });

  it("keeps the newer composer when the older one is destroyed after it mounts", () => {
    const first = createMessageInput(makeOptions());
    const second = createMessageInput(makeOptions());
    first.mount(a);
    second.mount(b);
    first.destroy?.();
    expect(mentionInComposer("Dave")).toBe(true);
    expect((b.querySelector("textarea") as HTMLTextAreaElement).value).toBe("@Dave ");
    expect((a.querySelector("textarea") as HTMLTextAreaElement | null)?.value ?? "").toBe("");
    second.destroy?.();
  });
});
