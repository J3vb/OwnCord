/**
 * Desktop HTTP: the native surface behind the `HttpClient` contract — the
 * request goes out through the host's own client, so the app never has to
 * trust an unpinned TLS certificate itself.
 *
 * Lifted verbatim from `lib/api.ts` (B7-4). The host client already
 * implements the Web-standard signature, so this is a pass-through and
 * nothing else: same URL, same init, same `Response` back.
 *
 * `onUploadProgress` (B11b) subscribes to the `upload-progress` event the Rust
 * HTTP proxy emits while an upload's body crosses the loopback tunnel — the
 * webview never sees those bytes, so they arrive out of band. The event API
 * is a static import here for the same reason it is in `trayStatus.ts`: it
 * already loads with the entry, so it adds nothing to startup.
 */
import { fetch } from "@tauri-apps/plugin-http";
import { listen } from "@tauri-apps/api/event";
import type { HttpClient, UploadProgress } from "../contracts/http";

export const http: HttpClient = {
  // Forwarded exactly as it arrived: a caller that passed no `init` must not
  // have one invented for it, so the native client sees the same call shape
  // it saw before this seam existed.
  fetch: (url, ...init) => fetch(url, ...init),
  onUploadProgress(handler: (progress: UploadProgress) => void): () => void {
    let active = true;
    let unlisten: (() => void) | null = null;
    void listen<UploadProgress>("upload-progress", (event) => {
      if (active) handler(event.payload);
    }).then((stop) => {
      if (active) unlisten = stop;
      else stop();
    });
    return () => {
      active = false;
      unlisten?.();
    };
  },
};
