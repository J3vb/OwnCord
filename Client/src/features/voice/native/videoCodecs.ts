// Which video codecs the Linux native engine encodes beyond VP8 and
// decodes, asked of libwebrtc once and remembered: the answer is
// fixed by the build.
import { desktop } from "../../../platform/desktop";
import type { NativeVoiceVideoCodecs } from "../../../platform/contracts/nativeVoice";
import { isLinuxDesktop } from "./platform";

const NONE: NativeVoiceVideoCodecs = { h264: false, vp9: false, decode: [] };

let probe: Promise<NativeVoiceVideoCodecs> | null = null;

/** The native engine's codecs. Off Linux there is no native engine, so
 *  nothing extra. A failed probe is "no H.264, no VP9, no decode list" (the
 *  desktop service resolves it so), which keeps the picker's H.264 disabled,
 *  every publish on VP8 and the announce on the baseline. */
export function nativeVideoCodecs(): Promise<NativeVoiceVideoCodecs> {
  if (!isLinuxDesktop()) return Promise.resolve(NONE);
  probe ??= desktop.nativeVoice.videoCodecs().catch(() => NONE);
  return probe;
}

/** Forget the remembered probe. Tests only. */
export function resetNativeVideoCodecsForTest(): void {
  probe = null;
}
