import { createLogger } from "../../lib/logger";
import { publicAssetUrl } from "../../lib/media/publicAssets";

const log = createLogger("sileroWorker");
const INIT_TIMEOUT_MS = 4000;

export interface SileroInput {
  readonly source: AudioNode;
  setActive(active: boolean): void;
}

/** Connect an owned worker to the worklet over a private channel. PCM stays
 *  between the two audio components and is discarded after scoring. */
function startSileroDetection(
  node: AudioWorkletNode,
  input: SileroInput,
  fallback: () => void,
): (() => void) | null {
  if (typeof Worker === "undefined" || typeof MessageChannel === "undefined") return null;

  let worker: Worker;
  try {
    worker = new Worker(publicAssetUrl("silero-vad-worker.js"), { type: "module" });
  } catch (error) {
    log.warn("Silero worker could not start", error);
    return null;
  }
  const channel = new MessageChannel();
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    worker.terminate();
    input.source.disconnect(node, 0, 2);
    input.setActive(false);
    // oxlint-disable-next-line require-post-message-target-origin -- MessagePort.postMessage
    node.port.postMessage({ type: "silero", port: null });
  };
  const failed = (error: unknown): void => {
    if (closed) return;
    log.warn("Silero unavailable, using the RNNoise gate", error);
    close();
    fallback();
  };
  // i18n-exempt: internal diagnostic log for the RNNoise fallback
  const timer = setTimeout(() => failed("model initialization timed out"), INIT_TIMEOUT_MS);

  worker.addEventListener("error", (event) => failed(event.message));
  // i18n-exempt: internal diagnostic log for the RNNoise fallback
  worker.addEventListener("messageerror", () => failed("invalid worker message"));
  worker.addEventListener("message", (event: MessageEvent) => {
    if (closed) return;
    if (event.data.type === "error") failed(event.data.message);
    else if (event.data.type === "ready") {
      clearTimeout(timer);
      input.setActive(true);
      // oxlint-disable-next-line require-post-message-target-origin -- MessagePort.postMessage
      node.port.postMessage({ type: "sileroReady" });
      log.info("Silero speech detection active");
    }
  });

  input.source.connect(node, 0, 2);
  // oxlint-disable-next-line require-post-message-target-origin -- MessagePort.postMessage
  node.port.postMessage({ type: "silero", port: channel.port1 }, [channel.port1]);
  worker.postMessage({ port: channel.port2 }, [channel.port2]);
  return close;
}

/** Switch the classifier without replacing the detector or its noise floor. */
export function bindSpeechDetection(
  node: AudioWorkletNode,
  source: AudioNode,
  setOn: (enabled: boolean) => Promise<boolean>,
  silero?: SileroInput,
): (enabled: boolean) => void {
  source.connect(node, 0, 1);
  let enabled = false;
  let stopSilero: (() => void) | null = null;
  let revision = 0;
  const report = (on: boolean): void => {
    // oxlint-disable-next-line require-post-message-target-origin -- MessagePort.postMessage
    node.port.postMessage({ type: "speechGate", on });
  };
  return (next) => {
    if (next === enabled) return;
    enabled = next;
    const request = ++revision;
    if (!next) {
      stopSilero?.();
      stopSilero = null;
      report(false);
      void setOn(false).catch((err: unknown) => log.debug("Speech detection stop", err));
      return;
    }
    const startRnnoise = (): void => {
      setOn(true).then(
        (on) => {
          if (request === revision) report(on);
        },
        (err: unknown) => {
          if (request !== revision) return;
          log.warn("Speech detection could not start", err);
          report(false);
        },
      );
    };
    stopSilero = silero === undefined ? null : startSileroDetection(node, silero, startRnnoise);
    if (stopSilero === null) startRnnoise();
  };
}
