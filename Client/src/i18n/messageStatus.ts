import { defineCatalog } from "./format";

/**
 * The startup-safe slice of the messaging journey (B9-19): the message date
 * stamps, the attachment download labels and the who-reacted tooltip.
 * `lib/formatting.ts` is statically reachable from the entry through its many
 * callers, so its copy lives here rather than in the main-page catalog
 * `messaging.ts`, the same way B9-9 split `mediaControls.ts` from `content.ts`.
 *
 * `message-list/attachments.ts` and `message-list/reaction-tooltip.ts` are no
 * longer in the entry's static closure. Attachments used to be pulled in
 * through `lib/notifications.ts` → `lib/avatar.ts`, which no longer imports it;
 * it is now reached only from components and pages. The tooltip used to be
 * pulled in through the dispatcher's `reaction_update` handler, which now
 * imports `features/messaging/reactionUsers.ts` instead; it is reached only
 * from the lazy MainPage chunk (message-list renderers → reactions →
 * reaction-tooltip). Their copy stays here because it already was.
 */
export const messageStatusText = defineCatalog("messageStatus", {
  "date.today": "Today at {time}",
  "date.yesterday": "Yesterday at {time}",

  "file.download": "Download",
  "file.downloadNamed": "Download {filename}",
  "file.playNamed": "Play {filename}",
  "file.downloadHttpFailed": "Download failed: server returned {status}",
  "file.downloadFailed": "Download failed for {filename} — check logs for details",
  "file.imageFailed": "Couldn't load this image",
  "file.retry": "Retry",

  "reaction.reactedWith": "reacted with {emoji}",
  "reaction.others": {
    one: "{names} and {n} other",
    other: "{names} and {n} others",
  },
});
