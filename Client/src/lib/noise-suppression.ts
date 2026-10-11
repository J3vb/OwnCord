// =============================================================================
// Noise Suppression — RNNoise ML-based noise removal as an AudioWorkletNode
//
// RNNoise processes 480-sample frames at 48kHz (10ms) in an AudioWorklet
// (public/rnnoise-worklet.js), which instantiates public/rnnoise.wasm itself.
// The node sits in the microphone processor's graph (lib/micProcessor.ts).
// =============================================================================

import { createLogger } from "@lib/logger";

const log = createLogger("noise-suppression");

export interface RNNoiseNode {
  readonly node: AudioWorkletNode;
  destroy(): void;
}

let rnnoiseBytes: Promise<ArrayBuffer> | null = null;

/** Fetch rnnoise.wasm once; later joins reuse the bytes (each node gets its own copy). */
function loadRNNoiseBytes(): Promise<ArrayBuffer> {
  if (rnnoiseBytes === null) {
    const loading = fetch("/rnnoise.wasm").then((response) => {
      // i18n-exempt: internal diagnostic, logged by micProcessor, never rendered
      if (response.ok === false) throw new Error(`rnnoise.wasm: HTTP ${response.status}`);
      return response.arrayBuffer();
    });
    rnnoiseBytes = loading;
    loading.catch(() => {
      if (rnnoiseBytes === loading) rnnoiseBytes = null;
    });
  }
  return rnnoiseBytes;
}

/** Load the worklet and WASM into `audioContext` and return a ready node. */
export async function createRNNoiseNode(audioContext: AudioContext): Promise<RNNoiseNode> {
  await audioContext.audioWorklet.addModule("/rnnoise-worklet.js");
  const bytesPromise = loadRNNoiseBytes();
  const cachedBytes = await bytesPromise;

  const node = new AudioWorkletNode(audioContext, "rnnoise-processor", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
  });

  const initPromise = new Promise<void>((resolve, reject) => {
    // oxlint-disable-next-line prefer-add-event-listener -- MessagePort does not support addEventListener
    node.port.onmessage = (event: MessageEvent) => {
      if (event.data.type === "ready") resolve();
      else if (event.data.type === "error") reject(new Error(event.data.message));
    };
  });
  const wasmBytes = cachedBytes.slice(0);
  // oxlint-disable-next-line require-post-message-target-origin -- MessagePort.postMessage, not Window.postMessage
  node.port.postMessage({ type: "init", wasmBytes }, [wasmBytes]);
  try {
    await initPromise;
  } catch (err) {
    // The worklet rejected these bytes (200 with an HTML fallback, truncated
    // wasm): drop the cache so the next join refetches instead of reusing them.
    if (rnnoiseBytes === bytesPromise) rnnoiseBytes = null;
    throw err;
  }

  log.info("RNNoise AudioWorklet processing active");

  return {
    node,
    destroy() {
      // oxlint-disable-next-line require-post-message-target-origin -- MessagePort.postMessage, not Window.postMessage
      node.port.postMessage({ type: "destroy" });
      node.disconnect();
      log.info("RNNoise AudioWorklet node destroyed");
    },
  };
}
