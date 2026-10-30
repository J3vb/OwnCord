import { defineCatalog } from "./format";

/**
 * The startup-safe slice of the messaging journey: the message date
 * stamps, the attachment download labels and the who-reacted tooltip.
 * `lib/text/formatting.ts` is statically reachable from the entry through its many
 * callers, so its copy lives here rather than in the main-page catalog
 * `messaging.ts`, the same way `mediaControls.ts` is split from `content.ts`.
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
  "file.loadingNamed": "Loading {filename}",
  "file.openImage": "Open {filename}",
  "file.downloadHttpFailed": "Download failed: server returned {status}",
  "file.downloadFailed": "Download failed for {filename} — check logs for details",
  "file.imageFailed": "Couldn't load this image",
  "file.noPicture": "Video picture cannot be shown on this device",
  "file.cannotPlay": "Can't play this format",
  "file.retry": "Retry",
  "file.previewRegion": "Preview of {filename}",
  "file.previewExpand": "Expand",
  "file.previewCollapse": "Collapse",
  "file.lang.c": "C",
  "file.lang.config": "Config",
  "file.lang.cpp": "C++",
  "file.lang.csharp": "C#",
  "file.lang.css": "CSS",
  "file.lang.csv": "CSV",
  "file.lang.diff": "Diff",
  "file.lang.go": "Go",
  "file.lang.ini": "INI",
  "file.lang.java": "Java",
  "file.lang.javascript": "JavaScript",
  "file.lang.json": "JSON",
  "file.lang.kotlin": "Kotlin",
  "file.lang.log": "Log",
  "file.lang.lua": "Lua",
  "file.lang.markdown": "Markdown",
  "file.lang.php": "PHP",
  "file.lang.python": "Python",
  "file.lang.ruby": "Ruby",
  "file.lang.rust": "Rust",
  "file.lang.scss": "SCSS",
  "file.lang.shell": "Shell",
  "file.lang.sql": "SQL",
  "file.lang.swift": "Swift",
  "file.lang.text": "Text",
  "file.lang.toml": "TOML",
  "file.lang.tsv": "TSV",
  "file.lang.typescript": "TypeScript",
  "file.lang.yaml": "YAML",
  "file.previewLines": { one: "{count} line", other: "{count} lines" },
  "file.previewLinesMore": { one: "{count}+ line", other: "{count}+ lines" },
  "file.previewContents": "Contents of {filename}",
  "file.previewTruncated": "Showing the first {size}. Download the file to see the rest.",
  "file.previewTruncatedLines":
    "Showing the first {count} lines. Download the file to see the rest.",

  "send.requestTimeout": "The server is busy — retry in a moment",

  "reaction.reactedWith": "reacted with {emoji}",
  "reaction.others": {
    one: "{names} and {n} other",
    other: "{names} and {n} others",
  },
});
