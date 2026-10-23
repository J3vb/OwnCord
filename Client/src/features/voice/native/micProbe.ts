// A one-second look at the native capture for the diagnostics microphone
// check (Linux): the settings tab's capture-only monitor, which opens the
// chosen device and reports levels without playing anything.
import { createLogger } from "@lib/logger";
import { setOwnedTimeout } from "@lib/dom";
import { desktop } from "../../../platform/desktop";
import { NATIVE_MIC_TEST_IN_CALL } from "../../../platform/contracts/nativeVoice";

const log = createLogger("micProbe");

/** How long the opened capture is watched for level reports. */
export const PROBE_WINDOW_MS = 1000;

/** `levels`: the device opened and reported audio; `silent`: it opened but
 *  nothing or only digital silence arrived; `in-call`: a call owns the
 *  capture, so none was opened. */
export type NativeMicProbe = "levels" | "silent" | "in-call";

/** Open `input` (empty: the host default), count its level reports for
 *  `PROBE_WINDOW_MS` and stop it. A rejected open rejects. Aborting `signal`
 *  rejects with its reason and stops the capture, also one still opening. */
export async function probeNativeMicrophone(
  input: string,
  signal: AbortSignal,
): Promise<NativeMicProbe> {
  signal.throwIfAborted();
  const levels = new Map<number, number>();
  const unsubscribe = desktop.nativeVoice.onMicTestEvent(({ test, event }) => {
    // A muted or blocked source still reports, at exactly zero.
    if (event.type === "inputLevel" && event.rms > 0) levels.set(test, (levels.get(test) ?? 0) + 1);
  });
  const aborted = new Promise<never>((_, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  aborted.catch(() => {});
  const opening = desktop.nativeVoice.startMicTest({
    input,
    output: "",
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      enhancedNoiseSuppression: false,
    },
    inputGain: 100,
    outputGain: 0,
    threshold: 0,
    monitor: true,
  });
  try {
    const id = await Promise.race([opening, aborted]);
    await Promise.race([
      new Promise<void>((resolve) => setOwnedTimeout(signal, resolve, PROBE_WINDOW_MS)),
      aborted,
    ]);
    return (levels.get(id) ?? 0) > 0 ? "levels" : "silent";
  } catch (err) {
    if (err instanceof Error && err.message === NATIVE_MIC_TEST_IN_CALL) return "in-call";
    throw err;
  } finally {
    unsubscribe();
    // Also a start still in flight: it is stopped the moment it resolves.
    opening
      .then((id) => desktop.nativeVoice.stopMicTest(id))
      .catch((err: unknown) => {
        log.debug("The microphone probe left nothing to stop", err);
      });
  }
}
