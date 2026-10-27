// =============================================================================
// PCM capture AudioWorklet (WP 8.9): the voice-message recorder's fallback for a
// webview whose MediaRecorder supports no audio container. It forwards the
// mono input to the main thread in ~2048-sample blocks; the main thread encodes
// the WAV.
//
// Protocol:
//   Worklet -> Main: Float32Array (one block of mono samples)
//   Main -> Worklet: { type: "flush" }  (posts the partial block, then { type: "flushed" })
// =============================================================================

const BLOCK = 2048;

class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buf = new Float32Array(BLOCK);
    this._len = 0;
    this.port.onmessage = (e) => {
      if (e.data && e.data.type === "flush") {
        this._flush();
        this.port.postMessage({ type: "flushed" });
      }
    };
  }

  _flush() {
    if (this._len === 0) return;
    this.port.postMessage(this._buf.slice(0, this._len));
    this._len = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) {
      for (let i = 0; i < channel.length; i++) {
        this._buf[this._len++] = channel[i];
        if (this._len === BLOCK) this._flush();
      }
    }
    return true;
  }
}

registerProcessor("pcm-capture", PcmCaptureProcessor);
