/**
 * Desktop HTTP: the native surface behind the `HttpClient` contract — the
 * request goes out through the host's own client, so the app never has to
 * trust an unpinned TLS certificate itself.
 *
 * Lifted from `lib/api.ts`. The host client already implements the
 * Web-standard signature, so this is a pass-through: same URL, the caller's
 * init plus a redirect limit of none, same `Response` back.
 *
 * `onUploadProgress` (B11b) subscribes to the `upload-progress` event the Rust
 * HTTP proxy emits while an upload's body crosses the loopback tunnel — the
 * webview never sees those bytes, so they arrive out of band. The event API
 * is a static import here for the same reason it is in `trayStatus.ts`: it
 * already loads with the entry, so it adds nothing to startup.
 */
import { fetch } from "@tauri-apps/plugin-http";
import { listen } from "@tauri-apps/api/event";
import { createLogger } from "@lib/logger";
import type { HttpClient, UploadProgress } from "../contracts/http";

const log = createLogger("http");

/** The native client's redirect limit: none is followed. */
const NO_REDIRECTS = 0;

export const http: HttpClient = {
  // Every request through the tunnel names one route on one server and never
  // follows a redirect: a 3xx comes back to the caller as the reply itself,
  // a non-ok `Response` like any other HTTP error. Set here, the one place
  // every tunnel request passes, so no caller can leave it out.
  fetch: (url, init) => fetch(url, { ...init, maxRedirections: NO_REDIRECTS }),
  onUploadProgress(handler: (progress: UploadProgress) => void): () => void {
    let active = true;
    let unlisten: (() => void) | null = null;
    void listen<UploadProgress>("upload-progress", (event) => {
      if (active) handler(event.payload);
    })
      .then((stop) => {
        if (active) unlisten = stop;
        else stop();
      })
      .catch((err: unknown) => log.warn("upload-progress listen failed", err));
    return () => {
      active = false;
      unlisten?.();
    };
  },
};
