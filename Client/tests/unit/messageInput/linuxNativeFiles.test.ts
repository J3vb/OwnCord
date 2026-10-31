// Linux drag-drop and paste of files from the file manager: WebKitGTK hands
// the page only paths, so the host reads the files (platform nativeFiles).
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NativeFile, NativeFileDrag } from "../../../src/platform/contracts/nativeFiles";

const native = vi.hoisted(() => ({
  handlers: [] as Array<(drag: NativeFileDrag) => void>,
  clipboard: vi.fn(async (): Promise<readonly NativeFile[]> => []),
}));

vi.mock("../../../src/platform/desktop", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../../src/platform/desktop")>();
  return {
    desktop: {
      ...real.desktop,
      nativeFiles: {
        available: true,
        onDrag: (handler: (drag: NativeFileDrag) => void) => {
          native.handlers.push(handler);
          return () => {
            native.handlers = native.handlers.filter((h) => h !== handler);
          };
        },
        clipboardFiles: native.clipboard,
      },
    },
  };
});
vi.mock("@components/EmojiPicker", () => ({
  createEmojiPicker: () => ({ element: document.createElement("div"), destroy: vi.fn() }),
}));
vi.mock("@components/GifPicker", () => ({
  createGifPicker: () => ({ element: document.createElement("div"), destroy: vi.fn() }),
}));

import { createMessageInput, type MessageInputOptions } from "@components/MessageInput";
import { looksLikeFileList } from "@components/message-input/inputAttachments";

function nativeFile(
  name: string,
  body = "data",
  size = body.length,
): NativeFile & { reads: number } {
  const f = {
    name,
    size,
    reads: 0,
    read: async () => {
      f.reads++;
      return new File([body], name, { type: "text/plain" });
    },
  };
  return f;
}

function pointAt(el: Element | null): void {
  document.elementFromPoint = vi.fn(() => el);
}

function emit(drag: NativeFileDrag): void {
  for (const h of native.handlers) h(drag);
}

function paste(textarea: HTMLTextAreaElement, text: string, types = ["text/plain"]): Event {
  const e = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(e, "clipboardData", {
    value: { items: [], types, getData: (t: string) => (t === "text/plain" ? text : "") },
  });
  textarea.dispatchEvent(e);
  return e;
}

