import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/** Captured emoji picker callbacks so tests can simulate selection. */
let lastEmojiPickerOptions: { onSelect: (emoji: string) => void; onClose: () => void } | null =
  null;

vi.mock("@components/EmojiPicker", () => ({
  createEmojiPicker: (opts: { onSelect: (emoji: string) => void; onClose: () => void }) => {
    lastEmojiPickerOptions = opts;
    const element = document.createElement("div");
    element.classList.add("emoji-picker");
    return { element, destroy: vi.fn() };
  },
}));

/** Captured GIF picker callbacks so tests can simulate selection. */
let lastGifPickerOptions: { onSelect: (url: string) => void; onClose: () => void } | null = null;

vi.mock("@components/GifPicker", () => ({
  createGifPicker: (opts: { onSelect: (url: string) => void; onClose: () => void }) => {
    lastGifPickerOptions = opts;
    const element = document.createElement("div");
    element.classList.add("gif-picker");
    return { element, destroy: vi.fn() };
  },
}));

import { createMessageInput, type MessageInputOptions } from "@components/MessageInput";

function makeOptions(overrides: Partial<MessageInputOptions> = {}): MessageInputOptions {
  return {
    channelId: 1,
    channelName: "general",
    onSend: vi.fn(),
    onTyping: vi.fn(),
    onEditMessage: vi.fn(),
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

    expect(opts.onSend).toHaveBeenCalledWith("Hello world", null, []);

    comp.destroy?.();
  });

  it("enter key sends message", () => {
    const opts = makeOptions();
    const comp = createMessageInput(opts);
    comp.mount(container);

    const textarea = container.querySelector(".msg-textarea") as HTMLTextAreaElement;
    textarea.value = "Enter message";

    textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    expect(opts.onSend).toHaveBeenCalledWith("Enter message", null, []);

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

  it("startEdit sets textarea value and shows edit bar", () => {
    const opts = makeOptions();
    const comp = createMessageInput(opts);
    comp.mount(container);

    comp.startEdit(99, "editing this");

    const textarea = container.querySelector(".msg-textarea") as HTMLTextAreaElement;
    expect(textarea.value).toBe("editing this");

    // The edit bar is the second .reply-bar
    const bars = container.querySelectorAll(".reply-bar");
    const editBar = bars[1] as HTMLDivElement;
    expect(editBar.classList.contains("visible")).toBe(true);

    comp.destroy?.();
  });

  it("cancelEdit clears textarea and hides edit bar", () => {
    const opts = makeOptions();
    const comp = createMessageInput(opts);
    comp.mount(container);

    comp.startEdit(99, "editing this");
    comp.cancelEdit();

    const textarea = container.querySelector(".msg-textarea") as HTMLTextAreaElement;
    expect(textarea.value).toBe("");

    const bars = container.querySelectorAll(".reply-bar");
    const editBar = bars[1] as HTMLDivElement;
    expect(editBar.classList.contains("visible")).toBe(false);

    comp.destroy?.();
  });

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

  // ── Edit mode sends via onEditMessage ──

  it("sending in edit mode calls onEditMessage instead of onSend", () => {
    const opts = makeOptions();
    const comp = createMessageInput(opts);
    comp.mount(container);

    comp.startEdit(77, "old content");

    const textarea = container.querySelector(".msg-textarea") as HTMLTextAreaElement;
    textarea.value = "updated content";

    const sendBtn = container.querySelector(".send-btn") as HTMLButtonElement;
    sendBtn.click();

    expect(opts.onEditMessage).toHaveBeenCalledWith(77, "updated content");
    expect(opts.onSend).not.toHaveBeenCalled();

    // After send, edit bar should be hidden and textarea cleared
    const bars = container.querySelectorAll(".reply-bar");
    const editBar = bars[1] as HTMLDivElement;
    expect(editBar.classList.contains("visible")).toBe(false);
    expect(textarea.value).toBe("");

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

    expect(opts.onSend).toHaveBeenCalledWith("reply content", 55, []);

    // Reply bar should be hidden after send
    const replyBar = container.querySelector(".reply-bar") as HTMLDivElement;
    expect(replyBar.classList.contains("visible")).toBe(false);

    comp.destroy?.();
  });

  // ── Escape key behavior ──

  it("escape key cancels edit mode", () => {
    const opts = makeOptions();
    const comp = createMessageInput(opts);
    comp.mount(container);

    comp.startEdit(88, "editing");

    const textarea = container.querySelector(".msg-textarea") as HTMLTextAreaElement;
    textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    // Edit bar should be hidden
    const bars = container.querySelectorAll(".reply-bar");
    const editBar = bars[1] as HTMLDivElement;
    expect(editBar.classList.contains("visible")).toBe(false);
    expect(textarea.value).toBe("");

    comp.destroy?.();
  });

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
      expect(onUploadFile).toHaveBeenCalledWith(testFile);
    });

    // Preview bar should be visible
    const previewBar = container.querySelector(".attachment-preview-bar");
    expect(previewBar!.classList.contains("visible")).toBe(true);

    // Now send a message -- should include the attachment ID
    const textarea = container.querySelector(".msg-textarea") as HTMLTextAreaElement;
    textarea.value = "with attachment";
    const sendBtn = container.querySelector(".send-btn") as HTMLButtonElement;
    sendBtn.click();

    expect(opts.onSend).toHaveBeenCalledWith("with attachment", null, ["srv-123"]);

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

  it("rejects unsupported file types", async () => {
    const onUploadFile = vi.fn(async () => ({ id: "x", url: "x", filename: "x" }));
    const opts = makeOptions({ onUploadFile });
    const comp = createMessageInput(opts);
    comp.mount(container);

    const badFile = new File(["exe data"], "bad.exe", { type: "application/x-msdownload" });

    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(fileInput, "files", { value: [badFile], writable: true });
    fileInput.dispatchEvent(new Event("change", { bubbles: true }));

    await new Promise((r) => setTimeout(r, 10));

    expect(onUploadFile).not.toHaveBeenCalled();
    const error = container.querySelector(".attachment-upload-error");
    expect(error).not.toBeNull();
    expect(error!.textContent).toContain("is not a supported file type");

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

  it("blocks send while uploads are still in flight", async () => {
    // Create an upload that never resolves during the test
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

    // Should NOT have sent -- upload still pending
    expect(opts.onSend).not.toHaveBeenCalled();
    // Should show "wait" error
    const error = container.querySelector(".attachment-upload-error");
    expect(error).not.toBeNull();
    expect(error!.textContent).toContain("wait for uploads");

    // Now resolve the upload
    resolveUpload!({ id: "done", url: "http://x", filename: "doc.txt" });
    await new Promise((r) => setTimeout(r, 10));

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

  // ── setReplyTo clears edit mode ──

  it("setReplyTo hides edit bar if editing", () => {
    const opts = makeOptions();
    const comp = createMessageInput(opts);
    comp.mount(container);

    comp.startEdit(88, "editing");
    const bars = container.querySelectorAll(".reply-bar");
    const editBar = bars[1] as HTMLDivElement;
    expect(editBar.classList.contains("visible")).toBe(true);

    comp.setReplyTo(55, "replying");

    // Edit bar hidden, reply bar shown
    expect(editBar.classList.contains("visible")).toBe(false);
    const replyBar = bars[0] as HTMLDivElement;
    expect(replyBar.classList.contains("visible")).toBe(true);

    comp.destroy?.();
  });

  // ── startEdit clears reply mode ──

  it("startEdit hides reply bar if replying", () => {
    const opts = makeOptions();
    const comp = createMessageInput(opts);
    comp.mount(container);

    comp.setReplyTo(55, "replying");
    const bars = container.querySelectorAll(".reply-bar");
    const replyBar = bars[0] as HTMLDivElement;
    expect(replyBar.classList.contains("visible")).toBe(true);

    comp.startEdit(88, "now editing");

    // Reply bar hidden, edit bar shown
    expect(replyBar.classList.contains("visible")).toBe(false);
    const editBar = bars[1] as HTMLDivElement;
    expect(editBar.classList.contains("visible")).toBe(true);

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

  it("clicking emoji button opens emoji picker", () => {
    const opts = makeOptions();
    const comp = createMessageInput(opts);
    comp.mount(container);

    const emojiBtn = container.querySelector(".emoji-btn") as HTMLElement;
    emojiBtn.click();

    const picker = container.querySelector(".emoji-picker");
    expect(picker).not.toBeNull();

    comp.destroy?.();
  });

  it("selecting emoji inserts it into textarea at cursor position", () => {
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

    expect(lastEmojiPickerOptions).not.toBeNull();
    lastEmojiPickerOptions!.onSelect("🎉");

    // Emoji should be inserted at cursor position
    expect(textarea.value).toBe("Hello 🎉 world");

    comp.destroy?.();
  });

  // ── GIF picker ──

  it("clicking GIF button opens GIF picker", () => {
    const opts = makeOptions();
    const comp = createMessageInput(opts);
    comp.mount(container);

    const gifBtn = container.querySelector(".gif-btn") as HTMLElement;
    gifBtn.click();

    const picker = container.querySelector(".gif-picker");
    expect(picker).not.toBeNull();

    comp.destroy?.();
  });

  it("selecting a GIF sends it as a message immediately", () => {
    const opts = makeOptions();
    const comp = createMessageInput(opts);
    comp.mount(container);

    const gifBtn = container.querySelector(".gif-btn") as HTMLElement;
    gifBtn.click();

    expect(lastGifPickerOptions).not.toBeNull();
    lastGifPickerOptions!.onSelect("https://media.klipy.com/example.gif");

    expect(opts.onSend).toHaveBeenCalledWith("https://media.klipy.com/example.gif", null, []);

    comp.destroy?.();
  });

  it("opening GIF picker closes emoji picker", () => {
    const opts = makeOptions();
    const comp = createMessageInput(opts);
    comp.mount(container);

    // Open emoji picker first
    const emojiBtn = container.querySelector(".emoji-btn") as HTMLElement;
    emojiBtn.click();
    expect(container.querySelector(".emoji-picker")).not.toBeNull();

    // Open GIF picker
    const gifBtn = container.querySelector(".gif-btn") as HTMLElement;
    gifBtn.click();

    // Emoji picker should be removed
    expect(container.querySelector(".emoji-picker")).toBeNull();
    // GIF picker should be present
    expect(container.querySelector(".gif-picker")).not.toBeNull();

    comp.destroy?.();
  });

  it("opening emoji picker closes GIF picker", () => {
    const opts = makeOptions();
    const comp = createMessageInput(opts);
    comp.mount(container);

    // Open GIF picker first
    const gifBtn = container.querySelector(".gif-btn") as HTMLElement;
    gifBtn.click();
    expect(container.querySelector(".gif-picker")).not.toBeNull();

    // Open emoji picker
    const emojiBtn = container.querySelector(".emoji-btn") as HTMLElement;
    emojiBtn.click();

    // GIF picker should be removed
    expect(container.querySelector(".gif-picker")).toBeNull();
    // Emoji picker should be present
    expect(container.querySelector(".emoji-picker")).not.toBeNull();

    comp.destroy?.();
  });

  // ── Destroy cleans up ──

  it("destroy removes DOM and cleans up pickers", () => {
    const opts = makeOptions();
    const comp = createMessageInput(opts);
    comp.mount(container);

    // Open a picker so there's state to clean up
    const emojiBtn = container.querySelector(".emoji-btn") as HTMLElement;
    emojiBtn.click();

    comp.destroy?.();

    expect(container.querySelector(".message-input-wrap")).toBeNull();
  });

  // ── Paste file handling ──

  it("pasting an image file triggers upload", async () => {
    const onUploadFile = vi.fn(async () => ({
      id: "paste-1",
      url: "http://x",
      filename: "paste.png",
    }));
    const opts = makeOptions({ onUploadFile });
    const comp = createMessageInput(opts);
    comp.mount(container);

    const textarea = container.querySelector(".msg-textarea") as HTMLTextAreaElement;
    const file = new File(["img"], "paste.png", { type: "image/png" });

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
            type: "image/png",
            getAsFile: () => file,
          },
        ],
      },
    });

    textarea.dispatchEvent(pasteEvent);

    await vi.waitFor(() => {
      expect(onUploadFile).toHaveBeenCalledWith(file);
    });

    comp.destroy?.();
  });

  // ── Files with empty MIME type are rejected (security hardening) ──

  it("files with empty MIME type are rejected", async () => {
    const onUploadFile = vi.fn(async () => ({ id: "unk-1", url: "http://x", filename: "data" }));
    const opts = makeOptions({ onUploadFile });
    const comp = createMessageInput(opts);
    comp.mount(container);

    const noTypeFile = new File(["data"], "mystery", { type: "" });
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(fileInput, "files", { value: [noTypeFile], writable: true });
    fileInput.dispatchEvent(new Event("change", { bubbles: true }));

    await new Promise((r) => setTimeout(r, 10));

    expect(onUploadFile).not.toHaveBeenCalled();
    const error = container.querySelector(".attachment-upload-error");
    expect(error).not.toBeNull();
    expect(error!.textContent).toContain("is not a supported file type");

    comp.destroy?.();
  });

  // ── Toggling emoji picker closed ──

  it("clicking emoji button again closes the picker", () => {
    const opts = makeOptions();
    const comp = createMessageInput(opts);
    comp.mount(container);

    const emojiBtn = container.querySelector(".emoji-btn") as HTMLElement;

    // Open
    emojiBtn.click();
    expect(container.querySelector(".emoji-picker")).not.toBeNull();

    // Close
    emojiBtn.click();
    expect(container.querySelector(".emoji-picker")).toBeNull();

    comp.destroy?.();
  });
});
