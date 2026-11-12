// The Android app's call audio (`src-tauri/src/mobile_audio.rs`,
// `MobileAudioPlugin.kt`): a facade that loads the host side
// (`./mobileAudioHost.ts`) on first use. The registry is in the startup chunk
// of every build, and only the Android app has a host to talk to.
import { isAndroidHost } from "@lib/hostPlatform";
import { createLogger } from "@lib/logger";
import type { MobileAudio } from "../contracts/mobileAudio";

type Host = typeof import("./mobileAudioHost");

const log = createLogger("mobileAudio");
let loading: Promise<Host> | null = null;

/** Run `use` on the host side. One load carries every call, so they reach the
 *  host in the order they were made. Never throws. */
function withHost(use: (host: Host) => void): void {
  if (!isAndroidHost()) return;
  loading ??= import("./mobileAudioHost");
  loading.then(use).catch((err: unknown) => {
    loading = null;
    log.warn("Call audio unavailable", err);
  });
}

export const mobileAudio: MobileAudio = {
  watch: (signal, onState) => withHost((host) => host.watch(signal, onState)),
  setSession: (active) => withHost((host) => host.setSession(active)),
  setRoute: (kind) => withHost((host) => host.setRoute(kind)),
  refresh: () => withHost((host) => host.refresh()),
};
