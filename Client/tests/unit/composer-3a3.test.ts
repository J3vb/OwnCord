// 3A-3: several files from the picker, the drag-over overlay, the character
// counter and long pastes, Enter on an emptied edit, no typing signal while
// editing, and the draft hooks the controller saves from.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@components/EmojiPicker", () => ({
  createEmojiPicker: () => ({ element: document.createElement("div"), destroy: vi.fn() }),
}));
vi.mock("@components/GifPicker", () => ({
  createGifPicker: () => ({ element: document.createElement("div"), destroy: vi.fn() }),
}));

import { createMessageInput, type MessageInputOptions } from "@components/MessageInput";

function makeOptions(overrides: Partial<MessageInputOptions> = {}): MessageInputOptions {
  return {
    channelId: 1,
    channelName: "general",
    onSend: vi.fn(),
    onTyping: vi.fn(),
    ...overrides,
  };
}

const upload = (): NonNullable<MessageInputOptions["onUploadFile"]> =>
  vi.fn(async (file: File) => ({ id: file.name, url: "http://x", filename: file.name }));

function dragEvent(
  type: string,
  types: string[] = ["Files"],
  relatedTarget: unknown = null,
): Event {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(ev, "dataTransfer", { value: { types, files: [] } });
  Object.defineProperty(ev, "relatedTarget", { value: relatedTarget });
  return ev;
}

function pasteText(textarea: HTMLTextAreaElement, text: string): Event {
  const ev = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(ev, "clipboardData", {
    value: { items: [], getData: (t: string) => (t === "text/plain" ? text : "") },
  });
  textarea.dispatchEvent(ev);
  return ev;
}

