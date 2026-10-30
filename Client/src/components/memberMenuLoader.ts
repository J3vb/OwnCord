/**
 * The eager half of the member menu: one dynamic import, so the menu builder
 * and its copy stay out of the main-page chunk until the first right-click.
 */

import { createLogger } from "@lib/logger";

const log = createLogger("member-menu");

/** Run `use` with the loaded menu module; a failed load is logged. */
export function withMemberMenu(use: (menu: typeof import("./AdminActions")) => void): void {
  import("./AdminActions")
    .then(use)
    .catch((err: unknown) => log.warn("Member menu failed to open", { error: String(err) }));
}
