// 3A-12: the reply bar names the author by display name and carries an
// @ON/@OFF toggle (ON for each new reply, hidden on a reply to yourself) whose
// value rides the send.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@components/EmojiPicker", () => ({
  createEmojiPicker: () => ({ element: document.createElement("div"), destroy: vi.fn() }),
}));
vi.mock("@components/GifPicker", () => ({
  createGifPicker: () => ({ element: document.createElement("div"), destroy: vi.fn() }),
}));

import { createMessageInput, type MessageInputOptions } from "@components/MessageInput";

function makeOptions(): MessageInputOptions {
  return {
    channelId: 1,
    channelName: "general",
    onSend: vi.fn(),
    onTyping: vi.fn(),
  };
}

describe("reply bar @ON/@OFF (3A-12)", () => {
  let container: HTMLDivElement;
  const toggle = (): HTMLButtonElement =>
    container.querySelector("[data-testid=reply-ping]") as HTMLButtonElement;
  const send = (text: string): void => {
    const textarea = container.querySelector(".msg-textarea") as HTMLTextAreaElement;
    textarea.value = text;
    (container.querySelector(".send-btn") as HTMLButtonElement).click();
  };

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });
  afterEach(() => {
    vi.useRealTimers();
    container.remove();
  });

  it("names the author without an @ and pings by default", () => {
    const opts = makeOptions();
    const comp = createMessageInput(opts);
    comp.mount(container);

    comp.setReplyTo(9, "Alice B");
    expect(container.querySelector(".reply-bar")?.textContent).toContain("Replying to Alice B");
    expect(toggle().hidden).toBe(false);
    expect(toggle().getAttribute("aria-pressed")).toBe("true");

    send("agreed");
    expect(opts.onSend).toHaveBeenCalledWith("agreed", 9, [], [], true);
    comp.destroy?.();
  });

  it("sends no ping once the toggle is turned off, and the next reply is ON again", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const opts = makeOptions();
    const comp = createMessageInput(opts);
    comp.mount(container);

    comp.setReplyTo(9, "Alice");
    toggle().click();
    expect(toggle().getAttribute("aria-pressed")).toBe("false");
    expect(toggle().classList.contains("off")).toBe(true);
    expect(document.activeElement).toBe(container.querySelector(".msg-textarea"));
    send("quiet");
    expect(opts.onSend).toHaveBeenLastCalledWith("quiet", 9, [], [], false);

    vi.setSystemTime(Date.now() + 1000);
    comp.setReplyTo(10, "Bo");
    expect(toggle().getAttribute("aria-pressed")).toBe("true");
    send("loud");
    expect(opts.onSend).toHaveBeenLastCalledWith("loud", 10, [], [], true);
    comp.destroy?.();
  });

  it("hides the toggle and never pings on a reply to your own message", () => {
    const opts = makeOptions();
    const comp = createMessageInput(opts);
    comp.mount(container);

    comp.setReplyTo(11, "me", { self: true });
    expect(toggle().hidden).toBe(true);
    send("follow-up");
    expect(opts.onSend).toHaveBeenCalledWith("follow-up", 11, [], [], false);
    comp.destroy?.();
  });

  it("keeps the toggle's value across a channel switch", () => {
    const first = createMessageInput(makeOptions());
    first.mount(container);
    first.setReplyTo(9, "Alice");
    toggle().click();
    const draft = first.getDraft();
    first.destroy?.();
    expect(draft.replyTo).toEqual({ messageId: 9, username: "Alice", ping: false });

    const opts = makeOptions();
    const next = createMessageInput(opts);
    next.mount(container);
    next.restoreDraft(draft);
    expect(toggle().getAttribute("aria-pressed")).toBe("false");
    send("later");
    expect(opts.onSend).toHaveBeenCalledWith("later", 9, [], [], false);
    next.destroy?.();
  });
});
