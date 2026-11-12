// Keeps a call running while the Android app is in the background: tells the
// host's call service when a call starts, when the camera goes on or off, and
// when the call ends. The service starts at "joining", while the user's tap
// still has the app in front, which Android requires for a mic service.
//
// The same state keeps the screen on while the call has a picture on screen
// (a camera or a stream, as the video grid reports it), so watching with
// hands off the phone does not dim and lock it.
//
// The service's notification has a Mute or Unmute button, so the state also
// says how the microphone stands, and the notification follows a mute made
// anywhere within a moment.
//
// The host side outlives a reload of the page, so the page says where it
// stands as it starts, "no call" included: a service or a lit screen left
// from before the reload ends there.

import { voiceStore, type VoiceState } from "@stores/voice.store";
import { desktop } from "../../platform/desktop";
import type { CallMic, CallServiceState } from "../../platform/contracts/callService";
import { isVideoOnScreen, onVideoOnScreenChange } from "./videoOnScreen";

const NO_CALL: CallServiceState = {
  active: false,
  camera: false,
  videoOnScreen: false,
  mic: "live",
};

function inCall(state: VoiceState): boolean {
  return state.currentChannelId !== null || state.voiceStatus !== "idle";
}

/** A moderator's mute is not the member's to lift, whatever their own was. */
function micOf(voice: VoiceState): CallMic {
  if (voice.localServerMuted === true) return "locked";
  return voice.localMuted ? "muted" : "live";
}

/** A camera, a picture and the microphone count only inside a call. */
function callState(voice: VoiceState, videoOnScreen: boolean): CallServiceState {
  if (!inCall(voice)) return NO_CALL;
  return { active: true, camera: voice.localCamera, videoOnScreen, mic: micOf(voice) };
}

function same(a: CallServiceState, b: CallServiceState): boolean {
  return (
    a.active === b.active &&
    a.camera === b.camera &&
    a.videoOnScreen === b.videoOnScreen &&
    a.mic === b.mic
  );
}

/** Follow the voice store and the video grid until `signal` aborts, then stop
 *  the service (and let the screen sleep) if a call still had it running. */
export function startBackgroundCall(signal: AbortSignal): void {
  if (signal.aborted) return;
  let sent: CallServiceState | null = null;
  const send = (next: CallServiceState): void => {
    if (sent !== null && same(next, sent)) return;
    sent = next;
    desktop.callService.update(next);
  };
  const sync = (): void => send(callState(voiceStore.getState(), isVideoOnScreen()));
  sync();
  const stops = [
    voiceStore.subscribeSelector((voice) => callState(voice, false), sync),
    onVideoOnScreenChange(sync),
  ];
  signal.addEventListener(
    "abort",
    () => {
      for (const stop of stops) stop();
      send(NO_CALL);
    },
    { once: true },
  );
}
