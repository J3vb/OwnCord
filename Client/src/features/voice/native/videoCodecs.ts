// Which video codecs beyond VP8 the Linux native engine can encode (WP LP-7c),
// asked of libwebrtc once and remembered: the answer is fixed by the build.
import { desktop } from "../../../platform/desktop";
import type { NativeVoiceVideoCodecs } from "../../../platform/contracts/nativeVoice";
import { isLinuxDesktop } from "./platform";

let probe: Promise<NativeVoiceVideoCodecs> | null = null;

/** The native engine's encodable codecs. Off Linux there is no native engine,
 *  so nothing extra. A failed probe is "no H.264" (the desktop service
 *  resolves it so), which keeps the picker's H.264 disabled and every publish
 *  on VP8. */
export function nativeVideoCodecs(): Promise<NativeVoiceVideoCodecs> {
  if (!isLinuxDesktop()) return Promise.resolve({ h264: false });
  probe ??= desktop.nativeVoice.videoCodecs().catch(() => ({ h264: false }));
  return probe;
}

/** Forget the remembered probe. Tests only. */
export function resetNativeVideoCodecsForTest(): void {
  probe = null;
}
