import { vi } from "vitest";
import { type MessageInputOptions } from "@components/MessageInput";
import type { GifApi, GifFavoritesApi } from "@lib/media/gifProvider";

/** GIF endpoints on the user's own server (never api.klipy.com). */
export const stubGifApi: GifApi & GifFavoritesApi = {
  gifSearch: vi.fn(async () => ({ results: [] })),
  gifTrending: vi.fn(async () => ({ results: [] })),
  gifFavorites: vi.fn(async () => ({ favorites: [] })),
  addGifFavorite: vi.fn(async () => undefined),
  removeGifFavorite: vi.fn(async () => undefined),
};

export function makeOptions(overrides: Partial<MessageInputOptions> = {}): MessageInputOptions {
  return {
    channelId: 1,
    channelName: "general",
    gifApi: stubGifApi,
    onSend: vi.fn(),
    onTyping: vi.fn(),
    ...overrides,
  };
}
