// 3A-10a: the composer's slash commands — the rewrite in handleSend and the
// "/" suggestion popup (shared inline-autocomplete machinery).
import { describe, it, expect, vi, beforeEach } from "vitest";
import { useMountContainer } from "../helpers/mountContainer";

vi.mock("@components/EmojiPicker", () => ({
  createEmojiPicker: () => ({ element: document.createElement("div"), destroy: vi.fn() }),
}));
vi.mock("@components/GifPicker", () => ({
  createGifPicker: () => ({ element: document.createElement("div"), destroy: vi.fn() }),
}));

import { createMessageInput, type MessageInputOptions } from "@components/MessageInput";

describe("composer slash commands (3A-10a)", () => {
  let container: HTMLDivElement;
  let input: ReturnType<typeof createMessageInput>;
  let onSend: ReturnType<typeof vi.fn<MessageInputOptions["onSend"]>>;

  const textarea = (): HTMLTextAreaElement =>
    container.querySelector(".msg-textarea") as HTMLTextAreaElement;
  const popup = (): HTMLElement | null => container.querySelector(".slash-autocomplete");
  const names = (): string[] =>
    [...container.querySelectorAll(".slash-autocomplete .ma-name")].map((n) => n.textContent ?? "");
  const type = (text: string): void => {
    textarea().value = text;
    textarea().selectionStart = text.length;
    textarea().selectionEnd = text.length;
    textarea().dispatchEvent(new Event("input", { bubbles: true }));
  };
  const press = (key: string): void => {
    textarea().dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
    );
  };

  useMountContainer(
    (c) => {
      container = c;
    },
    () => input.destroy?.(),
  );

  beforeEach(() => {
    onSend = vi.fn<MessageInputOptions["onSend"]>();
    input = createMessageInput({
      channelId: 1,
      channelName: "general",
      onSend,
      onTyping: vi.fn(),
    });
    input.mount(container);
  });

  describe("sending", () => {
    it("sends /shrug text with the escaped emoticon", () => {
      type("/shrug hi");
      press("Enter");
      expect(onSend).toHaveBeenCalledTimes(1);
      expect(onSend.mock.calls[0]![0]).toBe("hi ¯\\\\\\_(ツ)\\_/¯");
      expect(textarea().value).toBe("");
    });

    it("sends /me as italic", () => {
      type("/me waves");
      press("Enter");
      expect(onSend.mock.calls[0]![0]).toBe("_waves_");
    });

    it("does not send a bare /me or /spoiler and keeps the draft", () => {
      type("/me");
      // The popup owns Enter while it is open; close it to reach the send path.
      press("Escape");
      press("Enter");
      expect(onSend).not.toHaveBeenCalled();
      expect(textarea().value).toBe("/me");

      type("/spoiler ");
      press("Enter");
      expect(onSend).not.toHaveBeenCalled();
      expect(textarea().value).toBe("/spoiler ");
    });

    it("sends an unknown /word unchanged but rewrites a known command", () => {
      type("/foo bar");
      press("Enter");
      expect(onSend.mock.calls[0]![0]).toBe("/foo bar");
    });

    it("rewrites a known command where an unknown one is left alone", () => {
      type("/me bar");
      press("Enter");
      expect(onSend.mock.calls[0]![0]).toBe("_bar_");
    });

    it("hints when a bare /me or /spoiler has nothing to send", () => {
      type("/spoiler ");
      press("Enter");
      expect(onSend).not.toHaveBeenCalled();
      expect(container.querySelector(".attachment-upload-error-text")!.textContent).toBe(
        "/spoiler needs some text",
      );
    });

    it("sends nothing and hints for a bare /me with an attachment staged", async () => {
      input.destroy?.();
      container.replaceChildren();
      input = createMessageInput({
        channelId: 1,
        channelName: "general",
        onSend,
        onTyping: vi.fn(),
        onUploadFile: vi.fn(async (f: File) => ({ id: f.name, url: "http://x", filename: f.name })),
      });
      input.mount(container);
      const file = new File(["x"], "a.txt", { type: "text/plain" });
      const fileInput = container.querySelector("input[type=file]") as HTMLInputElement;
      Object.defineProperty(fileInput, "files", { value: [file], configurable: true });
      fileInput.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 0));
      expect(
        container.querySelector(".attachment-preview-item, .attachment-preview"),
      ).not.toBeNull();
      type("/me");
      press("Escape");
      press("Enter");
      expect(onSend).not.toHaveBeenCalled();
      expect(container.querySelector(".attachment-upload-error-text")!.textContent).toBe(
        "/me needs some text",
      );
    });
  });

  describe("popup", () => {
    it("opens on / with every command and its description", () => {
      type("/");
      expect(popup()).not.toBeNull();
      expect(names()).toEqual(["/shrug", "/tableflip", "/unflip", "/spoiler", "/me"]);
      expect(popup()!.querySelector(".ma-detail")!.textContent).toContain("to your message");
      expect(popup()!.getAttribute("role")).toBe("listbox");
      expect(popup()!.getAttribute("aria-label")).toBe("Commands");
      expect(popup()!.querySelector("[role=option]")).not.toBeNull();
      expect(textarea().getAttribute("aria-activedescendant")).toBe("slash-autocomplete-option-0");
    });

    it("filters as letters are typed and closes on no match or a space", () => {
      type("/s");
      expect(names()).toEqual(["/shrug", "/spoiler"]);
      type("/SPO");
      expect(names()).toEqual(["/spoiler"]);
      type("/x");
      expect(popup()).toBeNull();
      type("/shrug ");
      expect(popup()).toBeNull();
      type("hello /s");
      expect(popup()).toBeNull();
    });

    it("picks with the arrow keys and Enter, inserting '/name ' without sending", () => {
      type("/");
      press("ArrowDown");
      press("ArrowDown");
      press("Enter");
      expect(textarea().value).toBe("/unflip ");
      expect(popup()).toBeNull();
      expect(onSend).not.toHaveBeenCalled();
    });

    it("ignores keys while an IME is composing", () => {
      type("/");
      textarea().dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true }),
      );
      textarea().dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", keyCode: 229, bubbles: true }),
      );
      expect(textarea().value).toBe("/");
      expect(popup()).not.toBeNull();
      expect(onSend).not.toHaveBeenCalled();
    });

    it("picks with Tab and by mouse", () => {
      type("/ta");
      press("Tab");
      expect(textarea().value).toBe("/tableflip ");
      type("/");
      container
        .querySelector("[data-testid='slash-option-me']")!
        .dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      expect(textarea().value).toBe("/me ");
    });

    it("closes on Escape, leaving the draft, and drops combobox state", () => {
      type("/sh");
      press("Escape");
      expect(popup()).toBeNull();
      expect(textarea().value).toBe("/sh");
      expect(textarea().hasAttribute("aria-activedescendant")).toBe(false);
    });
  });
});
