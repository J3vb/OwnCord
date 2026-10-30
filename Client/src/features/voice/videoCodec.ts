/**
 * The codec the camera and screen share publish with.
 *
 * Voice E2EE is always on, and livekit-client then publishes no backup codec,
 * so every viewer must decode the one chosen here or see a black tile. VP8 and
 * H.264 are the two every shipped client decodes; VP9 and H.265 are options
 * picked only when every peer reports decoding them (H.265 also needs a
 * hardware encoder and a non-Intel GPU). Auto is the default; H.264
 * lets Windows encode on the graphics card, and a saved H.264 the browser does
 * not report as hardware at the captured size publishes VP8 (the software
 * encoder is single-threaded and a large share drops to a few fps). The Linux
 * native engine publishes VP8, or H.264 or VP9 (software, one L1T3 layer, no
 * simulcast) only when chosen and the engine reports it can encode it. Its release build includes
 * NVENC/NVDEC, used for H.264 when the NVIDIA libraries load; VA-API (Intel,
 * AMD) is not built yet, and everything else is software (slower than VP8).
 * Auto is VP8 there. H.265 is never published on Linux.
 */

import { supportsH265, supportsVP9 } from "livekit-client";
import { loadPref } from "../../lib/prefs/preferences";
import { pickCommonCodec, type PeerDecodeLists } from "./decodeCaps";
import { isLinuxDesktop, isWindowsDesktop } from "./native/platform";
import { nativeVideoCodecs } from "./native/videoCodecs";

export type VideoCodecPref = "vp8" | "h264" | "vp9" | "h265" | "auto";
export type PublishCodec = "vp8" | "h264" | "vp9" | "h265";

/** The saved choice, Auto unless the user picked another. Nothing is saved
 *  until the user changes the select, so an untouched setting follows this. */
export function getVideoCodecPref(): VideoCodecPref {
  const saved = loadPref<string>("videoCodec", "auto");
  return saved === "vp8" || saved === "h264" || saved === "vp9" || saved === "h265"
    ? saved
    : "auto";
}

/** Whether this webview can publish VP9. livekit-client's check throws where
 *  `RTCRtpSender` does not exist (tests, a very old webview). */
function canPublishVp9(): boolean {
  try {
    return supportsVP9();
  } catch {
    return false;
  }
}

/** Whether the settings list VP9 off Linux: the webview can publish it. On
 *  Linux this is false; `vp9Available` asks the native engine. A share drops to
 *  a codec every viewer plays while one of them cannot play VP9. */
export function vp9Offered(): boolean {
  return !isLinuxDesktop() && canPublishVp9();
}

/** Whether VP9 can be published anywhere: the webview's check off Linux, and on
 *  Linux only when the native engine reports a VP9 encoder. A probe
 *  that fails reads as no. */
export async function vp9Available(): Promise<boolean> {
  return isLinuxDesktop() ? (await nativeVideoCodecs()).vp9 : canPublishVp9();
}

/** Whether the settings can offer H.264: always off Linux (the webview or
 *  WebView2 encodes it), and on Linux only when the native engine reports an
 *  H.264 encoder. A probe that fails reads as no. */
export async function h264Offered(): Promise<boolean> {
  return !isLinuxDesktop() || (await nativeVideoCodecs()).h264;
}

/** Whether this webview can publish H.265. livekit-client's check throws where
 *  `RTCRtpSender` does not exist, as `supportsVP9`'s does. */
function canPublishH265(): boolean {
  try {
    return supportsH265();
  } catch {
    return false;
  }
}

/** A GPU known not to be Intel's. livekit-client 2.22.3 cannot decrypt Intel
 *  Quick Sync H.264 under E2EE (see `pickAutoCodec`), and H.265 shares its
 *  start-code path, so it is assumed to fail the same way until a two-machine
 *  test says otherwise. `null` is a GPU that could not be named. */
function isKnownNonIntel(renderer: string | null): renderer is string {
  return renderer !== null && !/intel/i.test(renderer);
}

/** Whether the settings list H.265: not the Linux native engine, the webview
 *  can publish it and the GPU is not Intel's. Whether the encoder is a
 *  hardware one is probed per publish, not here. */
export function h265Offered(): boolean {
  return !isLinuxDesktop() && canPublishH265() && isKnownNonIntel(gpuRenderer());
}

/** Whether an H.264 publish here offers only H.264 Main and High
 *  (`lib/voice/h264Profile`): the Windows app, whose WebView2 encodes those on the
 *  graphics card and Constrained Baseline only in software, on a hardware GPU
 *  known not to be Intel's (see `isKnownNonIntel`). */
export function h264GpuProfiles(): boolean {
  const renderer = gpuRenderer();
  return isWindowsDesktop() && isKnownNonIntel(renderer) && !isSoftwareRenderer(renderer);
}

/** WebView2 without GPU acceleration, or over RDP or in a VM, renders in
 *  software: its encoders are software too, so the probe has to decide. */
function isSoftwareRenderer(renderer: string): boolean {
  return /swiftshader|basic render driver|llvmpipe|software/i.test(renderer);
}

/** Whether a publish of `codec` should offer only H.264 Main and High. */
export function h264GpuPublish(codec: PublishCodec): boolean {
  return codec === "h264" && h264GpuProfiles();
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
  return hardware && isKnownNonIntel(renderer) ? "h264" : "vp8";
}

/** The GPU's name from WebGL's unmasked renderer string, or null where WebGL
 *  or its debug extension is unavailable. Asks for the low-power GPU, so a
 *  laptop with two names its integrated one, the likelier video encoder. */
