import { defineCatalog } from "./format";

/**
 * The DM call panel's copy (components/DmCallPanel.ts). Its own catalog so it
 * loads with the panel's lazy chunk, not with the main page. The panel also
 * reads the shared voice catalog for status and control names it has in
 * common with the voice widget.
 */
export const dmCallText = defineCatalog("dmCall", {
  region: "Call with {name}",
  controls: "Call controls",
  you: "You",
  muted: "Muted",
  deafened: "Deafened",
  collapse: "Collapse",
  collapseLabel: "Collapse call",
  expand: "Expand",
  expandLabel: "Expand call",
  share: "Share your screen",
  leave: "Leave call",
  calling: "Calling…",
  callingName: "Calling {name}…",
  ringingHint: "Ringing stops after 30 seconds.",
  declinedStatus: "{name} declined",
  declined: "{name} declined the call",
  noAnswerStatus: "No answer",
  noAnswer: "{name} didn't answer",
  stillInCall: "You're still in the call, so {name} can join later.",
  ringAgain: "Ring again",
  isCalling: "{name} is calling…",
  voiceCall: "Voice call",
  accept: "Accept call",
  acceptVideo: "Join with video",
  decline: "Decline call",
  liveOne: "{name} is in a call",
  liveMany: { one: "{count} person is in a call", other: "{count} people are in a call" },
  inProgress: "Call in progress",
  joinHint: "Join to talk.",
  switchHint: "Joining leaves {channel}.",
  join: "Join call",
  switch: "Switch to this call",
  watch: "Watch",
  speaking: "{name} is speaking",
});
