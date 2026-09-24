import { defineCatalog } from "./format";

/**
 * The startup-safe slice of the messaging journey (B9-19): the message date
 * stamps, the attachment download labels and the who-reacted tooltip. These
 * modules are statically reachable from the entry — `message-list/formatting.ts`
 * and `message-list/attachments.ts` through their many callers, and
 * `message-list/reaction-tooltip.ts` through the dispatcher's reaction_update
 * handler — so their copy lives here rather than in the main-page catalog
 * `messaging.ts`, the same way B9-9 split `mediaControls.ts` from `content.ts`.
 */
export const messageStatusText = defineCatalog("messageStatus", {
  "date.today": "Today at {time}",
  "date.yesterday": "Yesterday at {time}",

  "file.download": "Download",
  "file.downloadNamed": "Download {filename}",
  "file.downloadHttpFailed": "Download failed: server returned {status}",
  "file.downloadFailed": "Download failed for {filename} — check logs for details",

  "reaction.reactedWith": "reacted with {emoji}",
  "reaction.others": {
    one: "and {count} other",
    other: "and {count} others",
  },
});
