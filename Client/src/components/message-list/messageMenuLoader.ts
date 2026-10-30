/**
 * The eager half of the message menu: one dynamic import, so the menu and its
 * copy stay out of the main-page chunk until the first right-click.
 */

import { createLogger } from "@lib/logger";

const log = createLogger("message-menu");

/** Run `use` with the loaded menu module; a failed load is logged. */
export function withMessageMenu(use: (menu: typeof import("./messageMenu")) => void): void {
  import("./messageMenu")
    .then(use)
    .catch((err: unknown) => log.warn("Message menu failed to open", { error: String(err) }));
}
