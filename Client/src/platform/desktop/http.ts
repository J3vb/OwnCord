/**
 * Desktop HTTP: the native surface behind the `HttpClient` contract — the
 * request goes out through the host's own client, so the app never has to
 * trust an unpinned TLS certificate itself.
 *
 * Lifted verbatim from `lib/api.ts` (B7-4). The host client already
 * implements the Web-standard signature, so this is a pass-through and
 * nothing else: same URL, same init, same `Response` back.
 */
import { fetch } from "@tauri-apps/plugin-http";
import type { HttpClient } from "../contracts/http";

export const http: HttpClient = {
  // Forwarded exactly as it arrived: a caller that passed no `init` must not
  // have one invented for it, so the native client sees the same call shape
  // it saw before this seam existed.
  fetch: (url, ...init) => fetch(url, ...init),
};
