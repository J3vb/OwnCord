import { createLogger } from "@lib/logger";
import { publicAssetUrl } from "@lib/media/publicAssets";

const log = createLogger("sileroDetection");
const INIT_TIMEOUT_MS = 4000;

export interface SileroInput {
  readonly source: AudioNode;
  setActive(active: boolean): void;
}

/** Connect an owned worker to the worklet over a private channel. PCM stays
 *  between the two audio components and is discarded after scoring. */
export function startSileroDetection(
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
  };
  const failed = (error: unknown): void => {
    if (closed) return;
    log.warn("Silero unavailable, using the RNNoise gate", error);
    close();
    // oxlint-disable-next-line require-post-message-target-origin -- MessagePort.postMessage
    node.port.postMessage({ type: "silero", port: null });
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
