import { defineCatalog } from "./format";

/**
 * Custom stickers: the composer's sticker button, the tabbed
 * expression popup, the sticker picker, a sticker message in the list, and the
 * send errors. Its own catalog so the copy stays out of the shared messaging one.
 */
export const stickersText = defineCatalog("stickers", {
  "button.label": "Stickers",
  "popup.label": "GIFs, stickers and emoji",
  "tabs.label": "Expression type",
  "tab.gif": "GIFs",
  "tab.sticker": "Stickers",
  "tab.emoji": "Emoji",
  "picker.search": "Search stickers",
  "picker.searchLabel": "Search stickers by name or emoji",
  "picker.listLabel": "Stickers",
  "picker.recent": "Recent",
  "picker.all": "All stickers",
  "picker.none": "No stickers match your search",
  "picker.empty": "This server has no stickers yet",
  "picker.emptyAdminHint":
    "Add some in the server admin panel under Stickers (you have the Manage Server permission).",
  "picker.itemLabel": "Send sticker {name}",
  "message.deleted": "Deleted sticker: {name}",
  "message.alt": "Sticker: {name}",
  "reply.preview": "Sticker: {name}",
  "send.notFound": "That sticker no longer exists",
  "send.unsupported": "This server can't send stickers",
});
