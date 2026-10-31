// Keeps a call running while the Android app is in the background: tells the
// host's call service when a call starts, when the camera goes on or off, and
// when the call ends. The service starts at "joining", while the user's tap
// still has the app in front, which Android requires for a mic service.

import { voiceStore, type VoiceState } from "@stores/voice.store";
import { desktop } from "../../platform/desktop";
import type { CallServiceState } from "../../platform/contracts/callService";

function callState(state: VoiceState): CallServiceState {
  const active = state.currentChannelId !== null || state.voiceStatus !== "idle";
  return { active, camera: active && state.localCamera };
}

/** Follow the voice store until `signal` aborts, then stop the service if a
 *  call still had it running. */
export function startBackgroundCall(signal: AbortSignal): void {
  if (signal.aborted) return;
  let sent = callState(voiceStore.getState());
  if (sent.active) desktop.callService.update(sent);
  const stop = voiceStore.subscribeSelector(callState, (next) => {
    sent = next;
    desktop.callService.update(next);
  });
  signal.addEventListener(
    "abort",
    () => {
      stop();
      if (sent.active) desktop.callService.update({ active: false, camera: false });
    },
    { once: true },
  );
}
