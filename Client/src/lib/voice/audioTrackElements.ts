// DOM element plumbing for remote audio tracks: attach and detach the
// hidden <audio> elements and route them to the saved output device. Split
// from audioElements.ts; the class there keeps every map and the gain graph.

import type { RemoteTrack } from "livekit-client";
import { loadPref } from "@lib/prefs/preferences";
import { createLogger } from "@lib/logger";

const log = createLogger("audioElements");

/** Send an element to the saved output device, when one is saved and the
 *  engine can route a single element. `failureMessage` is logged on a
 *  rejection. */
export function applySavedOutput(audioEl: HTMLAudioElement, kind: "screenshare" | "remote"): void {
  const savedOutput = loadPref<string>("audioOutputDevice", "");
  if (savedOutput !== "" && typeof audioEl.setSinkId === "function") {
    audioEl.setSinkId(savedOutput).catch((err) => {
      if (kind === "screenshare") log.warn("Failed to set output device on screenshare audio", err);
      else log.warn("Failed to set output device on remote audio", err);
    });
  }
}

/** Attach a remote microphone track to a fresh hidden element in the body.
 *  Any previous <audio> elements are detached first to prevent duplicate
 *  playback on fast reconnects (new subscription fires before old
 *  unsubscription). */
export function attachMicAudioElement(track: RemoteTrack): HTMLAudioElement {
  for (const el of track.detach()) el.remove();
  const audioEl = track.attach();
  audioEl.style.display = "none";
  document.body.appendChild(audioEl);
  return audioEl;
}

/** Attach screenshare audio and track the element in `elementsByUser`.
 *  Looks up the tracking set before detaching so a fast re-subscribe (new
 *  TrackSubscribed before the old TrackUnsubscribed lands) drops the stale
 *  element from the set instead of leaking it forever. */
export function attachScreenshareAudio(
  track: RemoteTrack,
  elementsByUser: Map<number, Set<HTMLAudioElement>>,
  userId: number,
  volume: number,
  muted: boolean,
): HTMLAudioElement {
  let audioEls = elementsByUser.get(userId);
  for (const el of track.detach()) {
    el.remove();
    audioEls?.delete(el);
  }
  const audioEl = track.attach();
  audioEl.style.display = "none";
  document.body.appendChild(audioEl);
  audioEl.volume = volume;
  audioEl.muted = muted;
  if (audioEls === undefined) {
    audioEls = new Set();
    elementsByUser.set(userId, audioEls);
  }
  audioEls.add(audioEl);
  return audioEl;
}

/** Detach screenshare audio, removing its elements from the DOM and from the
 *  user's tracking set (dropping the set once empty). */
export function detachScreenshareAudio(
  track: RemoteTrack,
  elementsByUser: Map<number, Set<HTMLAudioElement>>,
  userId: number,
): void {
  const detachedEls = track.detach() as HTMLAudioElement[];
  for (const el of detachedEls) el.remove();
  const audioEls = elementsByUser.get(userId);
  if (audioEls !== undefined) {
    for (const el of detachedEls) audioEls.delete(el);
    if (audioEls.size === 0) elementsByUser.delete(userId);
  }
}
