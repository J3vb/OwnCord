/**
 * Which video codecs this client decodes, and the pure rule that picks the one
 * codec every viewer in a channel can decode.
 *
 * Voice E2EE publishes no backup codec and the SFU cannot transcode, so a
 * sharer must publish a codec every channel peer decodes or that peer sees a
 * black tile. Each client reports its list in `voice_e2ee_announce`
 * (`video_decode`); a peer whose list is absent counts as the baseline, never
 * as a peer that decodes everything.
 */

import { readStored } from "@lib/preferences";
import { isLinuxDesktop } from "./native/platform";
import { nativeVideoCodecs } from "./native/videoCodecs";

export type VideoCodecName = "vp8" | "h264" | "vp9" | "h265" | "av1";

/** What every shipped client decodes, and so what an absent or empty list means. */
export const BASELINE_DECODE: readonly VideoCodecName[] = ["vp8", "h264"];

/** The codecs this build can decrypt under E2EE. AV1 is not one: the frame
 *  cryptor throws on it. */
const E2EE_DECRYPTABLE: ReadonlySet<string> = new Set(["vp8", "h264", "vp9", "h265"]);

/** Dev-only localStorage key: any value forces this client to report VP8 only,
 *  to exercise the downgrade by hand. */
export const DEV_VP8_ONLY_KEY = "owncord:dev:videoDecodeVp8Only";

/** The codecs the native engine's decode list may add to the baseline on Linux:
 *  the ones an interop run proves end to end with E2EE. H.265 and AV1 are never
 *  reported there. */
const NATIVE_DECODE_PROVEN: ReadonlySet<string> = new Set(["vp8", "h264", "vp9"]);

let memo: readonly VideoCodecName[] | null = null;

function devForcesVp8(): boolean {
  if (!import.meta.env.DEV) return false;
  return readStored(DEV_VP8_ONLY_KEY) !== null;
}

function probeReceiver(): readonly VideoCodecName[] {
  try {
    const codecs = RTCRtpReceiver.getCapabilities("video")?.codecs ?? [];
    const found = new Set<string>(BASELINE_DECODE);
    for (const { mimeType } of codecs) {
      const name = mimeType.split("/")[1]?.toLowerCase();
      if (name === undefined || !E2EE_DECRYPTABLE.has(name)) continue;
      found.add(name);
    }
    return [...found] as VideoCodecName[];
  } catch {
    // No RTCRtpReceiver, or getCapabilities threw.
    return BASELINE_DECODE;
  }
}

/** How long the announce waits for the native probe before it reports the
 *  baseline for this join (the answer is not memoised then). */
const NATIVE_PROBE_TIMEOUT_MS = 3000;

async function probeNative(): Promise<readonly VideoCodecName[] | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), NATIVE_PROBE_TIMEOUT_MS);
    });
    const codecs = await Promise.race([nativeVideoCodecs(), timeout]);
    if (codecs === null) return null;
    const found = new Set<string>(BASELINE_DECODE);
    for (const name of codecs.decode) {
      if (NATIVE_DECODE_PROVEN.has(name)) found.add(name);
    }
    return [...found] as VideoCodecName[];
  } catch {
    return BASELINE_DECODE;
  } finally {
    clearTimeout(timer);
  }
}

/** The codecs this client reports as decodable. Memoised. On Linux it asks
 *  the native engine (its receiver list, narrowed to the proven codecs) and
 *  reports the baseline when the probe fails or does not answer in time. */
export async function localVideoDecode(): Promise<readonly VideoCodecName[]> {
  if (devForcesVp8()) return ["vp8"];
  if (memo !== null) return memo;
  if (!isLinuxDesktop()) {
    memo = probeReceiver();
    return memo;
  }
  const native = await probeNative();
  if (native === null) return BASELINE_DECODE;
  memo = native;
  return memo;
}

/** Forget the memoised probe (tests). */
export function resetLocalVideoDecodeForTest(): void {
  memo = null;
}

/** Decode lists of the other users in a channel; `undefined` is a user whose
 *  list is unknown. */
export type PeerDecodeLists = ReadonlyArray<readonly string[] | undefined>;

/** `preferred` when every peer decodes it, else VP8. An absent or empty peer
 *  list is the baseline; no peers means `preferred`. */
export function pickCommonCodec<C extends "vp8" | "h264" | "vp9" | "h265">(
  preferred: C,
  peers: PeerDecodeLists,
): C | "vp8" {
  for (const list of peers) {
    const decodes = list === undefined || list.length === 0 ? BASELINE_DECODE : list;
    if (!decodes.includes(preferred)) return "vp8";
  }
  return preferred;
}
