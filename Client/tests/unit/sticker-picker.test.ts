import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@components/message-list/sticker", () => ({ loadStickerImage: vi.fn() }));

import { createStickerPicker, stickerMatches } from "@components/StickerPicker";
import { addRecentSticker, getRecentStickerIds } from "@components/stickerRecent";
import { stickersStore, setStickers, clearStickers } from "@stores/stickers.store";

const SET = [
  { id: 1, name: "Wave", emoji: "👋", url: "/api/v1/stickers/1/image" },
  { id: 2, name: "Party Blob", emoji: ":party:", url: "/api/v1/stickers/2/image" },
  { id: 3, name: "Sleepy", emoji: null, url: "/api/v1/stickers/3/image" },
];

function load(list = SET): void {
  setStickers(list);
  stickersStore.flush();
}

describe("StickerPicker", () => {
  let container: HTMLDivElement;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    localStorage.clear();
    clearStickers();
    stickersStore.flush();
  });
  afterEach(() => {
    container.remove();
    localStorage.clear();
  });

  function make(overrides: { canManage?: boolean } = {}) {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    const picker = createStickerPicker({
      canManage: overrides.canManage ?? false,
      onSelect,
      onClose,
    });
    container.appendChild(picker.element);
    return { picker, onSelect, onClose };
  }
  const cells = (root: HTMLElement, grid = "sticker-all"): HTMLElement[] =>
    Array.from(root.querySelectorAll<HTMLElement>(`[data-testid="${grid}"] .sp-item`));
  const search = (root: HTMLElement, text: string): void => {
    const input = root.querySelector<HTMLInputElement>(".sp-search")!;
    input.value = text;
    input.dispatchEvent(new Event("input"));
  };

  it("renders a cell per sticker with the name as alt text", () => {
    load();
    const { picker } = make();
    expect(cells(picker.element).map((c) => c.dataset["stickerId"])).toEqual(["1", "2", "3"]);
    expect(cells(picker.element)[0]!.querySelector("img")!.alt).toBe("Wave");
    picker.destroy();
  });

  it("shows the empty state, with the admin hint only for MANAGE_SERVER", () => {
    const plain = make();
    expect(plain.picker.element.textContent).toContain("This server has no stickers yet");
    expect(plain.picker.element.querySelector('[data-testid="sticker-empty-hint"]')).toBeNull();
    plain.picker.destroy();
    plain.picker.element.remove();

    const admin = make({ canManage: true });
    expect(admin.picker.element.querySelector('[data-testid="sticker-empty-hint"]')).not.toBeNull();
    admin.picker.destroy();
  });

  it("searches by name and by related emoji", () => {
    load();
    const { picker } = make();
    search(picker.element, "blob");
    expect(cells(picker.element).map((c) => c.dataset["stickerId"])).toEqual(["2"]);
    search(picker.element, "👋");
    expect(cells(picker.element).map((c) => c.dataset["stickerId"])).toEqual(["1"]);
    search(picker.element, "zzz");
    expect(picker.element.querySelector('[data-testid="sticker-no-match"]')).not.toBeNull();
    picker.destroy();
  });

  it("stickerMatches ignores case and surrounding space", () => {
    expect(stickerMatches(SET[1]!, "  PARTY ")).toBe(true);
    expect(stickerMatches(SET[2]!, "wave")).toBe(false);
  });

  it("picking sends the sticker, remembers it and offers it in Recent next time", () => {
    load();
    const first = make();
    cells(first.picker.element)[1]!.click();
    expect(first.onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ id: 2, name: "Party Blob" }),
    );
    expect(getRecentStickerIds()).toEqual([2]);
    first.picker.destroy();
    first.picker.element.remove();

    const second = make();
    expect(
      cells(second.picker.element, "sticker-recent").map((c) => c.dataset["stickerId"]),
    ).toEqual(["2"]);
    second.picker.destroy();
  });

  it("Recent drops ids the server no longer has and survives broken storage", () => {
    load();
    addRecentSticker(99);
    addRecentSticker(3);
    const { picker } = make();
    expect(cells(picker.element, "sticker-recent").map((c) => c.dataset["stickerId"])).toEqual([
      "3",
    ]);
    picker.destroy();

    const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(getRecentStickerIds()).toEqual([]);
    spy.mockRestore();
  });

  it("Recent is scoped to the signed-in user and server", () => {
    addRecentSticker(1);
    const keys = Object.keys(localStorage).filter((k) => k.startsWith("owncord:recent-stickers:"));
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^owncord:recent-stickers:\d+:/);
  });

  it("Enter that commits an IME candidate in the search box picks nothing", () => {
    load();
    const { picker, onSelect } = make();
    search(picker.element, "sleep");
    picker.element.querySelector(".sp-search")!.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        isComposing: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(onSelect).not.toHaveBeenCalled();
    picker.destroy();
  });

  it("Enter in the search box picks the first match", () => {
    load();
    const { picker, onSelect } = make();
    search(picker.element, "sleep");
    picker.element
      .querySelector(".sp-search")!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 3 }));
    picker.destroy();
  });

  it("Escape asks to close", () => {
    load();
    const { picker, onClose } = make();
    picker.element.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(onClose).toHaveBeenCalled();
    picker.destroy();
  });

  it("a sticker deleted by sticker_update while open disappears from the grid", () => {
    load();
    const { picker, onSelect } = make();
    const stale = cells(picker.element)[1]!;
    setStickers([SET[0]!, SET[2]!]);
    stickersStore.flush();
    expect(cells(picker.element).map((c) => c.dataset["stickerId"])).toEqual(["1", "3"]);
    // A click that raced the update on the old cell sends nothing.
    stale.click();
    expect(onSelect).not.toHaveBeenCalled();
    picker.destroy();
  });

  it("goes to the empty state when the last sticker is deleted", () => {
    load();
    const { picker } = make();
    setStickers([]);
    stickersStore.flush();
    expect(picker.element.querySelector('[data-testid="sticker-empty"]')).not.toBeNull();
    picker.destroy();
  });
});
