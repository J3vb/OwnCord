import { defineCatalog } from "./format";

/** The "Listening to <player>" row line (WP 8.10): member row and DM row. The
 *  profile card and the Settings section have their own, lazily loaded catalog
 *  (`listeningDetails.ts`), so they stay out of the startup closure. */
export const listeningActivityText = defineCatalog("listeningActivity", {
  listening: "Listening to {player}",
});
