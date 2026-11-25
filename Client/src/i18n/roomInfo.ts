import { defineCatalog } from "./format";

/** Command Deck's Info block under Buddies: the voice room you are in, its
 *  rows and the short-window summary. The state words, the quality words and
 *  the ping come from the voice catalog. Loads with the member column chunk. */
export const roomInfoText = defineCatalog("roomInfo", {
  title: "Info · ",
  users: "Users",
  usersOf: "{count} / {max}",
  usersShort: "{count}/{max}",
  srUsersOf: "In the room: {count} of {max}.",
  srUsers: "In the room: {count}.",
  audio: "Audio",
  audioLow: "Low",
  audioMedium: "Medium",
  audioHigh: "High",
  audioValue: "{quality} · {kbps}",
  notKnown: "Not known",
  security: "Security",
  blocked: "Blocked",
  newKey: "New key",
  noKey: "No key",
  noticeCount: "({count})",
  srMismatch: {
    one: "{count} participant: key does not match.",
    other: "{count} participants: key does not match.",
  },
  srStorage: {
    one: "{count} participant: key storage unavailable.",
    other: "{count} participants: key storage unavailable.",
  },
  srNewKey: {
    one: "{count} participant with a new key.",
    other: "{count} participants with a new key.",
  },
  srNoKey: {
    one: "{count} participant with no key.",
    other: "{count} participants with no key.",
  },
  quality: "Quality",
  loss: "{loss}% loss",
  notMeasured: "Not measured",
  streams: "Streams",
  none: "None",
  screen: "{name} · screen",
  camera: "{name} · camera",
  music: "{name} · music",
  more: "+{count}",
  you: "You",
  join: " · ",
  listJoin: ", ",
});
