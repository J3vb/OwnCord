import { defineCatalog } from "./format";

/** The People view: DM mode's home, listing the server's members. */
export const peopleHomeText = defineCatalog("peopleHome", {
  "tabs.label": "Show",
  "tab.online": "Online",
  "tab.all": "All",
  search: "Search people",
  "count.online": "Online — {count}",
  "count.all": "All members — {count}",
  "list.label": "People",
  "empty.online": "No one else is online right now.",
  "empty.all": "No one else is on this server yet.",
  "empty.search": "No one matches “{query}”.",
  message: "Message {name}",
  "active.title": "Active now",
  "active.empty":
    "It's quiet for now. When someone plays a game or joins voice, they show up here.",
  "active.voice": "In {channel}",
  "phone.title": "Messages",
  "phone.search": "Search messages",
  "phone.new": "New message",
  loadFailed: "The People view could not load. Try again.",
});
