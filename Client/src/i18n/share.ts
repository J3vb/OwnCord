import { defineCatalog } from "./format";

/** The "Send to" sheet for shares from other apps (features/share/SharePicker.ts).
 *  Its own catalog so the copy loads with that lazy module, not with the main page. */
export const shareText = defineCatalog("share", {
  title: "Send to",
  files: { one: "{count} file", other: "{count} files" },
  "search.label": "Search channels and direct messages",
  "search.placeholder": "Search channels and DMs",
  "list.label": "Where to send it",
  "list.empty": "No matching channels or DMs",
});
