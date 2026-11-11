/** How the DM call state follows the voice store. */

import { createLogger } from "@lib/logger";
import { enableCamera } from "@lib/voice/livekitSession";
import type { OutgoingCall, RingController } from "@lib/voice/callRing";
import type { VoiceState } from "@stores/voice.store";

const log = createLogger("main-page");

/** The call state a voice update settles. */
export interface CallVoiceHost {
  readonly ringCtrl: RingController | null;
  readonly outgoingCall: OutgoingCall | null;
  /** The channel whose accepted call turns the camera on once connected. */
  cameraOnJoin: number | null;
}

/** An incoming ring is answered by being in its room, however you got there. */
function cancelAnsweredRing(state: VoiceState, host: CallVoiceHost): void {
  const ring = host.ringCtrl?.current() ?? null;
  if (ring !== null && state.currentChannelId === ring.channelId) {
    host.ringCtrl?.cancel(ring.channelId);
  }
}

/** The outgoing ring is over once anyone else is in the room, or once the
 *  caller is not. */
function clearFinishedOutgoing(state: VoiceState, host: CallVoiceHost, selfId: () => number): void {
  const out = host.outgoingCall?.current() ?? null;
  if (out === null) return;
  const roster = state.voiceUsers.get(out.channelId);
  const self = selfId();
  const answered = roster !== undefined && [...roster.keys()].some((id) => id !== self);
  if (state.currentChannelId !== out.channelId || answered) host.outgoingCall?.clear();
}

/** "Join with video" turns the camera on as soon as the accepted call is connected. */
function enableCameraOnJoin(state: VoiceState, host: CallVoiceHost): void {
  if (host.cameraOnJoin === null) return;
  // The switch into that call still waits for the server.
  if (state.switchingTo === host.cameraOnJoin) return;
  if (state.currentChannelId !== host.cameraOnJoin) {
    host.cameraOnJoin = null;
    return;
  }
  if (state.voiceStatus !== "connected") return;
  host.cameraOnJoin = null;
  if (state.localCamera) return;
  enableCamera().catch((err: unknown) => {
    log.error("Camera on join failed", { error: String(err) });
  });
}

export function syncCallsWithVoice(
  state: VoiceState,
  host: CallVoiceHost,
  selfId: () => number,
): void {
  cancelAnsweredRing(state, host);
  clearFinishedOutgoing(state, host, selfId);
  enableCameraOnJoin(state, host);
}
