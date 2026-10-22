/**
 * Fire-and-forget prefetch of the lazy MainPage chunk (and the LiveKit voice
 * stack it statically imports). Called as soon as a login is accepted so the
 * download and parse overlap the websocket handshake instead of following it.
 *
 * The chunk stays lazy: this is a dynamic import, so MainPage is never part of
 * the startup closure. The real mount (`await import("@pages/MainPage")` in
 * main.ts) resolves from the module cache. A failed prefetch is logged and
 * dropped, because the mount re-attempts the import and owns the user-visible
 * error; it must never break login.
 */
import { createLogger } from "@lib/logger";

const log = createLogger("mainPagePrefetch");

export function prefetchMainPage(): void {
  import("@pages/MainPage").catch((err: unknown) => {
    log.warn("MainPage prefetch failed; the mount will retry", { error: String(err) });
  });
}
