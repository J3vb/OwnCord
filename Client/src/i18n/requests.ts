import { defineCatalog } from "./format";

/**
 * Direct-message and member-interaction copy: the DM sidebar, the DM
 * profile panel, the user profile popup and the member picker. It loads with
 * the main page and its lazily loaded profile-popup chunk. The presence status
 * labels stay in `shell.ts`, which already owns them.
 */
export const requestsText = defineCatalog("requests", {
  "members.count": "{count} members",
  "mention.count": { one: "{n} mention", other: "{n} mentions" },
  "unread.count": { one: "{n} unread message", other: "{n} unread messages" },

  "dm.closeShort": "Close DM",
  "dm.leaveShort": "Leave group",
  "dm.mute": "Mute Conversation",
  "dm.unmute": "Unmute Conversation",
  "dm.markRead": "Mark As Read",
  "dm.profile": "Profile",
  "dm.call": "Call",
  "dm.renameGroup": "Rename Group",
  "dm.changeGroupIcon": "Change Group Icon",
  "dm.removeGroupIcon": "Remove Group Icon",
  "dm.leaveGroup": "Leave Group",
  "dm.close": "Close DM",
  "dm.leaveConfirmTitle": "Leave this group?",
  "dm.leaveConfirmBody": "You leave {name}. You won't be able to rejoin this group.",
  "dm.leaveConfirmBodyRejoin":
    "You leave {name}. You won't be able to rejoin unless someone adds you back.",
  "dm.leaveConfirm": "Leave Group",
  "dm.backTo": "Back to {server}",
  "dm.serverFallback": "Server",
  "dm.returnToChannels": "Return to channels",
  "dm.find": "Find a conversation",
  "dm.heading": "Direct Messages",
  "dm.new": "New DM",
  "dm.empty": "No direct messages yet",
  "dm.emptyStart": "Start one",
  "dm.showProfile": "Show User Profile",
  "dm.groupSubtitle": "{count} members: You, {names}",

  "profile.label": "User profile",
  "profile.close": "Close profile sidebar",
  "profile.about": "ABOUT ME",
  "profile.role.change": "Change role: {role}",
  "profile.role.menu": "Roles for {name}",
  "profile.role.list": "Roles",
  "profile.role.remove": "Remove role {role}",
  "profile.role.add": "Add a role",
  "profile.memberSince": "MEMBER SINCE",
  "profile.note": "NOTE",
  "profile.notePlaceholder": "Click to add a note",
  "profile.noteNotSaved": "Note not saved",
  "profile.message": " Message",
  "profile.call": " Call",
  "profile.offlineReason": "You are not connected to the server right now.",
  "profile.blockedReason":
    "You can't message or call someone while either of you has blocked the other.",

  "picker.title": "New Direct Message",
  "picker.groupHint": "Select one member for a DM, or up to {max} for a group",
  "picker.singleHint": "Select a member to start a conversation",
  "picker.groupNamePlaceholder": "Group name (optional)",
  "picker.create": "Create DM",
  "picker.createGroup": "Create Group DM ({count})",
  "picker.cancel": "Cancel",
  "picker.searchPlaceholder": "Search for people",
  "picker.searchLabel": "Search for people",
  "picker.noMatches": "No one matches",
  "picker.removeChip": "Remove {name}",
  "picker.addTitle": "Add People",
  "picker.addHint": "Select up to {max} more people to add to this group",
  "picker.add": "Add",

  "group.showMembers": "Show Member List",
});