export function gpuRenderer(): string | null {
  try {
    const gl = document
      .createElement("canvas")
      .getContext("webgl", { powerPreference: "low-power" });
    if (!gl) return null;
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    const renderer: unknown = info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : null;
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return typeof renderer === "string" ? renderer : null;
  } catch {
    return null;
  }
}

/** At this rate a saved VP8 follows Auto's rule too: software VP8 cannot
 *  encode 1080p at 120 fps and drops to about 60. */
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
  return (await resolveCodecChoice(track, fps, bitrate, peers)).codec;
}

/** What one publish resolved: the codec it goes out with, and the one the
 *  user's settings asked for before peers were considered. The live switch
 *  keeps both, so it can tell when `codec` is no longer the pick and
 *  never has to re-read the settings mid-share. */
export interface CodecChoice {
  readonly preferred: PublishCodec;
  readonly codec: PublishCodec;
}

/** `resolveVideoCodec`, also reporting the preferred codec. */
export async function resolveCodecChoice(
  track: MediaStreamTrack,
  fps: number,
  bitrate: number,
  peers: () => PeerDecodeLists = () => [],
): Promise<CodecChoice> {
  const preferred = await resolvePreferredCodec(track, fps, bitrate);
  return { preferred, codec: pickCommonCodec(preferred, peers()) };
}

/** The codec for one publish of `track` at `fps` and `bitrate`, before peers
 *  are considered. Auto probes at the captured size, since a hardware encoder
 *  can take 1080p30 and refuse 1080p120. A saved VP8 is probed the same way at
 *  120 fps; a saved VP9 never is. A saved H.264 and a saved H.265 are probed at
 *  any rate: H.265 for H.265, H.264 for H.264, where an answer that is not
 *  hardware gives VP8 and no answer keeps the user's H.264. A saved H.264 in
 *  the Windows app on a non-Intel GPU is not probed (`h264GpuProfiles`). */
async function resolvePreferredCodec(
  track: MediaStreamTrack,
  fps: number,
  bitrate: number,
): Promise<PublishCodec> {
  const pref = getVideoCodecPref();
  // Linux: VP8 unless H.264 or VP9 is chosen and the native encoder has it.
  // Auto is VP8 (software H.264 is slower, and hardware H.264 under E2EE is
  // unproven), and a saved H.265 is VP8, as the select shows. A saved VP9 on an
  // engine without it is VP8 too; the pref is left alone.
  if (isLinuxDesktop()) {
    if (pref === "h264") return (await h264Offered()) ? "h264" : "vp8";
    if (pref === "vp9") return (await vp9Available()) ? "vp9" : "vp8";
    return "vp8";
  }
  // WebView2's encodingInfo answers powerEfficient:false for every WebRTC
  // config, so it cannot see the GPU encoder that Main/High reach. The live
  // check in `codecSwitch` still turns a share that lands on OpenH264 into VP8;
  // a camera has no such check and stays on the software encoder then.
  if (pref === "h264" && h264GpuProfiles()) return "h264";
  if (pref === "h264")
    return h264PublishCodec(await probeEncoder(track, fps, bitrate, "video/H264"));
  if (pref === "h265") return (await h265Publishable(track, fps, bitrate)) ? pref : "vp8";
  // livekit-client silently publishes VP8 for an unsupported VP9, which would
  // leave our log and the sender-stats readout naming the wrong codec. VP9
  // skips the 120 fps probe: Auto's rule is about hardware H.264. A saved VP9
  // the settings no longer offer publishes VP8, as the select shows.
  if (pref === "vp9") return canPublishVp9() ? pref : "vp8";
  if (pref === "vp8" && fps < HARDWARE_CODEC_FPS) return pref;
  const probe = await probeEncoder(track, fps, bitrate, "video/H264");
  return pickAutoCodec(probe, probe === null ? null : gpuRenderer());
}

/** MediaCapabilities' answer for encoding `contentType` at the track's size,
 *  `fps` and `bitrate`; null when there is no answer: no MediaCapabilities, a
 *  configuration the browser rejects, or a track that cannot report its size. */
async function probeEncoder(
  track: MediaStreamTrack,
  fps: number,
  bitrate: number,
  contentType: string,
): Promise<MediaCapabilitiesInfo | null> {
  try {
    const { width, height } = track.getSettings();
    return await navigator.mediaCapabilities.encodingInfo({
      type: "webrtc",
      video: { contentType, width, height, bitrate, framerate: fps },
    } as MediaEncodingConfiguration);
  } catch {
    return null;
  }
}

/** A saved H.264 off Linux: VP8 when the browser answers that H.264 is not
 *  encoded in hardware (the fallback is OpenH264, which WebRTC runs on one
 *  thread), and H.264 on no answer, which is no reason to override the choice.
 *  The browser may not weigh the frame size in its answer, so the live check
 *  in `codecSwitch` covers an encoder that refuses a large frame and falls
 *  back anyway. */
function h264PublishCodec(probe: MediaCapabilitiesInfo | null): PublishCodec {
  if (probe === null) return "h264";
  return probe.supported && probe.powerEfficient ? "h264" : "vp8";
}

/** A saved H.265 publishes only where the settings would offer it and the
 *  browser reports a hardware encoder at this size and rate: software H.265
 *  is slower than VP8. Anything else publishes VP8. */
async function h265Publishable(
  track: MediaStreamTrack,
  fps: number,
  bitrate: number,
): Promise<boolean> {
  if (!h265Offered()) return false;
  const probe = await probeEncoder(track, fps, bitrate, "video/H265");
  return probe?.supported === true && probe.powerEfficient;
}
