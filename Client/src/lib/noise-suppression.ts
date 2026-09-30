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

/** Load the worklet and WASM into `audioContext` and return a ready node. */
export async function createRNNoiseNode(audioContext: AudioContext): Promise<RNNoiseNode> {
  await audioContext.audioWorklet.addModule("/rnnoise-worklet.js");
  const wasmResponse = await fetch("/rnnoise.wasm");
  const wasmBytes = await wasmResponse.arrayBuffer();

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
  // oxlint-disable-next-line require-post-message-target-origin -- MessagePort.postMessage, not Window.postMessage
  node.port.postMessage({ type: "init", wasmBytes }, [wasmBytes]);
  await initPromise;

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
