import { defineCatalog } from "./format";

/** Message Requests inbox copy (B9-5) and its decisions (B9-6). */
export const messageRequestsText = defineCatalog("messageRequests", {
  intro:
    "First messages from people you haven't accepted yet. They are shown as plain text: links, images and attachments are not loaded.",
  decisionsHelp:
    "Accept trusts the sender on this server and opens your conversation with them. Ignore and Delete remove the request without telling the sender.",
  loading: "Loading message requests…",
  empty: "No pending message requests.",
  unavailable: "Message requests couldn't be loaded. They load again when you reconnect.",
  reconnecting: "Reconnecting. This list may be out of date.",
  listLabel: "Pending message requests",
  unknownSender: "Unknown user",
  noText: "This message has no text to preview.",
  "actions.label": "Request from {name}",
  "action.accept": "Accept",
  "action.ignore": "Ignore",
  "action.delete": "Delete…",
  "action.block": "Block…",
  "working.accept": "Accepting…",
  "working.ignore": "Ignoring…",
  "working.delete": "Deleting…",
  "working.block": "Blocking…",
  "done.accept": "Accepted {name}'s request. Opening your conversation…",
  "done.ignore": "Ignored {name}'s request.",
  "done.delete": "Deleted {name}'s request.",
  "done.block": "Blocked {name} and removed their request.",
  stale: "{name}'s request was already handled, perhaps on another device. The list was refreshed.",
  failed:
    "Your choice for {name}'s request didn't go through. Check your connection and try again.",
  "confirm.cancel": "Cancel",
  "confirm.delete.title": "Delete this request?",
  "confirm.delete.body": "The request from {name} is removed from your inbox. {name} is not told.",
  "confirm.delete.confirm": "Delete request",
  "confirm.block.title": "Block {name}?",
  "confirm.block.body":
    "{name} can no longer message you on this server, and this request is removed. They are not told now, but if they message you again they will see it wasn't sent. You can unblock them later.",
  "confirm.block.confirm": "Block",
});
