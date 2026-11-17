/**
 * Music share: list the apps that play sound and capture one of them.
 * Windows captures in the host (`src-tauri/src/windows_app_audio/music.rs`) and
 * serves the sound to the page on a loopback WebSocket, which the page
 * publishes; Linux publishes in the native voice backend, so only the list and
 * the support probe live here (start and stop are `NativeVoice.startMusic` and
 * `stopMusic`). Every operation resolves with a typed result and never
 * rejects: in a browser, on Android or when the host call fails, the answer is
 * "unavailable".
 */

/** One app with sound on the default output. */
export interface AudioApp {
  /** Opaque id the page hands back to start a capture. */
  readonly id: string;
  readonly name: string;
  /** Small PNG data URL, or null. */
  readonly icon: string | null;
  /** Sound is playing right now, not only an open session. */
  readonly playing: boolean;
}

/** The host's refusal codes, plus "unavailable" for an absent or failing host. */
export type MusicErrorCode =
  "unavailable" | "not_found" | "activation_failed" | "superseded" | "internal";

/** Why this machine cannot share music, for the button's short reason. */
export type MusicUnsupportedReason =
  "browser" | "android" | "platform" | "windowsOld" | "noSoundServer";

export type MusicSupport =
  { readonly ok: true } | { readonly ok: false; readonly reason: MusicUnsupportedReason };

export type MusicAppList =
  | { readonly ok: true; readonly apps: readonly AudioApp[] }
  | { readonly ok: false; readonly code: MusicErrorCode };

/** Where the page reads the app's sound (Windows), or why it cannot. */
export type MusicStart =
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly code: MusicErrorCode };

export interface MusicAudio {
  /** Whether this machine can share an app's sound, and if not, why. */
  support(): Promise<MusicSupport>;
  /** Apps with sound, playing ones first. */
  listApps(): Promise<MusicAppList>;
  /** Windows: capture app `appId`, replacing a running capture. Other
   *  hosts answer "unavailable" (Linux publishes through `NativeVoice`). */
  start(appId: string): Promise<MusicStart>;
  /** Windows: stop the capture, if any. */
  stop(): Promise<void>;
}
