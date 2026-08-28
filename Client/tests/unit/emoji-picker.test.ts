import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createEmojiPicker } from "@components/EmojiPicker";
import type { EmojiPickerOptions } from "@components/EmojiPicker";
import { emojiStore, setCustomEmoji, clearCustomEmoji } from "@stores/emoji.store";

describe("EmojiPicker", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    localStorage.clear();
    clearCustomEmoji();
    emojiStore.flush();
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

  it("renders custom emoji under a Server category", () => {
    const { picker } = makePicker({
      customEmoji: [{ shortcode: "test_emoji", url: "/api/v1/emoji/1/image" }],
    });

    const labels = picker.element.querySelectorAll(".ep-category-label");
    const labelTexts = Array.from(labels).map((l) => l.textContent);
    expect(labelTexts).toContain("Server");
    picker.destroy();
  });

  it("shows no Server category when the server has no custom emoji", () => {
    const { picker } = makePicker();
    const labelTexts = Array.from(picker.element.querySelectorAll(".ep-category-label")).map(
      (l) => l.textContent,
    );
    expect(labelTexts).not.toContain("Server");
    picker.destroy();
  });

  it("renders a resolvable custom emoji as an image, not as its token text", () => {
    setCustomEmoji([{ id: 1, shortcode: "test_emoji", url: "/api/v1/emoji/1/image" }]);
    emojiStore.flush();
    const { picker } = makePicker({
      customEmoji: [{ shortcode: "test_emoji", url: "/api/v1/emoji/1/image" }],
    });

    const cell = picker.element.querySelector(".ep-emoji-custom");
    expect(cell).not.toBeNull();
    expect(cell?.querySelector("img.custom-emoji")?.getAttribute("data-shortcode")).toBe(
      "test_emoji",
    );
    expect(cell?.textContent).toBe("");
    picker.destroy();
  });

  it("selecting a custom emoji inserts its :shortcode: token", () => {
    setCustomEmoji([{ id: 1, shortcode: "test_emoji", url: "/api/v1/emoji/1/image" }]);
    emojiStore.flush();
    const onSelect = vi.fn();
    const { picker } = makePicker({
      onSelect,
      customEmoji: [{ shortcode: "test_emoji", url: "/api/v1/emoji/1/image" }],
    });

    (picker.element.querySelector(".ep-emoji-custom") as HTMLElement).click();
    expect(onSelect).toHaveBeenCalledWith(":test_emoji:");
    picker.destroy();
  });

  it("falls back to the token text when the shortcode does not resolve", () => {
    clearCustomEmoji();
    emojiStore.flush();
    const { picker } = makePicker({
      customEmoji: [{ shortcode: "ghost_emoji", url: "/api/v1/emoji/9/image" }],
    });

    const cells = Array.from(picker.element.querySelectorAll(".ep-emoji"));
    const ghost = cells.find((c) => c.textContent === ":ghost_emoji:");
    expect(ghost).toBeDefined();
    expect(ghost?.querySelector("img")).toBeNull();
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

  it("marks the scrollable results area as a listbox named Emoji", () => {
    const { picker } = makePicker();
    const listbox = picker.element.querySelector("[role='listbox']");
    expect(listbox).not.toBeNull();
    expect(listbox!.getAttribute("aria-label")).toBe("Emoji");
    picker.destroy();
  });

  it("gives every cell role=option with an aria-label mirroring its title", () => {
    const { picker } = makePicker();
    const cells = Array.from(picker.element.querySelectorAll(".ep-emoji"));
    expect(cells.length).toBeGreaterThan(0);
    for (const cell of cells) {
      expect(cell.getAttribute("role")).toBe("option");
      expect(cell.getAttribute("aria-label")).toBe(cell.getAttribute("title"));
    }
    picker.destroy();
  });

  it("makes exactly one cell tabbable (roving tabindex)", () => {
    const { picker } = makePicker();
    const cells = Array.from(picker.element.querySelectorAll(".ep-emoji"));
    const tabbable = cells.filter((c) => c.getAttribute("tabindex") === "0");
    expect(tabbable.length).toBe(1);
    expect(tabbable[0]).toBe(cells[0]);
    expect(cells.slice(1).every((c) => c.getAttribute("tabindex") === "-1")).toBe(true);
    picker.destroy();
  });

  it("re-applies the roving tabindex when search replaces the cells", () => {
    const { picker } = makePicker();
    const input = picker.element.querySelector(".ep-search") as HTMLInputElement;
    input.value = "fire";
    input.dispatchEvent(new Event("input"));

    const cells = Array.from(picker.element.querySelectorAll(".ep-emoji"));
    expect(cells.length).toBeGreaterThan(0);
    const tabbable = cells.filter((c) => c.getAttribute("tabindex") === "0");
    expect(tabbable.length).toBe(1);
    expect(tabbable[0]).toBe(cells[0]);
    picker.destroy();
  });

  it("ArrowRight moves focus and the tabbable cell to the next emoji", () => {
    const { picker } = makePicker();
    const cells = picker.element.querySelectorAll(".ep-emoji") as NodeListOf<HTMLElement>;
    expect(cells.length).toBeGreaterThan(1);

    cells[0]!.focus();
    cells[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));

    expect(document.activeElement).toBe(cells[1]);
    expect(cells[0]!.getAttribute("tabindex")).toBe("-1");
    expect(cells[1]!.getAttribute("tabindex")).toBe("0");
    picker.destroy();
  });

  it("Enter on a focused cell fires the same onSelect as click", () => {
    const onSelect = vi.fn();
    const { picker } = makePicker({ onSelect });
    const firstEmoji = picker.element.querySelector(".ep-emoji") as HTMLElement;

    firstEmoji.focus();
    firstEmoji.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    expect(onSelect).toHaveBeenCalledOnce();
    expect(onSelect).toHaveBeenCalledWith(firstEmoji.getAttribute("title"));
    picker.destroy();
  });

  it("Space on a focused cell fires the same onSelect as click", () => {
    const onSelect = vi.fn();
    const { picker } = makePicker({ onSelect });
    const firstEmoji = picker.element.querySelector(".ep-emoji") as HTMLElement;

    firstEmoji.focus();
    firstEmoji.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));

    expect(onSelect).toHaveBeenCalledOnce();
    expect(onSelect).toHaveBeenCalledWith(firstEmoji.getAttribute("title"));
    picker.destroy();
  });

  // OC-0306: every cell's click listener used to be registered directly on
  // the span against the picker-lifetime AbortSignal (aborted only in
  // destroy()). renderAllCategories() discards and rebuilds the whole grid
  // on every search keystroke, so a discarded span's own listener was never
  // released — it stayed live (and reachable via the signal's abort-listener
  // list) for the rest of the picker's life. A fixed, delegated listener on
  // the container means a stale span dispatched at directly must no longer
  // reach the handler once a rebuild has discarded it.
  it("does not leave a discarded cell's click listener live after a search rebuild", () => {
    const onSelect = vi.fn();
    const { picker } = makePicker({ onSelect });
    const firstEmoji = picker.element.querySelector(".ep-emoji") as HTMLSpanElement;
    expect(firstEmoji).not.toBeNull();

    // Sanity: the live cell's listener does fire.
    firstEmoji.click();
    expect(onSelect).toHaveBeenCalledTimes(1);
    onSelect.mockClear();

    // Any search keystroke fully discards and rebuilds the cell set, even
    // when the same emoji still matches — renderAllCategories always calls
    // clearChildren() first.
    const input = picker.element.querySelector(".ep-search") as HTMLInputElement;
    input.value = "fire";
    input.dispatchEvent(new Event("input"));
    expect(picker.element.contains(firstEmoji)).toBe(false);

    // Dispatching directly on the stale, detached span must not still reach
    // the handler it closed over.
    firstEmoji.dispatchEvent(new MouseEvent("click"));
    expect(onSelect).not.toHaveBeenCalled();

    picker.destroy();
  });

  // OC-0308: Recent is fed any selection, including `:shortcode:` tokens
  // that are only meaningful on the server that defined them (or that have
  // since been deleted). An entry that can no longer resolve must not be
  // offered back out of Recent — clicking it would insert (or re-react
  // with) dead literal text.
  it("drops unresolvable :shortcode: entries from Recent", () => {
    localStorage.setItem("owncord:recent-emoji", JSON.stringify([":blobwave:", "😀"]));
    clearCustomEmoji();
    emojiStore.flush();

    const { picker } = makePicker();
    const recentLabel = Array.from(picker.element.querySelectorAll(".ep-category-label")).find(
      (l) => l.textContent === "Recent",
    );
    expect(recentLabel).not.toBeUndefined();
    const grid = recentLabel!.nextElementSibling as HTMLElement;
    const cellTitles = Array.from(grid.querySelectorAll(".ep-emoji")).map((c) =>
      c.getAttribute("title"),
    );

    expect(cellTitles).not.toContain(":blobwave:");
    expect(cellTitles).toContain("😀");
    picker.destroy();
  });
});
