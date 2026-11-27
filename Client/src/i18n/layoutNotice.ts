import { defineCatalog } from "./format";

/** The one-time notice shown to someone moved from Classic to Command Deck. */
export const layoutNoticeText = defineCatalog("layoutNotice", {
  "dialog.eyebrow": "New look",
  "dialog.title": "OwnCord now uses Command Deck",
  "dialog.same": "Everything works the same, it just looks different.",
  "dialog.switchBack": "Prefer the old look? Go to {path} and choose {layout}.",
  "dialog.path": "Settings › Appearance › Screen layout",
  "dialog.classic": "Classic",
  "dialog.openSettings": "Open Settings",
  "dialog.gotIt": "Got it",
  "dialog.closeLabel": "Close",
});
