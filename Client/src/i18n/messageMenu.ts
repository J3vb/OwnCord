import { defineCatalog } from "./format";

/** The message right-click menu (message-list/messageMenu.ts). Its own
 *  catalog so the copy loads with that lazy module, not at startup. The link
 *  rows, the message-link and ID toasts and Reply reuse the messaging and
 *  image-menu catalogs. */
export const messageMenuText = defineCatalog("messageMenu", {
  label: "Message actions",
  addReaction: "Add Reaction",
  edit: "Edit Message",
  forward: "Forward",
  createThread: "Create Thread",
  copy: "Copy",
  copyText: "Copy Text",
  markUnread: "Mark Unread",
  pin: "Pin Message",
  unpin: "Unpin Message",
  delete: "Delete Message",
  report: "Report Message",
  copyId: "Copy Message ID",
  quickReactions: "Quick reactions",
  copied: "Copied",
  copyFailed: "Couldn't copy the text",
});
