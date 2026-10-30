/**
 * Which H.264 profiles a camera or screen share offers to LiveKit.
 *
 * WebView2 encodes H.264 Main and High on the graphics card, but Constrained
 * Baseline only in software (OpenH264), and LiveKit's answer puts Constrained
 * Baseline first whenever the offer has it. So an H.264 track in the Windows
 * app ran on the CPU and the live check in `codecSwitch` turned it into VP8.
 * A marked track's transceiver offers only the H.264 profiles that are not
 * Baseline, then every other codec, so LiveKit negotiates Main or High.
 * livekit-client has no hook for codec preferences, so this wraps
 * `RTCPeerConnection.prototype.createOffer` once and sets them on every offer,
 * renegotiations and ICE restarts included.
 *
 * A transceiver keeps its preferences while it sends (a Change source or a
 * camera switch replaces the track under it), and goes back to the browser's
 * default once its track is unpublished, so a later publish that reuses it is
 * not narrowed.
 */

import { createLogger } from "../logger";

const log = createLogger("h264Profile");

/** Tracks whose next offers should carry only non-Baseline H.264. */
const markedTracks = new WeakSet<MediaStreamTrack>();
/** Transceivers this module narrowed, to restore once they stop sending. */
const narrowed = new WeakSet<RTCRtpTransceiver>();
let installed = false;

/** Mark `track` to offer only Main/High H.264 (`gpuProfiles`), or unmark it.
 *  Called before every publish of a camera or share track, with
 *  `h264GpuPublish(codec)` from `features/voice/videoCodec`. */
export function setH264GpuProfiles(track: MediaStreamTrack, gpuProfiles: boolean): void {
  if (!gpuProfiles) {
    markedTracks.delete(track);
    return;
  }
  installOfferHook();
  markedTracks.add(track);
}

/** Whether an H.264 fmtp line is Baseline or Constrained Baseline: profile_idc
 *  0x42. A line without profile-level-id means Constrained Baseline (RFC 6184). */
function isBaselineProfile(fmtp: string | undefined): boolean {
  const match = /profile-level-id=([0-9a-f]{2})/i.exec(fmtp ?? "");
  return match === null || match[1]?.toLowerCase() === "42";
}

function isH264(codec: RTCRtpCodec): boolean {
  return codec.mimeType.toLowerCase() === "video/h264";
}

/** `codecs` with H.264 narrowed to its non-Baseline profiles, which go first,
 *  then every codec that is not H.264. Null when nothing but Baseline is
 *  there: narrowing would then drop H.264 altogether. */
export function nonBaselineH264Order(codecs: readonly RTCRtpCodec[]): RTCRtpCodec[] | null {
  const gpu = codecs.filter((c) => isH264(c) && !isBaselineProfile(c.sdpFmtpLine));
  if (gpu.length === 0) return null;
  return [...gpu, ...codecs.filter((c) => !isH264(c))];
}

/** Set or restore the codec preferences of `pc`'s video transceivers. */
export function applyH264GpuProfiles(pc: RTCPeerConnection): void {
  for (const transceiver of pc.getTransceivers()) {
    const track = transceiver.sender.track;
    if (track !== null && track.kind === "video" && markedTracks.has(track)) {
      narrow(transceiver);
    } else if (track === null && narrowed.has(transceiver)) {
      restore(transceiver);
    }
  }
}

function narrow(transceiver: RTCRtpTransceiver): void {
  const codecs = RTCRtpSender.getCapabilities("video")?.codecs ?? [];
  const order = nonBaselineH264Order(codecs);
  if (order === null) return;
  try {
    transceiver.setCodecPreferences(order);
    narrowed.add(transceiver);
  } catch (err) {
    log.warn("Could not prefer H.264 Main/High, the offer keeps Baseline", err);
  }
}

function restore(transceiver: RTCRtpTransceiver): void {
  try {
    transceiver.setCodecPreferences([]);
  } catch (err) {
    log.warn("Could not restore the default codec preferences", err);
  }
  narrowed.delete(transceiver);
}

function installOfferHook(): void {
  if (installed || typeof RTCPeerConnection === "undefined") return;
  installed = true;
  const original = RTCPeerConnection.prototype.createOffer;
  RTCPeerConnection.prototype.createOffer = function createOffer(
    this: RTCPeerConnection,
    ...args: unknown[]
  ): Promise<RTCSessionDescriptionInit> {
    applyH264GpuProfiles(this);
    return Reflect.apply(original, this, args) as Promise<RTCSessionDescriptionInit>;
  } as RTCPeerConnection["createOffer"];
}
