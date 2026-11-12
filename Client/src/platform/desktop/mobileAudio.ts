// The Android app's call audio (`src-tauri/src/mobile_audio.rs`,
// `MobileAudioPlugin.kt`): a facade that loads the host side
// (`./mobileAudioHost.ts`) on first use (`./androidHost.ts`).
import { androidHost } from "./androidHost";
import type { MobileAudio } from "../contracts/mobileAudio";

const withHost = androidHost("mobileAudio", () => import("./mobileAudioHost"));

export const mobileAudio: MobileAudio = {
  watch: (signal, onState) => withHost((host) => host.watch(signal, onState)),
  setSession: (active) => withHost((host) => host.setSession(active)),
  setRoute: (kind) => withHost((host) => host.setRoute(kind)),
  refresh: () => withHost((host) => host.refresh()),
};
