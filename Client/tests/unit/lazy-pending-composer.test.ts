/**
 * The composer's emoji and GIF pickers load on first use (O-6a). These tests
 * act inside the load window: each trigger runs before the pending import has
 * resolved, so what they check is what happens to a click that lands mid-load.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@components/EmojiPicker", () => ({
  createEmojiPicker: () => {
    const element = document.createElement("div");
    element.classList.add("emoji-picker");
    return { element, destroy: vi.fn() };
  },
}));
vi.mock("@components/GifPicker", () => ({
  createGifPicker: () => {
    const element = document.createElement("div");
    element.classList.add("gif-picker");
    return { element, destroy: vi.fn() };
  },
}));

import { createMessageInput, type MessageInputOptions } from "@components/MessageInput";
import type { GifApi, GifFavoritesApi } from "@lib/media/gifProvider";

const gifApi: GifApi & GifFavoritesApi = {
  gifSearch: vi.fn(async () => ({ results: [] })),
  gifTrending: vi.fn(async () => ({ results: [] })),
  gifFavorites: vi.fn(async () => ({ favorites: [] })),
  addGifFavorite: vi.fn(async () => undefined),
  removeGifFavorite: vi.fn(async () => undefined),
};

function options(): MessageInputOptions {
  return { channelId: 1, channelName: "general", gifApi, onSend: vi.fn(), onTyping: vi.fn() };
}

describe("composer pickers during their load", () => {
  let container: HTMLDivElement;
  let comp: ReturnType<typeof createMessageInput>;
  const emojiBtn = (): HTMLElement => container.querySelector(".emoji-btn")!;
  const gifBtn = (): HTMLElement => container.querySelector(".gif-btn")!;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    comp = createMessageInput(options());
    comp.mount(container);
  });
  afterEach(() => {
    comp.destroy?.();
    container.remove();
  });

  it("a second emoji toggle before the code arrives mounts nothing", async () => {
    emojiBtn().click();
    emojiBtn().click();
    await vi.dynamicImportSettled();
    expect(container.querySelector(".emoji-picker")).toBeNull();
    // The toggle is not stuck: a later click opens it.
    emojiBtn().click();
    await vi.dynamicImportSettled();
    expect(container.querySelectorAll(".emoji-picker")).toHaveLength(1);
  });

  it("emoji then GIF before the code arrives ends with only the GIF picker", async () => {
    emojiBtn().click();
    gifBtn().click();
    await vi.dynamicImportSettled();
    expect(container.querySelector(".emoji-picker")).toBeNull();
    expect(container.querySelectorAll(".gif-picker")).toHaveLength(1);
  });

  it("destroying the composer during the load mounts nothing", async () => {
    emojiBtn().click();
    gifBtn().click();
    comp.destroy?.();
    await vi.dynamicImportSettled();
    expect(document.querySelector(".emoji-picker, .gif-picker")).toBeNull();
  });
});
