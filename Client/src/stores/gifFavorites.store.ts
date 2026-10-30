/**
 * Favorite GIFs — the signed-in user's saved GIFs, newest first. The server
 * is the source of truth (GET /gif/favorites), so a favorite follows the user
 * across devices. Toggling is optimistic and rolls back if the server refuses.
 *
 * The API is bound once (by whoever builds the composer) so message-list stars
 * and the GIF picker share one list without threading the client through.
 */

import { ApiClientError } from "@lib/api";
import { createStore } from "@lib/store";
import { showToast } from "@lib/ui/toast";
import { gifFavoritesText } from "../i18n/gifFavorites";
import { registerSessionReset } from "@lib/net/sessionRegistry";
import type { GifFavoritesApi } from "@lib/media/gifProvider";
import type { GifFavorite } from "@lib/types";
import { RestErrorCode } from "@lib/protocolTypes";

export interface GifFavoritesState {
  readonly favorites: readonly GifFavorite[];
  /** The server answered 404: it predates favorites. Cleared by the next successful load. */
  readonly unsupported: boolean;
}

export const gifFavoritesStore = createStore<GifFavoritesState>({
  favorites: [],
  unsupported: false,
});

let boundApi: GifFavoritesApi | null = null;
// Bumped on reset so a slow request from a previous session cannot touch the next one.
let generation = 0;
const pending = new Set<string>();

export function resetGifFavorites(): void {
  boundApi = null;
  generation++;
  pending.clear();
  gifFavoritesStore.setState(() => ({ favorites: [], unsupported: false }));
}

// Registered at load, not from main.ts, so the store stays out of the startup
// chunk; a store that never loaded holds nothing to reset.
void registerSessionReset("gif:favorites", resetGifFavorites, { phase: "session" }); // app-lifetime: the store lives as long as the app

/** True once an API is bound, i.e. this server session can save favorites. */
export function gifFavoritesAvailable(): boolean {
  return boundApi !== null && !gifFavoritesStore.getState().unsupported;
}

export function isGifFavorite(url: string): boolean {
  return gifFavoritesStore.getState().favorites.some((f) => f.url === url);
}

/** Bind the API and load the list. Rebinding the same client is a no-op. */
export function bindGifFavoritesApi(api: GifFavoritesApi): void {
  if (boundApi === api) return;
  boundApi = api;
  const gen = generation;
  gifFavoritesStore.setState((prev) => ({ favorites: [], unsupported: prev.unsupported }));
  void api
    .gifFavorites()
    .then((res) => {
      if (gen !== generation) return;
      // Keep anything toggled on while the load was in flight.
      gifFavoritesStore.setState((prev) => ({
        unsupported: false,
        favorites: [
          ...prev.favorites,
          ...res.favorites.filter((f) => !prev.favorites.some((p) => p.url === f.url)),
        ],
      }));
    })
    // Unbind on failure so the next bind retries the load.
    .catch((err: unknown) => {
      if (gen !== generation) return;
      boundApi = null;
      if (err instanceof ApiClientError && err.status === 404) {
        gifFavoritesStore.setState((prev) => ({ ...prev, unsupported: true }));
      }
    });
}

/** Add or remove a favorite. Resolves false (state rolled back) on failure. */
export async function toggleGifFavorite(fav: GifFavorite): Promise<boolean> {
  const api = boundApi;
  if (api === null) {
    showToast(gifFavoritesText("favoriteFailed"), "error");
    return false;
  }
  if (pending.has(fav.url)) return true;
  const gen = generation;
  pending.add(fav.url);
  const index = gifFavoritesStore.getState().favorites.findIndex((f) => f.url === fav.url);
  const stored = gifFavoritesStore.getState().favorites[index];
  const was = stored !== undefined;
  const apply = (on: boolean): void =>
    gifFavoritesStore.setState((prev) => {
      const rest = prev.favorites.filter((f) => f.url !== fav.url);
      if (!on) return { ...prev, favorites: rest };
      const at = was ? Math.min(index, rest.length) : 0;
      const entry = was ? stored : fav;
      return { ...prev, favorites: [...rest.slice(0, at), entry, ...rest.slice(at)] };
    });
  apply(!was);
  try {
    if (was) await api.removeGifFavorite(fav.url);
    else await api.addGifFavorite(fav);
    return true;
  } catch (err) {
    if (gen === generation) {
      apply(was);
      const full = err instanceof ApiClientError && err.code === RestErrorCode.GIF_FAVORITES_FULL;
      showToast(gifFavoritesText(full ? "favoritesFull" : "favoriteFailed"), "error");
    }
    return false;
  } finally {
    if (gen === generation) pending.delete(fav.url);
  }
}
