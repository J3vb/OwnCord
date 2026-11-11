import type { GifApi, GifFavoritesApi } from "@lib/media/gifProvider";

export interface GifPickerOptions {
  /** GIF endpoints on the user's own server. */
  readonly api: GifApi & GifFavoritesApi;
  readonly onSelect: (gifUrl: string) => void;
  readonly onClose: () => void;
  /**
   * Called when the server reports GIFs are not configured (503 GIF_DISABLED).
   * The caller uses this to disable its GIF affordance so the user is not
   * offered a feature this server does not have.
   */
  readonly onUnavailable?: (reason: string) => void;
}
