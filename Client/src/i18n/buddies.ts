import { defineCatalog } from "./format";

/** Command Deck's Buddies column: its title, its activity groups and the voice
 *  room a member is in. Its own catalog, loaded with the main page chunk. */
export const buddiesText = defineCatalog("buddies", {
  title: "Buddies",
  count: "{online}/{total}",
  countLabel: "{online} of {total} online",
  inRoom: "In {room}",
  groupGame: "IN GAME",
  groupOnline: "ONLINE",
  groupAway: "AWAY",
  groupDnd: "DO NOT DISTURB",
  groupOffline: "OFFLINE",
});
