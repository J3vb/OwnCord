import type { SileroInput } from "./sileroWorker";
import type { SpeechDetection } from "../../lib/voice/audioPipeline";
import type { MicProcessor } from "../../lib/voice/micProcessor";

export function createSpeechDetection(
  source: AudioNode,
  setOn: (enabled: boolean) => Promise<boolean>,
  silero?: SileroInput,
): SpeechDetection {
  return {
    numberOfInputs: silero === undefined ? 2 : 3,
    bind(node) {
      let enabled = false;
      let loading = false;
      let setGate: ((on: boolean) => void) | undefined;
      return (on) => {
        enabled = on;
        if (setGate !== undefined) {
          setGate(on);
          return;
        }
        if (!on || loading) return;
        loading = true;
        void import("./sileroWorker").then(
          ({ bindSpeechDetection }) => {
            loading = false;
            if (!enabled) return;
            setGate = bindSpeechDetection(node, source, setOn, silero);
            setGate(true);
          },
          () => {
            loading = false;
            if (!enabled) return;
            // oxlint-disable-next-line require-post-message-target-origin -- MessagePort.postMessage
            node.port.postMessage({ type: "speechGate", on: false });
          },
        );
      };
    },
  };
}

/** Bind the call or settings mic graph to the feature's speech classifier. */
export function speechDetectionOf(processor: MicProcessor): SpeechDetection | undefined {
  const source = processor.speechProbability;
  if (source === null) return undefined;
  const input = typeof Worker === "undefined" ? null : processor.speechInput;
  return createSpeechDetection(
    source,
    (on) => processor.setSpeechDetection(on),
    input === null
      ? undefined
      : { source: input, setActive: (on) => processor.setSileroActive(on) },
  );
}
