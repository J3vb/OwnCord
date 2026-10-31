import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as mocks from "../../helpers/messageInputMocks";
import {
  createMessageInput,
  wrapWithMarker,
  type MessageInputOptions,
} from "@components/MessageInput";
import { canMention, mentionInComposer } from "../../../src/features/messaging/activeComposer";
import { lastEmojiPickerOptions, lastGifPickerOptions } from "../../helpers/messageInputMocks";
import { makeOptions } from "../../helpers/messageInputHarness";
import { useMountContainer } from "../../helpers/mountContainer";

vi.mock("@components/EmojiPicker", () => mocks.emojiPickerMock());
vi.mock("@components/GifPicker", () => mocks.gifPickerMock());

const { resetPickerCaptures } = mocks;

describe("MessageInput", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    resetPickerCaptures();
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
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
  useMountContainer((mounted) => {
    container = mounted;
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
