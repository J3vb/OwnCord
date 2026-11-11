// The synchronous tails of the native local video's stop handlers, split from
// nativeLocalVideo.ts: forget the publication, then release the host capture
// when the session is still the one the track started under. Each helper is a
// whole synchronous step; the owning state (the live track fields) is still
// cleared by NativeLocalVideo before the call.
import { createLogger } from "../../../lib/logger";
import { desktop } from "../../../platform/desktop";
import type { NativeCameraTrack } from "./nativeCameraTrack";
import type { NativeScreenAudioTrack } from "./screenAudioTrack";
import type { NativeScreenTrack } from "./screenTrack";
import type { NativeVideoHost } from "./nativeVideoTypes";

const log = createLogger("nativeRoom");

/** The host's reason for a camera that opened but produced no first frame
 *  (`TIMED_OUT` in `src-tauri/src/native_voice/camera.rs`). */
// i18n-exempt: the host's error text matched, never rendered
export const CAMERA_NO_FRAME = "camera capture produced no frame in time";

/** A stopped camera track: forget its publication, then stop its host
 *  capture (a no-op for a capture a newer one replaced). */
export function forgetCameraAndStop(
  host: NativeVideoHost,
  session: number,
  track: NativeCameraTrack,
): void {
  const pubs = host.publications;
  if (pubs.get("camera")?.track === track) pubs.delete("camera");
  if (host.sessionId() !== session) return;
  desktop.nativeVoice
    .stopCamera(session, track.capture)
    .catch((err) => log.warn("native stopCamera failed", { capture: track.capture, err }));
}

/** A stopped screen track: forget its publication, stop the share's audio
 *  track when `liveAudio` is given (the live share stopped), then stop its
 *  host capture. */
export function forgetScreenAndStop(
  host: NativeVideoHost,
  session: number,
  track: NativeScreenTrack,
  liveAudio: NativeScreenAudioTrack | null,
): void {
  const pubs = host.publications;
  if (pubs.get("screen_share")?.track === track) pubs.delete("screen_share");
  // The host ends the audio with its capture: the track follows, but only
  // when the live share stops, never a stale track's late stop.
  liveAudio?.stop();
  if (host.sessionId() !== session) return;
  desktop.nativeVoice
    .stopScreen(session, track.capture)
    .catch((err) => log.warn("native stopScreen failed", { capture: track.capture, err }));
}

/** A stopped audio track: unpublish its sid and forget it. Fire and forget
 *  (stop() is synchronous); a stale sid is a no-op in the host. */
export function forgetScreenAudioAndUnpublish(
  host: NativeVideoHost,
  session: number,
  track: NativeScreenAudioTrack,
): void {
  const pubs = host.publications;
  const pub = pubs.get("screen_share_audio");
  if (pub?.track !== track) return;
  pubs.delete("screen_share_audio");
  if (host.sessionId() !== session) return;
  desktop.nativeVoice
    .unpublishScreenAudio(session, pub.trackSid)
    .catch((err) => log.warn("native unpublishScreenAudio failed", { sid: pub.trackSid, err }));
}
