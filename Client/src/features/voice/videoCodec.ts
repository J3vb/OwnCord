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
import { pickCommonCodec, type PeerDecodeLists } from "./decodeCaps";
import { isLinuxDesktop } from "./native/platform";

export type VideoCodecPref = "vp8" | "h264" | "auto";
export type PublishCodec = "vp8" | "h264";

/** The saved choice, VP8 unless the user picked another. */
export function getVideoCodecPref(): VideoCodecPref {
  const saved = loadPref<string>("videoCodec", "vp8");
  return saved === "h264" || saved === "auto" ? saved : "vp8";
}

/** Auto's rule: H.264 only where the browser says it encodes it in hardware
 *  (`powerEfficient`) at this size and rate, since a software H.264 encoder is
 *  slower than VP8, and only on a GPU known not to be Intel's. livekit-client
 *  2.22.3 cannot decrypt Intel Quick Sync H.264 under E2EE: the encoder's
 *  3-byte start codes come back as 4-byte ones, so every receiver fails the
 *  frame's authentication and shows nothing (livekit/client-sdk-js#2140).
 *  `null` is a probe that failed, or a GPU that could not be named. */
export function pickAutoCodec(
  probe: MediaCapabilitiesInfo | null,
  renderer: string | null,
): PublishCodec {
  const hardware = probe?.supported === true && probe.powerEfficient;
  return hardware && renderer !== null && !/intel/i.test(renderer) ? "h264" : "vp8";
}

/** The GPU's name from WebGL's unmasked renderer string, or null where WebGL
 *  or its debug extension is unavailable. Asks for the low-power GPU, so a
 *  laptop with two names its integrated one, the likelier video encoder. */
export function gpuRenderer(): string | null {
  try {
    const gl = document
      .createElement("canvas")
      .getContext("webgl", { powerPreference: "low-power" });
    const info = gl?.getExtension("WEBGL_debug_renderer_info");
    if (!gl || !info) return null;
    const renderer: unknown = gl.getParameter(info.UNMASKED_RENDERER_WEBGL);
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return typeof renderer === "string" ? renderer : null;
  } catch {
    return null;
  }
}

/** At this rate a saved VP8 follows Auto's rule too: software VP8 cannot
 *  encode 1080p at 120 fps and drops to about 60 (M-2). */
export const HARDWARE_CODEC_FPS = 120;

/** The codec for one publish: the preferred one when every channel peer
 *  decodes it, else VP8 (E2EE leaves no backup codec). `peers` is read after
 *  the preferred codec resolves, so it reflects the roster at publish time.
 *  It is a parameter, not a store read, to keep this module (which the
 *  settings UI imports) free of the voice store. Omitted means no peers. */
export async function resolveVideoCodec(
  track: MediaStreamTrack,
  fps: number,
  bitrate: number,
  peers: () => PeerDecodeLists = () => [],
): Promise<PublishCodec> {
  return pickCommonCodec(await resolvePreferredCodec(track, fps, bitrate), peers());
}

/** The codec for one publish of `track` at `fps` and `bitrate`, before peers
 *  are considered. Auto probes at the captured size, since a hardware encoder
 *  can take 1080p30 and refuse 1080p120. A saved VP8 is probed the same way at
 *  120 fps; a saved H.264 never is. */
async function resolvePreferredCodec(
  track: MediaStreamTrack,
  fps: number,
  bitrate: number,
): Promise<PublishCodec> {
  if (isLinuxDesktop()) return "vp8";
  const pref = getVideoCodecPref();
  if (pref === "h264") return pref;
  if (pref === "vp8" && fps < HARDWARE_CODEC_FPS) return pref;
  try {
    const { width, height } = track.getSettings();
    const probe = await navigator.mediaCapabilities.encodingInfo({
      type: "webrtc",
      video: { contentType: "video/H264", width, height, bitrate, framerate: fps },
    } as MediaEncodingConfiguration);
    return pickAutoCodec(probe, gpuRenderer());
  } catch {
    // No MediaCapabilities, a configuration the browser rejects, or a track
    // that cannot report its size.
    return pickAutoCodec(null, null);
  }
}
