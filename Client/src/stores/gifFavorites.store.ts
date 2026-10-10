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
// Bumped on reset so a slow request from a previous session cannot touch the next one.
let generation = 0;
const pending = new Set<string>();

export function resetGifFavorites(): void {
  boundApi = null;
  generation++;
  pending.clear();
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
  const gen = generation;
  gifFavoritesStore.setState(() => ({ favorites: [] }));
  void api
    .gifFavorites()
    .then((res) => {
      if (gen !== generation) return;
      // Keep anything toggled on while the load was in flight.
      gifFavoritesStore.setState((prev) => ({
        favorites: [
          ...prev.favorites,
          ...res.favorites.filter((f) => !prev.favorites.some((p) => p.url === f.url)),
        ],
      }));
    })
    // Unbind on failure so the next bind retries the load.
    .catch(() => {
      if (gen === generation) boundApi = null;
    });
}

/** Add or remove a favorite. Resolves false (state rolled back) on failure. */
export async function toggleGifFavorite(fav: GifFavorite): Promise<boolean> {
  const api = boundApi;
  if (api === null) return false;
  if (pending.has(fav.url)) return true;
  const gen = generation;
  pending.add(fav.url);
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
    if (gen === generation) apply(was);
    return false;
  } finally {
    if (gen === generation) pending.delete(fav.url);
  }
}
