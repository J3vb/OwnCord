import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@components/EmojiPicker", () => ({
  createEmojiPicker: () => ({
    element: document.createElement("div"),
    destroy: vi.fn(),
  }),
}));

import {
  createMessageInput,
  type MessageInputOptions,
} from "@components/MessageInput";

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

    expect(opts.onSend).toHaveBeenCalledWith("Hello world", null);

    comp.destroy?.();
  });

  it("enter key sends message", () => {
    const opts = makeOptions();
    const comp = createMessageInput(opts);
    comp.mount(container);

    const textarea = container.querySelector(".msg-textarea") as HTMLTextAreaElement;
    textarea.value = "Enter message";

    textarea.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );

    expect(opts.onSend).toHaveBeenCalledWith("Enter message", null);

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
});
