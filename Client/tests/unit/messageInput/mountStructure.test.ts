import { afterEach, describe, expect, it, vi } from "vitest";
import * as mocks from "../../helpers/messageInputMocks";
import { mountMessageInput, useMessageInputContainer } from "../../helpers/messageInputHarness";
import { resetServerCapabilities, applyReadyCapabilities } from "@lib/net/serverCapabilities";
import { resetComposerServer } from "../../helpers/composerSheets";

vi.mock("@components/EmojiPicker", () => mocks.emojiPickerMock());
vi.mock("@components/GifPicker", () => mocks.gifPickerMock());

const upload = vi.fn(async (file: File) => ({ id: "u", url: "/f/u", filename: file.name }));

/** The bar's controls in DOM order, by a short name. */
function barOrder(container: HTMLElement): string[] {
  const box = container.querySelector(".message-input-box");
  const names: [string, string][] = [
    ["attach", "attach-btn"],
    ["textarea", "msg-textarea"],
    ["emoji", "emoji-btn"],
    ["sticker", "sticker-btn"],
    ["gif", "gif-btn"],
    ["poll", "poll-btn"],
    ["mic", "mic-btn"],
    ["counter", "char-counter"],
    ["send", "send-btn"],
  ];
  return [...(box?.children ?? [])].map(
    (el) => names.find(([, cls]) => el.classList.contains(cls))?.[0] ?? "?",
  );
}

describe("composer mount structure", () => {
  let container: HTMLDivElement;
  useMessageInputContainer((el) => {
    container = el;
  });
  afterEach(() => {
    resetServerCapabilities();
    resetComposerServer();
  });

  it("a plain composer: attach, text, emoji, gif, counter, send", () => {
    const { comp } = mountMessageInput(container);
    expect(barOrder(container)).toEqual(["attach", "textarea", "emoji", "gif", "counter", "send"]);
    comp.destroy?.();
  });

  it("with upload, sticker and poll on offer: every button in its slot", () => {
    applyReadyCapabilities({ stickers: true, polls: true });
    const { comp } = mountMessageInput(container, {
      onUploadFile: upload,
      onSendSticker: vi.fn(),
      onCreatePoll: vi.fn(),
    });
    expect(barOrder(container)).toEqual([
      "attach",
      "textarea",
      "emoji",
      "sticker",
      "gif",
      "poll",
      "mic",
      "counter",
      "send",
    ]);
    comp.destroy?.();
  });

  it("sticker and poll buttons need both the host callback and the server capability", () => {
    const { comp } = mountMessageInput(container, {
      onUploadFile: upload,
      onSendSticker: vi.fn(),
      onCreatePoll: vi.fn(),
    });
    expect(barOrder(container)).not.toContain("sticker");
    expect(barOrder(container)).not.toContain("poll");
    comp.destroy?.();
  });

  it("noAttach leaves out the plus button and the mic", () => {
    const { comp } = mountMessageInput(container, { onUploadFile: upload, noAttach: true });
    expect(barOrder(container)).toEqual(["textarea", "emoji", "gif", "counter", "send"]);
    comp.destroy?.();
  });

  it("without an upload handler the plus button is disabled with a tooltip and no mic", () => {
    const { comp } = mountMessageInput(container);
    const attach = container.querySelector<HTMLButtonElement>(".attach-btn");
    expect(attach?.disabled).toBe(true);
    expect(attach?.title).not.toBe("");
    expect(container.querySelector('[data-testid="voice-mic-btn"]')).toBeNull();
    comp.destroy?.();
  });

  it("the mic starts hidden and belongs to the controls the disabled state toggles", () => {
    const { comp } = mountMessageInput(container, { onUploadFile: upload });
    const mic = container.querySelector<HTMLButtonElement>('[data-testid="voice-mic-btn"]');
    expect(mic).not.toBeNull();
    comp.setDisabled("No access");
    expect(mic?.disabled).toBe(true);
    comp.setDisabled(null);
    expect(mic?.disabled).toBe(false);
    comp.destroy?.();
  });

  it("a gif-less composer marks the GIF button unavailable", () => {
    const { comp } = mountMessageInput(container, { gifApi: undefined });
    expect(container.querySelector<HTMLButtonElement>(".gif-btn")?.disabled).toBe(true);
    comp.destroy?.();
  });

  it("the reply bar holds the ping toggle and a close button", () => {
    const { comp } = mountMessageInput(container);
    const bar = container.querySelector(".reply-bar");
    expect(bar?.querySelector('[data-testid="reply-ping"]')).not.toBeNull();
    expect(bar?.querySelector(".reply-close")).not.toBeNull();
    comp.destroy?.();
  });

  it("focuses the textarea on mount, but not a composer that starts disabled", () => {
    const first = mountMessageInput(container);
    expect(document.activeElement).toBe(container.querySelector(".msg-textarea"));
    first.comp.destroy?.();
    const second = mountMessageInput(container, { disabledReason: "Read only" });
    expect(document.activeElement).not.toBe(container.querySelector(".msg-textarea"));
    expect(container.querySelector<HTMLTextAreaElement>(".msg-textarea")?.readOnly).toBe(true);
    second.comp.destroy?.();
  });

  it("Enter with Shift or a held Ctrl+Shift never sends", () => {
    const { opts, comp } = mountMessageInput(container);
    const ta = container.querySelector<HTMLTextAreaElement>(".msg-textarea")!;
    ta.value = "text";
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true }));
    expect(opts.onSend).not.toHaveBeenCalled();
    comp.destroy?.();
  });

  it("ArrowUp with Ctrl, Alt or Meta held does not ask for an edit", () => {
    const { comp } = mountMessageInput(container);
    const listener = vi.fn();
    container.addEventListener("edit-last-message", listener);
    const ta = container.querySelector<HTMLTextAreaElement>(".msg-textarea")!;
    for (const mod of ["ctrlKey", "altKey", "metaKey"] as const) {
      ta.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowUp", [mod]: true, bubbles: true }),
      );
    }
    expect(listener).not.toHaveBeenCalled();
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    expect(listener).toHaveBeenCalledTimes(1);
    comp.destroy?.();
  });

  it("a keyboard edit of the text clears the upload refusal line", () => {
    const { comp } = mountMessageInput(container);
    comp.setSendGate("Slow mode");
    const ta = container.querySelector<HTMLTextAreaElement>(".msg-textarea")!;
    ta.value = "x";
    (container.querySelector(".send-btn") as HTMLButtonElement).click();
    expect(container.querySelector(".attachment-upload-error")?.textContent).toContain("Slow mode");
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    expect(container.querySelector(".attachment-upload-error")?.textContent ?? "").toBe("");
    comp.destroy?.();
  });
});
