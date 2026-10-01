/**
 * The Unicode emoji data is a lazy chunk: the picker and the composer's
 * `:shortcode` popup load it on first use and fill in once it resolves.
 * Vitest gives each test file its own module graph, so this one starts with
 * nothing loaded.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("@lib/livekitSession", () => ({
  leaveVoice: vi.fn(),
  switchInputDevice: vi.fn(),
  switchOutputDevice: vi.fn(),
  setVoiceSensitivity: vi.fn(),
  setInputVolume: vi.fn(),
  setOutputVolume: vi.fn(),
  getSessionDebugInfo: vi.fn().mockReturnValue({}),
}));

import { createEmojiPicker } from "@components/EmojiPicker";
import { createMessageInput } from "@components/MessageInput";
import { emojiCatalog, loadEmojiCatalog } from "../../src/features/messaging/emojiCatalog";

describe("lazy emoji data", () => {
  // One test: the file's module graph starts with nothing loaded, and the
  // first load warms it for good.
  it("the picker and the composer's popup fill in once the data resolves", async () => {
    expect(emojiCatalog()).toBeNull();

    const picker = createEmojiPicker({ onSelect: vi.fn(), onClose: vi.fn() });
    document.body.appendChild(picker.element);
    const labels = (): (string | null)[] =>
      Array.from(picker.element.querySelectorAll(".ep-category-label")).map((l) => l.textContent);

    const container = document.createElement("div");
    document.body.appendChild(container);
    const input = createMessageInput({
      channelId: 1,
      channelName: "general",
      onSend: vi.fn(),
      onTyping: vi.fn(),
      onEditMessage: vi.fn(),
    });
    input.mount(container);
    const ta = container.querySelector("textarea")!;
    ta.value = "hey :thumbsup";
    ta.selectionStart = ta.selectionEnd = ta.value.length;
    ta.dispatchEvent(new Event("input", { bubbles: true }));

    expect(picker.element.querySelector(".ep-loading")?.textContent).toBe("Loading emoji…");
    expect(labels()).not.toContain("Smileys");
    expect(container.querySelector(".emoji-autocomplete")).toBeNull();

    await loadEmojiCatalog();
    await Promise.resolve();

    expect(picker.element.querySelector(".ep-loading")).toBeNull();
    expect(labels()).toEqual(expect.arrayContaining(["Smileys", "Travel", "Flags"]));
    const buttons = Array.from(picker.element.querySelectorAll(".ep-category-btn")).map(
      (b) => b.textContent,
    );
    expect(buttons).toContain("Flags");

    const popup = container.querySelector(".emoji-autocomplete");
    expect(popup).not.toBeNull();
    expect(popup!.querySelector(".ea-preview")?.textContent).toBe("👍");

    picker.destroy();
    picker.element.remove();
    input.destroy?.();
    container.remove();
  });
});
