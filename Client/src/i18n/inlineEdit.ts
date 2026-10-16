import { defineCatalog } from "./format";

/** The inline message editor (features/messaging/inlineEdit.ts). Its own catalog so
 *  the copy loads with that lazy module, not with the main page. */
export const inlineEditText = defineCatalog("inlineEdit", {
  label: "Edit message",
  "hint.escapeTo": "escape to",
  "hint.enterTo": "enter to",
  "hint.cancel": "cancel",
  "hint.save": "save",
  "hint.separator": "•",
  "error.tooLong": "Messages are limited to {max} characters",
});
