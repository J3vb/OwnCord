import { defineCatalog } from "./format";

/**
 * Group DM member management copy: the member panel, the owner
 * confirm dialogs and the Add / Remove / Make Owner error texts. It loads with
 * the lazily imported panel, so it stays out of the main page chunk; the header
 * toggle's label lives in `./requests.ts` with the other eager DM copy.
 */
export const groupDmText = defineCatalog("groupDm", {
  panelLabel: "Group members",
  close: "Close member list",
  membersHeading: "Members: {count}",
  addPeople: "Add People",
  self: "{name} (you)",
  ownerBadge: "Group owner",
  moreActions: "Actions for {name}",
  removeMember: "Remove From Group",
  makeOwner: "Make Group Owner",
  removeTitle: "Remove {name} from the group?",
  removeBody:
    "{name} will be removed from {group} and won't be able to rejoin unless someone adds them back.",
  removeConfirm: "Remove",
  ownerTitle: "Make {name} the group owner?",
  ownerBody:
    "{name} will be able to remove people and hand the group on. You will no longer be the owner.",
  ownerConfirm: "Make Owner",
  cancel: "Cancel",
  "error.full": "This group is full",
  "error.cantAdd": "You can't add that person",
  "error.cantAddMissing": "That person can't be added",
  "error.notOwner": "Only the group owner can do that",
  "error.notInGroup": "That person isn't in this group anymore",
  "error.timedOut": "You're timed out and can't change this group right now",
  "error.generic": "Something went wrong. Try again.",
});
