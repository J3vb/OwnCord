import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMessageInput } from "@components/MessageInput";
import { wantsNativeMenu } from "@lib/dom";
import type { GifApi, GifFavoritesApi } from "@lib/media/gifProvider";

const gifApi: GifApi & GifFavoritesApi = {
  gifSearch: vi.fn(async () => ({ results: [] })),
  gifTrending: vi.fn(async () => ({ results: [] })),
  gifFavorites: vi.fn(async () => ({ favorites: [] })),
  addGifFavorite: vi.fn(async () => undefined),
  removeGifFavorite: vi.fn(async () => undefined),
};

describe("composer spelling menu", () => {
  let container: HTMLDivElement;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });
  afterEach(() => container.remove());

  it("composer textarea keeps the native menu and spellcheck", () => {
    const input = createMessageInput({
      channelId: 1,
      channelName: "general",
      gifApi,
      onSend: vi.fn(),
      onTyping: vi.fn(),
    });
    input.mount(container);
    const area = container.querySelector<HTMLTextAreaElement>(".msg-textarea")!;
    // The webview's own menu is where the spelling suggestions live: main.ts
    // leaves it on for exactly the targets wantsNativeMenu accepts.
    expect(wantsNativeMenu(area)).toBe(true);
    // Spell checking is on by default; only "false" (or "off") turns it off.
    expect([null, "", "true"]).toContain(area.getAttribute("spellcheck"));
    input.destroy?.();
  });
});
