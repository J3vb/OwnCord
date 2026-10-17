import { defineCatalog } from "./format";

/**
 * The Settings "Privacy & Safety" tab's blocked-users list (3B-7). Apart from
 * the shell catalog so the list's copy loads with its lazy module, not with
 * the overlay. The unblock toasts reuse the shell's `members.unblocked` and
 * `members.unblockFailed`.
 */
export const blockedUsersText = defineCatalog("blockedUsers", {
  title: "Blocked users",
  desc: "People you've blocked can't message you and their messages are hidden. Unblock someone to hear from them again.",
  loading: "Loading blocked users…",
  empty: "You haven't blocked anyone.",
  loadFailed: "Couldn't load your blocked users.",
  retry: "Retry",
  unblock: "Unblock",
  unblocking: "Unblocking…",
  unblockLabel: "Unblock {name}",
  unknownUser: "Unknown user",
  chunkFailed: "Couldn't load your blocked users. Close Settings and try again.",
});
