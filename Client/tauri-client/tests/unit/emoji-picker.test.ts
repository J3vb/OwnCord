import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createEmojiPicker } from "@components/EmojiPicker";
import type { EmojiPickerOptions } from "@components/EmojiPicker";

describe("EmojiPicker", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    localStorage.clear();
  });

  afterEach(() => {
    container.remove();
    localStorage.clear();
  });

  function makePicker(overrides?: Partial<EmojiPickerOptions>) {
    const options: EmojiPickerOptions = {
      onSelect: overrides?.onSelect ?? vi.fn(),
      onClose: overrides?.onClose ?? vi.fn(),
      customEmoji: overrides?.customEmoji,
    };
    const picker = createEmojiPicker(options);
    container.appendChild(picker.element);
    return { picker, options };
  }

  it("creates element with emoji-picker and open classes", () => {
    const { picker } = makePicker();
    expect(picker.element.classList.contains("emoji-picker")).toBe(true);
    expect(picker.element.classList.contains("open")).toBe(true);
    picker.destroy();
  });

  it("renders search input", () => {
    const { picker } = makePicker();
    const input = picker.element.querySelector(".ep-search") as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(input.placeholder).toBe("Search emoji...");
    picker.destroy();
  });

  it("renders category labels", () => {
    const { picker } = makePicker();
    const labels = picker.element.querySelectorAll(".ep-category-label");
    const labelTexts = Array.from(labels).map((l) => l.textContent);

    // Should have built-in categories (Smileys, People, Nature, Food, Objects, Symbols)
    // Recent is empty so should not appear
    expect(labelTexts).toContain("Smileys");
    expect(labelTexts).toContain("People");
    expect(labelTexts).toContain("Nature");
    expect(labelTexts).toContain("Food");
    expect(labelTexts).toContain("Objects");
    expect(labelTexts).toContain("Symbols");
    picker.destroy();
  });

  it("renders emoji grid with ep-emoji spans", () => {
    const { picker } = makePicker();
    const emojiSpans = picker.element.querySelectorAll(".ep-emoji");
    expect(emojiSpans.length).toBeGreaterThan(0);
    picker.destroy();
  });

  it("clicking an emoji calls onSelect", () => {
    const onSelect = vi.fn();
    const { picker } = makePicker({ onSelect });

    const firstEmoji = picker.element.querySelector(".ep-emoji") as HTMLSpanElement;
    expect(firstEmoji).not.toBeNull();
    firstEmoji.click();

    expect(onSelect).toHaveBeenCalledOnce();
    expect(typeof onSelect.mock.calls[0]![0]).toBe("string");
    picker.destroy();
  });

  it("clicking an emoji saves to recent in localStorage", () => {
    const { picker } = makePicker();

    const firstEmoji = picker.element.querySelector(".ep-emoji") as HTMLSpanElement;
    firstEmoji.click();

    const stored = localStorage.getItem("owncord:recent-emoji");
    expect(stored).not.toBeNull();
    const recent = JSON.parse(stored!);
    expect(Array.isArray(recent)).toBe(true);
    expect(recent.length).toBeGreaterThan(0);
    picker.destroy();
  });

  it("search filters emoji", () => {
    const { picker } = makePicker();

    const input = picker.element.querySelector(".ep-search") as HTMLInputElement;
    // Set a search query that won't match any emoji character
    input.value = "zzzznotanemoji";
    input.dispatchEvent(new Event("input"));

    // Should show "No emoji found" empty state
    const emptyState = picker.element.querySelector("div[style*='text-align: center']");
    expect(emptyState).not.toBeNull();
    expect(emptyState!.textContent).toBe("No emoji found");
    picker.destroy();
  });

  it("Escape key calls onClose", () => {
    const onClose = vi.fn();
    const { picker } = makePicker({ onClose });

    picker.element.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(onClose).toHaveBeenCalledOnce();
    picker.destroy();
  });

  it("renders custom emoji when provided", () => {
    const { picker } = makePicker({
      customEmoji: [
        { shortcode: "test_emoji", url: "https://example.com/emoji.png" },
      ],
    });

    const labels = picker.element.querySelectorAll(".ep-category-label");
    const labelTexts = Array.from(labels).map((l) => l.textContent);
    expect(labelTexts).toContain("Custom");
    picker.destroy();
  });

  it("renders Recent category when localStorage has recent emoji", () => {
    localStorage.setItem("owncord:recent-emoji", JSON.stringify(["😀", "😎"]));
    const { picker } = makePicker();

    const labels = picker.element.querySelectorAll(".ep-category-label");
    const labelTexts = Array.from(labels).map((l) => l.textContent);
    expect(labelTexts).toContain("Recent");
    picker.destroy();
  });

  it("destroy aborts event listeners", () => {
    const onSelect = vi.fn();
    const { picker } = makePicker({ onSelect });
    const firstEmoji = picker.element.querySelector(".ep-emoji") as HTMLSpanElement;

    picker.destroy();
    firstEmoji.click();

    expect(onSelect).not.toHaveBeenCalled();
  });
});
