/**
 * Favorite GIFs — the signed-in user's saved GIFs, newest first. The server
 * is the source of truth (GET /gif/favorites), so a favorite follows the user
 * across devices. Toggling is optimistic and rolls back if the server refuses.
 *
 * The API is bound once (by whoever builds the composer) so message-list stars
 * and the GIF picker share one list without threading the client through.
 */

import { createStore } from "@lib/store";
import type { GifFavoritesApi } from "@lib/gifProvider";
import type { GifFavorite } from "@lib/types";

export interface GifFavoritesState {
  readonly favorites: readonly GifFavorite[];
}

export const gifFavoritesStore = createStore<GifFavoritesState>({ favorites: [] });

let boundApi: GifFavoritesApi | null = null;

export function resetGifFavorites(): void {
  boundApi = null;
  gifFavoritesStore.setState(() => ({ favorites: [] }));
}

/** True once an API is bound, i.e. this server session can save favorites. */
export function gifFavoritesAvailable(): boolean {
  return boundApi !== null;
}

export function isGifFavorite(url: string): boolean {
  return gifFavoritesStore.getState().favorites.some((f) => f.url === url);
}

/** Bind the API and load the list. Rebinding the same client is a no-op. */
export function bindGifFavoritesApi(api: GifFavoritesApi): void {
  if (boundApi === api) return;
  boundApi = api;
  gifFavoritesStore.setState(() => ({ favorites: [] }));
  void api
    .gifFavorites()
    .then((res) => {
      if (boundApi !== api) return;
      // Keep anything toggled on while the load was in flight.
      gifFavoritesStore.setState((prev) => ({
        favorites: [
          ...prev.favorites,
          ...res.favorites.filter((f) => !prev.favorites.some((p) => p.url === f.url)),
        ],
      }));
    })
    // A failed load leaves an empty list; the stars still work.
    .catch(() => {});
}

/** Add or remove a favorite. Resolves false (state rolled back) on failure. */
export async function toggleGifFavorite(fav: GifFavorite): Promise<boolean> {
  const api = boundApi;
  if (api === null) return false;
  const was = isGifFavorite(fav.url);
  const apply = (on: boolean): void =>
    gifFavoritesStore.setState((prev) => ({
      favorites: on
        ? [fav, ...prev.favorites.filter((f) => f.url !== fav.url)]
        : prev.favorites.filter((f) => f.url !== fav.url),
    }));
  apply(!was);
  try {
    if (was) await api.removeGifFavorite(fav.url);
    else await api.addGifFavorite(fav);
    return true;
  } catch {
    if (boundApi === api) apply(was);
    return false;
  }
}
