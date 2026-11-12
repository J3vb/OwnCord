// After a join or a reconnect: publish the microphone behind the push-to-talk
// gate and re-apply the user's mute and deafen, for the session that is still
// current when the publish settles; after a reconnect, also bring back the
// camera and screen share the drop stopped.
import {
  voiceStore,
  isPttPollingLive,
  setPttGated as setPttGatedState,
  setListenOnly,
  type VoiceState,
} from "@stores/voice.store";
import { pttGates } from "@lib/ui/inputMode";
import { createLogger } from "@lib/logger";
import type { AudioPipeline } from "@lib/voice/audioPipeline";
import type { AudioElements } from "@lib/voice/audioElements";
import { type MediaControl, syncShareGrant } from "./mediaControl";
import { voiceText } from "../../i18n/voice";
import { type LostMedia, restoreLostMedia } from "./mediaLostNotice";
import { isLinuxDesktop } from "./native/platform";
import type { SessionState } from "./sessionState";
import type { VoiceRoom } from "@lib/voice/voiceRoom";

const log = createLogger("livekitSession");

/** What the restore reads from the session; `room` is read live each time. */
export interface LocalVoiceRestoreHost {
  room(): VoiceRoom | null;
  readonly audioPipeline: AudioPipeline;
  readonly media: MediaControl;
  readonly audioElements: AudioElements;
  onError(message: string): void;
  applyMicMuteState(muted: boolean): Promise<void>;
}

/** Close or open the push-to-talk gate for the freshly published mic. */
function armPttGate(
  mode: "join" | "reconnect",
  state: VoiceState,
  host: LocalVoiceRestoreHost,
): void {
  // In Push to Talk mode a bound key (or, in the Android app, the on-screen
  // talk button) means transmission is gated by press/release (a key bound
  // in Voice Activity mode gates nothing), but the Rust poller only emits
  // ptt-state on a state TRANSITION, and an idle button sends nothing — an idle key
  // produces no event at all, so without this the freshly published mic
  // would stay hot and transmitting until the user's first press+release.
  // Only arm this when the poller is confirmed live (setPttPollingLive) —
  // gating on the stored key alone would close the mic permanently on
  // platforms where PTT can never actually report state (macOS's
  // is_key_down stub, Wayland Linux while the portal backend is not live).
  // Record the gate in pttGated, NEVER in localMuted: localMuted means "the
  // user muted themselves". The microphone is enabled either way, behind
  // the gate (AudioPipeline.setPttGated), and a press only opens the gate.
  // On reconnect, don't recompute pttArmed from scratch — that always
  // yields false (mode !== "join") and ignores whatever pttGated the store
  // is still carrying from before the disconnect. If the user joined with
  // PTT armed and never pressed the key before the connection dropped, the
  // gate is still supposed to be closed; reading it back here (instead of
  // silently reopening the mic) is what keeps that promise across a
  // reconnect.
  const pttArmed = mode === "join" ? pttGates(isPttPollingLive()) : state.pttGated === true;
  if (mode === "join") setPttGatedState(pttArmed);
  host.audioPipeline.setPttGated(pttArmed);
}

/** A refused or missing mic joins listen-only; say why, once. */
function noteMicFailure(
  mode: "join" | "reconnect",
  micErr: unknown,
  host: LocalVoiceRestoreHost,
): void {
  if (mode === "reconnect") {
    log.warn("Auto-reconnect: mic unavailable — listen-only mode", micErr);
  } else if (micErr instanceof DOMException && micErr.name === "NotAllowedError") {
    log.warn("Microphone permission denied — joined in listen-only mode");
    host.onError(voiceText("session.listenOnlyPermission"));
  } else if (micErr instanceof DOMException && micErr.name === "NotFoundError") {
    log.warn("No microphone found — joined in listen-only mode");
    host.onError(voiceText("session.listenOnlyMissing"));
  } else {
    log.warn("Microphone unavailable — joined in listen-only mode", micErr);
    host.onError(voiceText("session.listenOnlyUnavailable"));
  }
}

function logMicRestored(mode: "join" | "reconnect"): void {
  log.info(
    mode === "join"
      ? "Published mic via LiveKit native capture"
      : "Auto-reconnect restored live microphone",
  );
}

