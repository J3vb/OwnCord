import { defineCatalog } from "./format";

/** Shared navigation copy: the destination entries and the content-view frame. */
export const navigationText = defineCatalog("navigation", {
  "requests.title": "Message Requests",
  "requests.entry": "Message Requests ({count})",
  "requests.badge": {
    one: "{count} pending message request",
    other: "{count} pending message requests",
  },
  "moderation.title": "Moderation",
  "moderation.entryHint": "Open the Moderation Center",
  "view.close": "Close {name}",
});
