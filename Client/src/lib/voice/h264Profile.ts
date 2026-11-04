/**
 * Which H.264 profiles a camera or screen share offers to LiveKit, and the
 * frame size a graphics-card H.264 screen share is held to.
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

import type { LocalTrack } from "livekit-client";
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

/** The largest frame WebView2's graphics-card H.264 encoder takes. These are
 *  the figures edge://gpu lists on an RTX 4080 (hardware H.264 encode up to
 *  3840x2160); other GPUs report their own limits, so a share there may shrink
 *  when it did not need to, or still fall back. A larger frame, such as a
 *  5120x1440 screen shared at Source 60 fps, makes WebRTC fall back to
 *  OpenH264, and the live check in `codecSwitch` then turns the share into
 *  VP8. */
export const GPU_H264_MAX_WIDTH = 3840;
export const GPU_H264_MAX_HEIGHT = 2160;

export interface FrameSize {
  readonly width: number;
  readonly height: number;
}

/** The size box a GPU H.264 share is held to: `cap` (a quality preset's size,
 *  or none for Source) shrunk to fit the encoder's limit. */
export function gpuH264SizeCap(cap?: FrameSize): FrameSize {
  return {
    width: Math.min(cap?.width ?? GPU_H264_MAX_WIDTH, GPU_H264_MAX_WIDTH),
    height: Math.min(cap?.height ?? GPU_H264_MAX_HEIGHT, GPU_H264_MAX_HEIGHT),
  };
}

/** The part of a livekit `LocalVideoTrack` the fit needs. */
export type FittableShare = Pick<LocalTrack, "mediaStreamTrack" | "waitForDimensions">;

/** Shrink a GPU H.264 share's capture to fit the encoder before it reaches
 *  the sender, keeping its aspect ratio and frame rate. Chromium reports a
 *  display capture's size only once its first frame arrives, which can be
 *  after getDisplayMedia resolves, so the size is waited for as livekit does
 *  before every publish. A capture that already fits is left alone.
 *  `applyConstraints` replaces every constraint the capture was opened with,
 *  so the frame rate is passed again. A size that never arrives or a refusal
 *  is only logged: the share then runs at full size and the live check still
 *  catches a software fallback on a first publish. */
export async function fitGpuH264Share(share: FittableShare): Promise<void> {
  let size: { width: number; height: number };
  try {
    size = await share.waitForDimensions();
  } catch (err) {
    log.warn("Screen share size unknown, not fitted to the GPU H.264 encoder", err);
    return;
  }
  const { width, height } = size;
  if (width <= GPU_H264_MAX_WIDTH && height <= GPU_H264_MAX_HEIGHT) return;
  const track = share.mediaStreamTrack;
  const { frameRate } = track.getSettings();
  try {
    await track.applyConstraints({
      width: { max: GPU_H264_MAX_WIDTH },
      height: { max: GPU_H264_MAX_HEIGHT },
      ...(frameRate === undefined ? {} : { frameRate }),
    });
    log.info("Screen share shrunk to fit the GPU H.264 encoder", {
      from: `${width}x${height}`,
      frameRate,
    });
  } catch (err) {
    log.warn("Could not shrink the screen share to fit the GPU H.264 encoder", err);
  }
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
