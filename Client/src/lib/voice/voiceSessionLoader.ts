/**
 * How the layers below `features/` reach the voice session facade
 * (`features/voice/livekitSession.ts`) without importing upward.
 *
 * `main.ts` registers a loader at boot that lazily imports the facade, so the
 * facade (and the ~1.3 MB livekit-client SDK behind it) stays out of the
 * startup chunk exactly as the direct `import()` it replaces did. A caller
 * awaits `loadVoiceSession()` the way it awaited that `import()`: the module
 * is loaded on first use and served from the module cache after.
 */

/** The two facade calls that `stores/auth.store` and the desktop push-to-talk
 *  service make. */
export interface VoiceSessionControls {
  leaveVoice(sendWs: boolean): unknown;
  setPttGated(gated: boolean, releaseDelayMs?: number): void;
}

type VoiceSessionLoader = () => Promise<VoiceSessionControls>;

let loader: VoiceSessionLoader | null = null;

/** Called once by `main.ts` at boot (and by the test setup). */
export function registerVoiceSessionLoader(load: VoiceSessionLoader): void {
  loader = load;
}

/** Loads the voice session facade. Rejects when no loader is registered, which
 *  every caller already handles as it handled a failed `import()`. */
export function loadVoiceSession(): Promise<VoiceSessionControls> {
  if (loader === null) {
    // i18n-exempt: developer error, main.ts registers the loader at boot
    return Promise.reject(new Error("voice session loader is not registered"));
  }
  return loader();
}
