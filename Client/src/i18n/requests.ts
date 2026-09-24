import { defineCatalog } from "./format";

/**
 * Direct-message and member-interaction copy (B9-19): the DM sidebar, the DM
 * profile panel, the user profile popup and the member picker. It loads with
 * the main page and its lazily loaded profile-popup chunk. The presence status
 * labels stay in `shell.ts`, which already owns them.
 */
export const requestsText = defineCatalog("requests", {
  "members.count": { one: "{count} member", other: "{count} members" },
  "mention.count": { one: "{n} mention", other: "{n} mentions" },
  "unread.count": { one: "{n} unread message", other: "{n} unread messages" },

  "dm.closeShort": "Close DM",
  "dm.leaveShort": "Leave group",
  "dm.mute": "Mute Conversation",
  "dm.unmute": "Unmute Conversation",
  "dm.renameGroup": "Rename Group",
  "dm.leaveGroup": "Leave Group",
  "dm.close": "Close DM",
  "dm.backTo": "Back to {server}",
  "dm.serverFallback": "Server",
  "dm.returnToChannels": "Return to channels",
  "dm.find": "Find a conversation",
  "dm.heading": "Direct Messages",
  "dm.new": "New DM",
  "dm.groupSubtitle": "{count} members: You, {names}",

  "profile.label": "User profile",
  "profile.close": "Close profile sidebar",
  "profile.about": "ABOUT ME",
  "profile.memberSince": "MEMBER SINCE",
  "profile.note": "NOTE",
  "profile.notePlaceholder": "Click to add a note",
  "profile.message": " Message",
  "profile.call": " Call",

  "picker.title": "New Direct Message",
  "picker.groupHint": "Select one member for a DM, or up to {max} for a group",
  "picker.singleHint": "Select a member to start a conversation",
  "picker.groupNamePlaceholder": "Group name (optional)",
  "picker.create": "Create DM",
  "picker.createGroup": "Create Group DM ({count})",
  "picker.cancel": "Cancel",
});
