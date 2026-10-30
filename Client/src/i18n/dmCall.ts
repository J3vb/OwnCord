import { defineCatalog } from "./format";

/**
 * The DM call panel's copy (components/DmCallPanel.ts), and the caller's
 * declined/no-answer toast in the main page. Its own catalog rather than the
 * shared voice catalog. The panel also reads the shared voice catalog for
 * status and control names it has in common with the voice widget.
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
  resizeLabel: "Resize call",
  share: "Share your screen",
  leave: "Leave call",
  calling: "Calling…",
  callingName: "Calling {name}…",
  ringingHint: "Ringing stops after 30 seconds.",
  declinedStatus: "{name} declined",
  declined: "{name} declined the call",
  noAnswerStatus: "No answer",
  noAnswer: "{name} didn't answer",
  offline: "{name} is offline",
  stillInCall: "You're still in the call, so {name} can join later.",
  ringAgain: "Ring again",
  notInCall: "Not in call",
  leftStatus: "{name} left the call",
  isCalling: "{name} is calling…",
  notifyIncoming: "{name} is calling you",
  missed: "Missed call from {name}",
  missedGroup: "Missed call in {name}",
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
  speaking: "{name} is speaking",
  // The call log row in the chat.
  rowLive: "{name} started a call",
  rowJoin: "Join",
  rowJoinLabel: "Join the call",
  rowLastedMinutes: {
    one: "{name} started a call that lasted {count} minute",
    other: "{name} started a call that lasted {count} minutes",
  },
  rowLastedSeconds: "{name} started a call that lasted a few seconds",
  rowMissed: "You missed a call from {name}",
  rowMissedMinutes: {
    one: "You missed a call from {name} that lasted {count} minute",
    other: "You missed a call from {name} that lasted {count} minutes",
  },
  rowMissedSeconds: "You missed a call from {name} that lasted a few seconds",
});
