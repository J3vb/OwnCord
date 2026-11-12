/**
 * The Android app's call audio: where a call's sound plays (speaker, earpiece,
 * a headset) and the pause while a phone call holds the audio.
 *
 * The host (`platform/contracts/mobileAudio.ts`) follows the routes, applies a
 * pick and silences the call during a phone call. This module tells it when a
 * call runs, keeps what it reports where the route control reads it, and does
 * the two things only the page can:
 *
 * - While a phone call holds the audio, the call is on hold
 *   (`VoiceState.phoneCallHold`): the microphone closes and every mic control
 *   reads paused. The user's own mute and deafen are not touched, so the call
 *   comes back as it was.
 * - While a route the user picked is on, one extra microphone capture stays
 *   open, disabled and never sent. Android lets an app choose a call's device
 *   only while it captures for a call, and a mute closes the call's own
 *   capture, so without this a pick would last until the first mute. With no
 *   pick nothing extra is opened and the WebView routes the call by itself.
 */

import { createLogger } from "@lib/logger";
import { createStore } from "@lib/store";
import { showToast } from "@lib/ui/toast";
import { voiceStore, setPhoneCallHold, type VoiceState } from "@stores/voice.store";
import { voiceText } from "../../i18n/voice";
import { desktop } from "../../platform/desktop";
import type { AudioRouteKind, MobileAudioState } from "../../platform/contracts/mobileAudio";

const log = createLogger("mobileRoutes");

const NO_ROUTES: MobileAudioState = {
  supported: false,
  routes: [],
  active: "speaker",
  manual: null,
  interrupted: false,
};

/** What the host last reported. The device's state, not a server's. */
export const mobileRouteStore = createStore<MobileAudioState>(NO_ROUTES);

/** The capture that keeps a picked route (see the header). */
let keeper: MediaStream | null = null;
/** A keeper is wanted: open, or on its way. */
let keeping = false;
/** Bumped by every open and close, so a capture that arrives late is stopped. */
let keeperTurn = 0;

function inCall(state: VoiceState): boolean {
  return state.currentChannelId !== null || state.voiceStatus !== "idle";
}

function stopTracks(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop();
}

function closeKeeper(): void {
  keeping = false;
  keeperTurn++;
  if (keeper === null) return;
  stopTracks(keeper);
  keeper = null;
}

/** A pick that cannot be kept goes back to the host's own choice, and says so. */
function dropPick(reason: unknown): void {
  log.warn("The picked route could not be kept; back to automatic", reason);
  closeKeeper();
  // Ahead of the host's answer, so nothing reopens the capture meanwhile.
  mobileRouteStore.setState((prev) => ({ ...prev, manual: null }));
  desktop.mobileAudio.setRoute(null);
  showToast(voiceText("route.lost"), "error");
}

async function openKeeper(): Promise<void> {
  keeping = true;
  const turn = ++keeperTurn;
  let stream: MediaStream;
  try {
    const { micProcessingOptions } = await import("@lib/voice/audioPipeline");
    // Echo cancellation is what makes the WebView capture as a call does.
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { ...micProcessingOptions(), echoCancellation: true },
    });
  } catch (err) {
    if (turn === keeperTurn) dropPick(err);
    return;
  }
  if (turn !== keeperTurn) {
    stopTracks(stream);
    return;
  }
  for (const track of stream.getAudioTracks()) {
    track.enabled = false;
    track.addEventListener(
      "ended",
      () => {
        // i18n-exempt: a reason for the log, never shown
        if (keeper === stream) dropPick("the capture ended");
      },
      { once: true },
    );
  }
  keeper = stream;
}

/** Put the call on hold for a phone call, or take it off. */
function syncHold(held: boolean): void {
  if ((voiceStore.getState().phoneCallHold === true) === held) return;
  setPhoneCallHold(held);
  log.info(held ? "Call on hold for a phone call" : "Call back from its phone call hold");
  // A call that is over has no microphone left to open.
  if (!inCall(voiceStore.getState())) return;
  // In a call the session module is loaded already; importing it lazily keeps
  // the voice SDK out of this module, which starts with the app.
  void import("@lib/voice/livekitSession")
    .then((session) => session.syncMicrophoneGate())
    .catch((err: unknown) => log.warn("The hold did not reach the microphone", err));
}

/** Bring the hold and the keeper in line with the call and the host's state. */
function sync(): void {
  const host = mobileRouteStore.getState();
  const calling = inCall(voiceStore.getState());
  syncHold(calling && host.interrupted);
  const wanted = calling && !host.interrupted && host.manual !== null;
  if (wanted && !keeping) void openKeeper();
  else if (!wanted && keeping) closeKeeper();
}

/** Play the call through `kind`: a tap in the route sheet. The host answers
 *  with the state the pick left; the route it picks by itself counts as no
 *  pick. */
export function pickRoute(kind: AudioRouteKind): void {
  desktop.mobileAudio.setRoute(kind);
}

/** Follow the host's call audio until `signal` aborts, then end what a call
 *  still had running. */
export function startMobileRoutes(signal: AbortSignal): void {
  if (signal.aborted) return;
  desktop.mobileAudio.watch(signal, (state) => {
    mobileRouteStore.setState(() => state);
    sync();
  });
  let calling = inCall(voiceStore.getState());
  if (calling) desktop.mobileAudio.setSession(true);
  const stop = voiceStore.subscribeSelector(inCall, (next) => {
    calling = next;
    desktop.mobileAudio.setSession(next);
    // A pick and a pause belong to one call: the host forgets both when the
    // call ends, and its answer says how the next one starts. The same here,
    // without waiting for that answer, so no call starts on what an earlier
    // one left.
    mobileRouteStore.setState((prev) => ({ ...prev, manual: null, interrupted: false }));
    sync();
  });
  // A page in the background may have missed a change.
  document.addEventListener(
    "visibilitychange",
    () => {
      if (calling && document.visibilityState === "visible") desktop.mobileAudio.refresh();
    },
    { signal },
  );
  signal.addEventListener(
    "abort",
    () => {
      stop();
      if (calling) desktop.mobileAudio.setSession(false);
      mobileRouteStore.setState(() => NO_ROUTES);
      sync();
    },
    { once: true },
  );
}
