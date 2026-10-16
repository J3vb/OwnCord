import { defineCatalog } from "./format";

/** The message right-click menu (message-list/message-menu.ts). Its own
 *  catalog so the copy loads with that lazy module, not at startup. The link
 *  rows, the message-link and ID toasts and Reply reuse the messaging and
 *  image-menu catalogs. */
export const messageMenuText = defineCatalog("messageMenu", {
  label: "Message actions",
  addReaction: "Add Reaction",
  reactWith: "React with {name}",
  edit: "Edit Message",
  copy: "Copy",
  copyText: "Copy Text",
  pin: "Pin Message",
  unpin: "Unpin Message",
  delete: "Delete Message",
  report: "Report Message",
  copyId: "Copy Message ID",
  copyFailed: "Couldn't copy the text",
});