export async function restoreLocalVoiceState(
  mode: "join" | "reconnect",
  host: LocalVoiceRestoreHost,
): Promise<void> {
  const room = host.room();
  if (room === null) return;
  syncShareGrant(room);

  const state = voiceStore.getState();
  armPttGate(mode, state, host);
  const muted = state.localMuted || state.localDeafened;
  const deafened = state.localDeafened;
  // The AFK channel is listen-only: publish nothing there, and do not read
  // the empty mic as a failure (no listen-only notice, nothing to retry).
  // enableMicrophone(false) is a no-op publish, so nothing can be refused.
  // A phone call's hold keeps the mic closed the same way; the hold's end
  // opens it (syncMicrophoneGate).
  const shouldEnableMicrophone =
    !muted && state.inAfkChannel !== true && state.phoneCallHold !== true;

  try {
    await host.media.enableMicrophone(room, shouldEnableMicrophone);
    if (host.room() !== room) return;
    if (shouldEnableMicrophone) logMicRestored(mode);
    if (host.room() !== room) return;
    setListenOnly(false); // Mic acquired successfully
  } catch (micErr) {
    if (host.room() !== room) return;
    setListenOnly(true);
    noteMicFailure(mode, micErr, host);
  }

  // setMicrophoneEnabled above can block for seconds on the
  // browser's mic-permission prompt. If a newer session claimed `_room`
  // while this call was suspended there (the user switched channels, or an
  // auto-reconnect installed a fresh room), the writes below re-read
  // `host.room()` fresh (applyMicMuteState) instead of the `room` captured
  // at the top of this call — applying THIS call's stale muted/deafened
  // decision to that newer room would mute/unmute or resubscribe audio on
  // a session that never asked for it. Bail out once the captured room is
  // no longer the live one; the newer session owns its own state from here.
  if (host.room() !== room) {
    log.info("restoreLocalVoiceState: superseded mid-call — discarding stale mute/deafen state");
    return;
  }

  // Always enforce mute at the track level even if no pipeline exists yet.
  // setMicrophoneEnabled(false) doesn't guarantee mediaStreamTrack.enabled=false,
  // and renegotiation when a new participant joins can bring a track back alive.
  if (muted) {
    host
      .applyMicMuteState(true)
      .catch((e) => log.warn("applyMicMuteState failed in restoreLocalVoiceState", e));
  }

  host.audioElements.applyRemoteAudioSubscriptionState(deafened);
}

/** What the media restore reads and writes on the session. */
export interface LostMediaRestoreHost {
  sendWatching(): void;
  getLost(): LostMedia | null;
  setLost(lost: LostMedia | null): void;
  room(): VoiceRoom | null;
  stateType(): SessionState["type"];
  enableCamera(): Promise<void>;
  enableScreenshare(): Promise<void>;
}

/** Once a reconnect (or its rejoin) lands: bring back what the drop stopped. */
export function restoreMediaAfterReconnect(host: LostMediaRestoreHost): void {
  host.sendWatching();
  const lost = host.getLost();
  host.setLost(null);
  const room = host.room();
  if (lost === null || room === null) return;
  const stillCurrent = (): boolean => host.room() === room;
  const restore = restoreLostMedia(lost, {
    isOn: (kind) =>
      kind === "camera"
        ? voiceStore.getState().localCamera
        : voiceStore.getState().localScreenshare,
    enableCamera: () => host.enableCamera(),
    restartScreenshare: async () => {
      if (!isLinuxDesktop()) return false;
      const picker = await import("./native/screenPicker");
      if (!(await picker.armScreenRestart().catch(() => false))) return false;
      try {
        // The user may have shared meanwhile: leave theirs alone.
        if (stillCurrent() && !voiceStore.getState().localScreenshare)
          await host.enableScreenshare();
      } finally {
        picker.disarmScreenRestart();
      }
      return true;
    },
    stillCurrent,
    turnOn: {
      camera: () => void host.enableCamera().catch((e) => log.error("Camera restart failed", e)),
      screenshare: () =>
        void host.enableScreenshare().catch((e) => log.error("Screenshare restart failed", e)),
    },
  });
  restore
    .then(() => {
      // Dropped again mid-restore: the next reconnect restores it all,
      // including what teardownForReconnect saw as still off.
      if (stillCurrent() || host.stateType() !== "reconnecting") return;
      const prev = host.getLost();
      host.setLost({
        camera: lost.camera || (prev?.camera ?? false),
        screenshare: lost.screenshare || (prev?.screenshare ?? false),
      });
    })
    // Runs after the reconnect succeeded: a failure here must not undo it.
    .catch((e) => log.warn("Restoring media after reconnect failed", e));
}
