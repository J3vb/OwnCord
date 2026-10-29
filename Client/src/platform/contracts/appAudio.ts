/**
 * Windows per-app share audio: the host captures the sound of the
 * app that owns a shared window and serves it to the page on a loopback
 * WebSocket (`src-tauri/src/windows_app_audio.rs`). One capture at a time; a
 * new `start` replaces the running one. Every operation resolves with a typed
 * result and never rejects: off Windows, in a plain browser or when the host
 * call fails, the answer is "unavailable".
 */

/** The host's refusal codes (`windows_app_audio.rs`), plus "unavailable" for
 *  an absent or failing host. */
export type AppAudioErrorCode =
  | "unavailable"
  | "not_window"
  | "own_window"
  | "ancestor"
  | "not_found"
  | "ambiguous"
  | "activation_failed"
  | "superseded"
  | "internal";

/** Where the page reads the app's sound, or why it cannot. */
export type AppAudioStart =
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly code: AppAudioErrorCode };

export interface AppAudio {
  /** Whether this machine can capture one app's sound. */
  available(): Promise<boolean>;
  /** Capture the app that owns the shared window `label` (`surface` is the
   *  share's `displaySurface`). Stops a running capture first. */
  start(label: string, surface: string): Promise<AppAudioStart>;
  /** Stop the running capture, if any. */
  stop(): Promise<void>;
}
