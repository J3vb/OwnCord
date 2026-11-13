/**
 * The buttons of the Android app's call notifications: Mute, Unmute and Leave
 * on the "in a call" one, Accept, Decline and a tap on the incoming call's.
 * The host only shows them and reports which one was pressed
 * (`CallService.onAction`); this is where the app acts on it, through the
 * same doors as its own buttons, so a press here and a press in the app can
 * not end a call twice or answer two.
 *
 * A press may arrive after what it was about has passed: the microphone was
 * muted elsewhere meanwhile, or the ring ran out as Accept was tapped. Each
 * action checks where things stand now.
 */
import { Disposable } from "../../lib/disposable";
import { jumpToMessage } from "../../lib/nav/messageNavigation";
import { desktop } from "../../platform/desktop";
import type { CallAction } from "../../platform/contracts/callService";
import { isSelfMuted, voiceStore } from "../../stores/voice.store";
import type { PageApi, PageState } from "../../pages/main-page/pageState";
import { isHostRing } from "./callAlerts";
import { actOnPushRing } from "./pushRingActions";
import { pushSessionInstance } from "../push/pushSubscription";

/** The call's own controls, as every other surface presses them. */
export interface CallControls {
  readonly onMuteToggle: () => void;
  readonly onDisconnect: () => void;
}

type Rings = Pick<PageState, "ringCtrl" | "ws">;
type Answers = Pick<PageApi, "acceptRing" | "joinDmCall">;
type RingAction = Extract<CallAction, { readonly channelId: number }>;

/** Accept, Decline or a tap on the ringing call's notification. */
function actOnRing(action: RingAction, st: Rings, pg: Answers, owner: AbortSignal): void {
  const ringing = st.ringCtrl?.current()?.channelId === action.channelId;
  const { instance } = action;
  // A ring a push showed, which this page never heard ring.
  if (instance !== undefined && !ringing) {
    actOnPushRing({ kind: action.kind, channelId: action.channelId, instance }, st, pg, owner);
    return;
  }
  // Another server's or account's ring with the same channel id as this page's.
  if (instance !== undefined && instance !== pushSessionInstance()) return;
  // A ring an earlier session left on screen is not this page's.
  if (instance === undefined && !isHostRing(action.channelId)) return;
  if (action.kind === "decline") {
    if (ringing) st.ringCtrl?.decline();
  } else if (action.kind === "accept" && ringing) {
    pg.acceptRing(false);
  } else {
    // A tap on the notification itself, or Accept on a ring that ended before
    // the tap landed: its conversation, and nothing joined.
    jumpToMessage(action.channelId);
  }
}

/** Mute or Unmute on the "in a call" notification. */
function actOnMic(kind: "mute" | "unmute", controls: CallControls): void {
  const voice = voiceStore.getState();
  // The notification can be pressed for a moment after its call ended, and
  // outside a call the app's mute is a setting for the next one: not what
  // the button promised.
  if (voice.currentChannelId === null && voice.voiceStatus === "idle") return;
  // The button names the state it promised. Already there (muted from the
  // app as the button was pressed): nothing to do, and no toggle that would
  // flip it back.
  if (isSelfMuted(voice) !== (kind === "mute")) controls.onMuteToggle();
}

function act(
  action: CallAction,
  st: Rings,
  pg: Answers,
  controls: CallControls,
  owner: AbortSignal,
): void {
  switch (action.kind) {
    case "mute":
    case "unmute":
      actOnMic(action.kind, controls);
      return;
    case "leave":
      // One teardown whatever the call is doing, a reconnect included; with
      // no call left it does nothing.
      controls.onDisconnect();
      return;
    default:
      actOnRing(action, st, pg, owner);
  }
}

/**
 * Act on the call notifications' buttons until the returned function is
 * called. One follower at a time: the page that mounted last has them.
 */
export function followCallActions(st: Rings, pg: Answers, controls: CallControls): () => void {
  const owner = new Disposable();
  desktop.callService.onAction(owner.signal, (action) =>
    act(action, st, pg, controls, owner.signal),
  );
  return () => owner.destroy();
}
