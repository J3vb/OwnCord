import { defineCatalog } from "./format";

/**
 * What the Android app's call notifications say: the "in a call" one with its
 * Mute and Leave buttons, and the incoming call's. Read by the host side only
 * (`platform/desktop/callServiceHost.ts`, and `pushRegistrationHost.ts` for
 * the ring a push shows), so none of it loads on a desktop.
 */
export const callNotificationText = defineCatalog("callNotification", {
  inCall: "In a call",
  inCallMuted: "In a call, muted",
  inCallLocked: "In a call, muted by a moderator",
  mute: "Mute",
  unmute: "Unmute",
  leave: "Leave",
  accept: "Accept",
  decline: "Decline",
  ringChannel: "Incoming calls",
  ringChannelDesc: "A direct message call ringing",
  quietRingChannel: "Incoming calls, silent",
  quietRingChannelDesc: "Used while the ring sound is off in the app's settings",
  pushRingTitle: "Incoming call on {server}",
  pushRingText: "Voice call",
});
