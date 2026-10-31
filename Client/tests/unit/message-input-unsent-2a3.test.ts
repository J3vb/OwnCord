// 2A-3: files a send did not carry come back as chips in an error state. A
// chip with its file re-uploads at Send and never posts the old id again; one
// without a file blocks Send until it is removed.
import { describe, it, expect, vi } from "vitest";

import * as mocks from "../helpers/messageInputMocks";
vi.mock("@components/EmojiPicker", () => mocks.emojiPickerMock());
vi.mock("@components/GifPicker", () => mocks.gifPickerMock());

import { createMessageInput, type MessageInputOptions } from "@components/MessageInput";
import { messagingText } from "../../src/i18n/messaging";
import { useMountContainer } from "../helpers/mountContainer";

function makeOptions(overrides: Partial<MessageInputOptions> = {}): MessageInputOptions {
  return {
    channelId: 1,
    channelName: "general",
    onSend: vi.fn(),
    onTyping: vi.fn(),
    onUploadFile: vi.fn(async (file: File) => ({ id: "fresh", url: "/f/1", filename: file.name })),
    ...overrides,
  };
}

const chips = (c: HTMLElement): HTMLElement[] => [
  ...c.querySelectorAll<HTMLElement>(".attachment-preview-item"),
];
const errorLine = (c: HTMLElement): string =>
  c.querySelector(".attachment-upload-error-text")?.textContent ?? "";
const send = (c: HTMLElement): void => (c.querySelector(".send-btn") as HTMLButtonElement).click();

describe("MessageInput unsent attachments (2A-3)", () => {
  let container: HTMLDivElement;
  useMountContainer((mounted) => {
    container = mounted;
  });

  it("shows a skipped file as an error chip and re-uploads it at Send", async () => {
    const opts = makeOptions();
    const comp = createMessageInput(opts);
    comp.mount(container);
    const file = new File(["x"], "report.pdf", { type: "application/pdf" });

    comp.restoreUnsent([{ id: "old", filename: "report.pdf", file }], "skipped");

    expect(chips(container)).toHaveLength(1);
    expect(chips(container)[0]!.classList.contains("unsent")).toBe(true);
    expect(chips(container)[0]!.title).toBe(messagingText("attach.notSent"));
    expect(errorLine(container)).toBe(messagingText("error.attachmentsNotSent"));

    send(container);
    expect(opts.onSend).not.toHaveBeenCalled();
    expect(opts.onUploadFile).toHaveBeenCalledWith(file, expect.anything(), expect.anything());
    await vi.waitFor(() => expect(container.querySelector(".uploading")).toBeNull());
    expect(chips(container)[0]!.classList.contains("unsent")).toBe(false);

    // Step the clock past the double-click send guard instead of waiting it out.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.advanceTimersByTime(600);
      send(container);
    } finally {
      vi.useRealTimers();
    }
    expect(opts.onSend).toHaveBeenCalledWith(
      "",
      null,
      ["fresh"],
      [expect.objectContaining({ id: "fresh" })],
      false,
    );
    comp.destroy?.();
  });

  it("keeps Send blocked on a skipped chip that has no file to re-upload", () => {
    const opts = makeOptions();
    const comp = createMessageInput(opts);
    comp.mount(container);

    comp.restoreUnsent([{ id: "old", filename: "scan.png" }], "unavailable");
    expect(errorLine(container)).toBe(messagingText("error.attachmentsUnavailable"));

    send(container);
    expect(opts.onSend).not.toHaveBeenCalled();
    expect(opts.onUploadFile).not.toHaveBeenCalled();
    expect(errorLine(container)).toBe(messagingText("error.attachmentExpired"));

    (
      container.querySelector(".attachment-remove, [data-testid=attachment-remove]") as HTMLElement
    ).click();
    expect(chips(container)).toHaveLength(0);
    comp.destroy?.();
  });

  it("restores the reply only when the composer has none of its own", () => {
    const comp = createMessageInput(makeOptions());
    comp.mount(container);
    const replyText = (): string => container.querySelector(".reply-bar")?.textContent ?? "";

    comp.setReplyTo(5, "mine");
    comp.restoreUnsent([{ id: "a", filename: "a.txt" }], "unavailable", {
      messageId: 9,
      username: "theirs",
    });
    expect(replyText()).toContain("mine");

    comp.clearReply();
    comp.restoreUnsent([{ id: "b", filename: "b.txt" }], "unavailable", {
      messageId: 9,
      username: "theirs",
    });
    expect(replyText()).toContain("theirs");
    expect(chips(container)).toHaveLength(2);
    comp.destroy?.();
  });

  it("does not add the same file twice or go past ten chips", () => {
    const comp = createMessageInput(makeOptions());
    comp.mount(container);
    const files = Array.from({ length: 12 }, (_, i) => ({ id: `f${i}`, filename: `${i}.txt` }));

    comp.restoreUnsent([files[0]!, files[0]!], "skipped");
    expect(chips(container)).toHaveLength(1);
    comp.restoreUnsent(files, "skipped");
    expect(chips(container)).toHaveLength(10);
    expect(errorLine(container)).toBe(messagingText("error.tooManyAttachments", { max: "10" }));
    comp.destroy?.();
  });

  it("carries an unsent chip across a channel switch, still in its error state", () => {
    const first = createMessageInput(makeOptions());
    first.mount(container);
    first.restoreUnsent([{ id: "old", filename: "scan.png" }], "skipped");
    const draft = first.getDraft();
    first.destroy?.();
    expect(draft.attachments).toEqual([
      expect.objectContaining({ id: "old", filename: "scan.png", unsent: true }),
    ]);

    const next = createMessageInput(makeOptions());
    next.mount(container);
    next.restoreDraft(draft);
    expect(chips(container)).toHaveLength(1);
    expect(chips(container)[0]!.classList.contains("unsent")).toBe(true);
    expect(errorLine(container)).toBe(messagingText("error.attachmentsNotSent"));
    next.destroy?.();
  });
});
