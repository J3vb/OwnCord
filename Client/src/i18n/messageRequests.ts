import { defineCatalog } from "./format";

/** Message Requests inbox copy (B9-5). */
export const messageRequestsText = defineCatalog("messageRequests", {
  intro:
    "First messages from people you haven't accepted yet. They are shown as plain text: links, images and attachments are not loaded.",
  loading: "Loading message requests…",
  empty: "No pending message requests.",
  unavailable: "Message requests couldn't be loaded. They load again when you reconnect.",
  reconnecting: "Reconnecting. This list may be out of date.",
  listLabel: "Pending message requests",
  unknownSender: "Unknown user",
  noText: "This message has no text to preview.",
});
