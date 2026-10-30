import { defineCatalog } from "./format";

/** The channel media gallery panel. Its own catalog so the copy loads with
 *  the lazy panel, not with the main page. The header button's label lives
 *  in `messaging`. */
export const mediaGalleryText = defineCatalog("mediaGallery", {
  label: "Channel media",
  title: "Media",
  in: "in #{channel}",
  close: "Close media",
  "tab.media": "Media",
  "tab.files": "Files",
  "search.placeholder": "Search file names",
  "search.label": "Search file names",
  "from.label": "Posted by",
  "from.anyone": "Anyone",
  "order.label": "Sort",
  "order.newest": "Newest first",
  "order.oldest": "Oldest first",
  "months.label": "Jump to a month",
  "month.jump": "{month}, {count} items",
  "item.open": "Go to the message with {name}",
  "file.meta": "{size} · {user} · {date}",
  spoiler: "Spoiler",
  loading: "Loading…",
  loadFailed: "Couldn't load media.",
  retry: "Retry",
  "empty.media": "No photos or videos in this channel yet.",
  "empty.files": "No files in this channel yet.",
  "usage.of": "You've used {used} of {quota}",
  "usage.noLimit": "{used} used",
  "usage.manage": "Manage my uploads",
  "empty.filtered": "Nothing matches your search.",
});
