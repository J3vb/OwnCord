/**
 * The codec the camera and screen share publish with.
 *
 * Voice E2EE is always on, and livekit-client then publishes no backup codec,
 * so every viewer must decode the one chosen here or see a black tile. VP8 and
 * H.264 are the two every shipped client decodes. VP8 is the default; H.264
 * lets Windows encode on the graphics card. The Linux native engine always
 * publishes VP8: its release build has no hardware encoder, and software
 * H.264 there is slower than VP8.
 */

import { loadPref } from "../../lib/preferences";
import { isLinuxDesktop } from "./native/platform";

export type VideoCodecPref = "vp8" | "h264" | "auto";
export type PublishCodec = "vp8" | "h264";

/** The saved choice, VP8 unless the user picked another. */
export function getVideoCodecPref(): VideoCodecPref {
  const saved = loadPref<string>("videoCodec", "vp8");
  return saved === "h264" || saved === "auto" ? saved : "vp8";
}

/** Auto's rule: H.264 only where the browser says it encodes it in hardware
 *  (`powerEfficient`) at this size and rate; a software H.264 encoder is
 *  slower than VP8. `null` is a probe that failed or could not run. */
export function pickAutoCodec(probe: MediaCapabilitiesInfo | null): PublishCodec {
  return probe?.supported === true && probe.powerEfficient ? "h264" : "vp8";
}

/** The codec for one publish of `track` at `fps` and `bitrate`. Auto probes
 *  at the captured size, since a hardware encoder can take 1080p30 and refuse
 *  1080p120. */
export async function resolveVideoCodec(
  track: MediaStreamTrack,
  fps: number,
  bitrate: number,
): Promise<PublishCodec> {
  if (isLinuxDesktop()) return "vp8";
  const pref = getVideoCodecPref();
  if (pref !== "auto") return pref;
  const { width, height } = track.getSettings();
  try {
    const probe = await navigator.mediaCapabilities.encodingInfo({
      type: "webrtc",
      video: { contentType: "video/H264", width, height, bitrate, framerate: fps },
    } as MediaEncodingConfiguration);
    return pickAutoCodec(probe);
  } catch {
    // No MediaCapabilities, or a configuration the browser rejects.
    return pickAutoCodec(null);
  }
}