describe("composer polish (3A-3)", () => {
  let container: HTMLDivElement;
  const textarea = (): HTMLTextAreaElement =>
    container.querySelector(".msg-textarea") as HTMLTextAreaElement;
  const type = (text: string): void => {
    textarea().value = text;
    textarea().dispatchEvent(new Event("input"));
  };
  const enter = (): void => {
    textarea().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  };

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });
  afterEach(() => {
    vi.useRealTimers();
    container.remove();
  });

  it("lets the picker choose several files and uploads each of them", async () => {
    const onUploadFile = upload();
    const comp = createMessageInput(makeOptions({ onUploadFile }));
    comp.mount(container);
    const input = container.querySelector("input[type=file]") as HTMLInputElement;
    expect(input.multiple).toBe(true);

    const a = new File(["a"], "a.png", { type: "image/png" });
    const b = new File(["b"], "b.pdf", { type: "application/pdf" });
    Object.defineProperty(input, "files", { value: [a, b], configurable: true });
    input.dispatchEvent(new Event("change"));

    await vi.waitFor(() => expect(onUploadFile).toHaveBeenCalledTimes(2));
    expect(vi.mocked(onUploadFile).mock.calls.map(([f]) => f)).toEqual([a, b]);
    comp.destroy?.();
  });

  describe("drag-over overlay", () => {
    function mountInChatArea(overrides: Partial<MessageInputOptions> = {}) {
      const chatArea = document.createElement("div");
      chatArea.className = "chat-area";
      const messages = document.createElement("div");
      messages.className = "messages-slot";
      const input = document.createElement("div");
      input.className = "input-slot";
      const header = document.createElement("div");
      chatArea.append(header, messages, input);
      container.appendChild(chatArea);
      const comp = createMessageInput(makeOptions({ onUploadFile: upload(), ...overrides }));
      comp.mount(input);
      const overlay = container.querySelector("[data-testid=drop-overlay]") as HTMLDivElement;
      return { comp, messages, header, overlay };
    }

    it("names the channel while a file is dragged over the chat and hides on drop", () => {
      const { comp, messages, overlay } = mountInChatArea();
      expect(overlay.hidden).toBe(true);
      expect(overlay.textContent).toContain("Upload to #general");

      messages.dispatchEvent(dragEvent("dragover"));
      expect(overlay.hidden).toBe(false);

      messages.dispatchEvent(dragEvent("drop"));
      expect(overlay.hidden).toBe(true);
      comp.destroy?.();
    });

    it("hides when the drag leaves the window or moves off the chat", () => {
      const { comp, messages, header, overlay } = mountInChatArea();
      messages.dispatchEvent(dragEvent("dragover"));
      messages.dispatchEvent(dragEvent("dragleave", ["Files"], header));
      expect(overlay.hidden).toBe(false);
      messages.dispatchEvent(dragEvent("dragleave", ["Files"], null));
      expect(overlay.hidden).toBe(true);

      messages.dispatchEvent(dragEvent("dragover"));
      header.dispatchEvent(dragEvent("dragover"));
      expect(overlay.hidden).toBe(true);
      comp.destroy?.();
    });

    it("stays hidden for dragged text and while the composer is disabled", () => {
      const { comp, messages, overlay } = mountInChatArea();
      messages.dispatchEvent(dragEvent("dragover", ["text/plain"]));
      expect(overlay.hidden).toBe(true);

      comp.setDisabled("Not connected");
      messages.dispatchEvent(dragEvent("dragover"));
      expect(overlay.hidden).toBe(true);
      comp.destroy?.();
    });
  });

  describe("character counter", () => {
    it("appears with 200 characters left and turns red past the limit", () => {
      const comp = createMessageInput(makeOptions());
      comp.mount(container);
      const counter = container.querySelector("[data-testid=char-counter]") as HTMLSpanElement;

      type("a".repeat(3799));
      expect(counter.hidden).toBe(true);
      type("a".repeat(3800));
      expect(counter.hidden).toBe(false);
      expect(counter.textContent).toBe("200");
      expect(counter.classList.contains("over")).toBe(false);

      type("a".repeat(4005));
      expect(counter.textContent).toBe("-5");
      expect(counter.classList.contains("over")).toBe(true);
      expect(counter.title).toBe("5 characters over the limit");
      comp.destroy?.();
    });

    it("counts emoji as one character each, as the server does", () => {
      const comp = createMessageInput(makeOptions());
      comp.mount(container);
      const counter = container.querySelector("[data-testid=char-counter]") as HTMLSpanElement;
      type("😀".repeat(3900));
      expect(counter.textContent).toBe("100");
      comp.destroy?.();
    });

    it("clears after a send", () => {
      const comp = createMessageInput(makeOptions());
      comp.mount(container);
      const counter = container.querySelector("[data-testid=char-counter]") as HTMLSpanElement;
      type("a".repeat(3900));
      enter();
      expect(textarea().value).toBe("");
      expect(counter.hidden).toBe(true);
      comp.destroy?.();
    });
  });

  describe("long paste", () => {
    it("turns a paste past the limit into message.txt", async () => {
      const onUploadFile = upload();
      const comp = createMessageInput(makeOptions({ onUploadFile }));
      comp.mount(container);
      const ev = pasteText(textarea(), "x".repeat(4001));
      expect(ev.defaultPrevented).toBe(true);
      await vi.waitFor(() => expect(onUploadFile).toHaveBeenCalledTimes(1));
      const file = vi.mocked(onUploadFile).mock.calls[0]![0];
      expect(file.name).toBe("message.txt");
      expect(await file.text()).toBe("x".repeat(4001));
      comp.destroy?.();
    });

    it("leaves a paste that fits, or any paste with no upload, as text", () => {
      const onUploadFile = upload();
      const comp = createMessageInput(makeOptions({ onUploadFile }));
      comp.mount(container);
      expect(pasteText(textarea(), "x".repeat(4000)).defaultPrevented).toBe(false);
      comp.destroy?.();

      const noUploads = createMessageInput(makeOptions());
      noUploads.mount(container);
      expect(pasteText(textarea(), "x".repeat(5000)).defaultPrevented).toBe(false);
      noUploads.destroy?.();
      expect(onUploadFile).not.toHaveBeenCalled();
    });
  });

  describe("long draft", () => {
    const action = (): HTMLButtonElement | null =>
      container.querySelector('[data-testid="too-long-as-file"]');

    it("offers to send a typed draft past the limit as message.txt", async () => {
      const onUploadFile = upload();
      const comp = createMessageInput(makeOptions({ onUploadFile }));
      comp.mount(container);
      type("y".repeat(4001));
      enter();
      expect(container.querySelector(".attachment-upload-error-text")).not.toBeNull();
      const btn = action();
      expect(btn).not.toBeNull();
      btn!.click();
      await vi.waitFor(() => expect(onUploadFile).toHaveBeenCalledTimes(1));
      const file = vi.mocked(onUploadFile).mock.calls[0]![0];
      expect(file.name).toBe("message.txt");
      expect(await file.text()).toBe("y".repeat(4001));
      expect(textarea().value).toBe("");
      expect(container.querySelector(".attachment-upload-error")).toBeNull();
      comp.destroy?.();
    });

    it("shows the refusal without the action when uploads are not wired", () => {
      const comp = createMessageInput(makeOptions());
      comp.mount(container);
      type("y".repeat(4001));
      enter();
      expect(container.querySelector(".attachment-upload-error-text")).not.toBeNull();
      expect(action()).toBeNull();
      comp.destroy?.();
    });

    it("sends the text as it is when clicked, not as it was refused", async () => {
      const onUploadFile = upload();
      const comp = createMessageInput(makeOptions({ onUploadFile }));
      comp.mount(container);
      type("y".repeat(4001));
      enter();
      textarea().value = `${"y".repeat(4001)}z`;
      action()!.click();
      await vi.waitFor(() => expect(onUploadFile).toHaveBeenCalledTimes(1));
      expect(await vi.mocked(onUploadFile).mock.calls[0]![0].text()).toBe(`${"y".repeat(4001)}z`);
      comp.destroy?.();
    });

    it("puts the draft back when the file fails to upload", async () => {
      const onUploadFile = vi.fn(async () => {
        throw new Error("offline");
      });
      const comp = createMessageInput(makeOptions({ onUploadFile }));
      comp.mount(container);
      type("y".repeat(4001));
      enter();
      action()!.click();
      expect(textarea().value).toBe("");
      await vi.waitFor(() => expect(textarea().value).toBe("y".repeat(4001)));
      expect(container.querySelector(".attachment-preview-item")).toBeNull();
      comp.destroy?.();
    });

    it("keeps one action button when the refusal shows twice", () => {
      const comp = createMessageInput(makeOptions({ onUploadFile: upload() }));
      comp.mount(container);
      type("y".repeat(4001));
      enter();
      enter();
      expect(container.querySelectorAll('[data-testid="too-long-as-file"]')).toHaveLength(1);
      comp.destroy?.();
    });
  });

  describe("draft hooks", () => {
    it("reports text and reply changes, and the send that clears them", () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const onDraftChange = vi.fn();
      const comp = createMessageInput(makeOptions({ onDraftChange }));
      comp.mount(container);

      type("hello");
      expect(onDraftChange).toHaveBeenCalledTimes(1);
      expect(comp.peekDraft()).toEqual({ content: "hello", replyTo: null });

      comp.setReplyTo(7, "Ann");
      expect(onDraftChange).toHaveBeenCalledTimes(2);
      expect(comp.peekDraft().replyTo).toMatchObject({ messageId: 7, username: "Ann" });

      enter();
      expect(onDraftChange).toHaveBeenLastCalledWith();
      expect(comp.peekDraft()).toEqual({ content: "", replyTo: null });
      comp.destroy?.();
    });

    it("reports formatting applied from the keyboard", () => {
      const onDraftChange = vi.fn();
      const comp = createMessageInput(makeOptions({ onDraftChange }));
      comp.mount(container);
      textarea().value = "bold";
      textarea().setSelectionRange(0, 4);
      textarea().dispatchEvent(
        new KeyboardEvent("keydown", { key: "b", ctrlKey: true, bubbles: true }),
      );
      expect(textarea().value).toBe("**bold**");
      expect(onDraftChange).toHaveBeenCalled();
      expect(comp.peekDraft().content).toBe("**bold**");
      comp.destroy?.();
    });
  });
});