describe("Linux native files", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    native.handlers = [];
    native.clipboard.mockReset();
    native.clipboard.mockResolvedValue([]);
    document.body.innerHTML = "";
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  function mount() {
    const onUploadFile = vi.fn(async (file: File) => ({
      id: file.name,
      url: "http://x",
      filename: file.name,
    }));
    const chatArea = document.createElement("div");
    chatArea.className = "chat-area";
    const messages = document.createElement("div");
    messages.className = "messages-slot";
    const header = document.createElement("div");
    const input = document.createElement("div");
    input.className = "input-slot";
    chatArea.append(header, messages, input);
    container.appendChild(chatArea);
    const opts: MessageInputOptions = {
      channelId: 1,
      channelName: "general",
      onSend: vi.fn(),
      onTyping: vi.fn(),
      onUploadFile,
    };
    const comp = createMessageInput(opts);
    comp.mount(input);
    const overlay = container.querySelector("[data-testid=drop-overlay]") as HTMLDivElement;
    const textarea = container.querySelector(".msg-textarea") as HTMLTextAreaElement;
    return { comp, onUploadFile, messages, header, overlay, textarea };
  }

  it("attaches files dropped on the chat and shows the overlay while dragging", async () => {
    const { comp, onUploadFile, messages, overlay } = mount();
    pointAt(messages);
    emit({ kind: "over", x: 10, y: 10 });
    expect(overlay.hidden).toBe(false);

    const a = nativeFile("a.txt");
    const b = nativeFile("b.txt");
    emit({ kind: "drop", x: 10, y: 10, files: [a, b] });
    expect(overlay.hidden).toBe(true);
    await vi.waitFor(() => expect(onUploadFile).toHaveBeenCalledTimes(2));
    expect(onUploadFile.mock.calls.map(([f]) => f.name)).toEqual(["a.txt", "b.txt"]);
    comp.destroy?.();
  });

  it("uploads nothing for a drop off the chat or after the drag left", async () => {
    const { comp, onUploadFile, header, messages, overlay } = mount();
    pointAt(messages);
    emit({ kind: "over", x: 1, y: 1 });
    emit({ kind: "leave" });
    expect(overlay.hidden).toBe(true);

    pointAt(header);
    const f = nativeFile("a.txt");
    emit({ kind: "drop", x: 1, y: 1, files: [f] });
    await new Promise((r) => setTimeout(r, 10));
    expect(f.reads).toBe(0);
    expect(onUploadFile).not.toHaveBeenCalled();
    comp.destroy?.();
  });

  it("refuses an oversized dropped file without reading it", async () => {
    const { comp, onUploadFile, messages } = mount();
    pointAt(messages);
    const big = nativeFile("big.bin", "x", 101 * 1024 * 1024);
    emit({ kind: "drop", x: 1, y: 1, files: [big] });
    await vi.waitFor(() =>
      expect(container.querySelector(".attachment-upload-error")?.textContent).toContain("big.bin"),
    );
    expect(big.reads).toBe(0);
    expect(onUploadFile).not.toHaveBeenCalled();
    comp.destroy?.();
  });

  it("stops listening once the composer is destroyed", () => {
    const { comp } = mount();
    expect(native.handlers).toHaveLength(1);
    comp.destroy?.();
    expect(native.handlers).toHaveLength(0);
  });

  it("attaches files copied in the file manager and takes the pasted paths back out", async () => {
    const { comp, onUploadFile, textarea } = mount();
    native.clipboard.mockResolvedValue([nativeFile("photo.txt")]);
    textarea.value = "see ";
    textarea.setSelectionRange(4, 4);
    const e = paste(textarea, "/home/me/photo.txt", ["text/plain", "text/uri-list"]);
    expect(e.defaultPrevented).toBe(false);
    // The webview inserts the pasted text itself.
    textarea.value = "see /home/me/photo.txt";
    await vi.waitFor(() => expect(onUploadFile).toHaveBeenCalledTimes(1));
    expect(textarea.value).toBe("see ");
    comp.destroy?.();
  });

  it("keeps a pasted path as text when the clipboard holds no files", async () => {
    const { comp, onUploadFile, textarea } = mount();
    textarea.value = "see ";
    textarea.setSelectionRange(4, 4);
    const e = paste(textarea, "/home/me/notes.txt");
    expect(e.defaultPrevented).toBe(false);
    textarea.value = "see /home/me/notes.txt";
    await vi.waitFor(() => expect(native.clipboard).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 10));
    expect(textarea.value).toBe("see /home/me/notes.txt");
    expect(onUploadFile).not.toHaveBeenCalled();
    comp.destroy?.();
  });

  it("leaves the text alone when it was edited before the files arrived", async () => {
    const { comp, onUploadFile, textarea } = mount();
    native.clipboard.mockResolvedValue([nativeFile("a.txt")]);
    paste(textarea, "/home/me/a.txt");
    textarea.value = "/home/me/X.txt";
    await vi.waitFor(() => expect(onUploadFile).toHaveBeenCalledTimes(1));
    expect(textarea.value).toBe("/home/me/X.txt");
    comp.destroy?.();
  });

  it("reads only as many dropped files as the queue has room for", async () => {
    const { comp, onUploadFile, messages } = mount();
    pointAt(messages);
    const files = Array.from({ length: 12 }, (_, i) => nativeFile(`f${i}.txt`));
    emit({ kind: "drop", x: 1, y: 1, files });
    await vi.waitFor(() => expect(onUploadFile).toHaveBeenCalledTimes(10));
    expect(files.filter((f) => f.reads > 0)).toHaveLength(10);
    expect(container.querySelector(".attachment-upload-error")?.textContent).toContain("10");
    comp.destroy?.();
  });

  it("leaves ordinary text and slash commands to the normal paste", () => {
    const { comp, textarea } = mount();
    expect(paste(textarea, "hello there").defaultPrevented).toBe(false);
    expect(paste(textarea, "/shrug").defaultPrevented).toBe(false);
    expect(native.clipboard).not.toHaveBeenCalled();
    comp.destroy?.();
  });
});

describe("looksLikeFileList", () => {
  it("accepts file URIs, absolute paths and an empty clipboard", () => {
    expect(looksLikeFileList("")).toBe(true);
    expect(looksLikeFileList("file:///home/me/a.png")).toBe(true);
    expect(looksLikeFileList("/home/me/a b.png\n/tmp/c.txt\n")).toBe(true);
  });

  it("rejects text, slash commands and mixed lines", () => {
    expect(looksLikeFileList("hello")).toBe(false);
    expect(looksLikeFileList("/giphy cats")).toBe(false);
    expect(looksLikeFileList("/home/me/a.png\nhello")).toBe(false);
    expect(looksLikeFileList("   ")).toBe(false);
  });
});
