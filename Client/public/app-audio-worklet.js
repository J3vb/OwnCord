// =============================================================================
// App-audio AudioWorklet Processor (Windows per-app share audio, WP 6.7b)
//
// The host captures one app's sound and sends it over a loopback WebSocket as
// 10 ms frames of interleaved stereo float32 (480 frames, 960 samples). The
// page forwards each frame here; this processor plays them out through a small
// jitter buffer and feeds a MediaStreamAudioDestinationNode, whose track is
// published as the share's audio.
//
// Jitter buffer: playback waits until TARGET_FRAMES (40 ms) are buffered, then
// plays on. If the buffer runs dry it outputs silence until it has refilled to
// the target again, so one late frame is not a stream of clicks. The buffer
// never holds more than CAP_FRAMES (200 ms): beyond that the oldest audio is
// dropped, so a stalled render thread cannot add delay that never goes away.
// A burst can still leave it parked near the cap, so when more than twice the
// target stays buffered for a second the oldest audio is dropped back to the
// target (one audible skip instead of a permanent 200 ms lag).
//
// Protocol:
//   Main → Worklet:  Float32Array (interleaved L R L R ..., transferred)
// =============================================================================

const APP_AUDIO_SAMPLE_RATE = 48000;
const APP_AUDIO_CHANNELS = 2;
/** Playback starts (and restarts after an underrun) at this much audio: 40 ms. */
const APP_AUDIO_TARGET_FRAMES = (APP_AUDIO_SAMPLE_RATE * 40) / 1000;
/** The most audio ever held: 200 ms. */
const APP_AUDIO_CAP_FRAMES = (APP_AUDIO_SAMPLE_RATE * 200) / 1000;
/** Buffered above twice the target for this long (1 s) is trimmed to the target. */
const APP_AUDIO_TRIM_AFTER_FRAMES = APP_AUDIO_SAMPLE_RATE;

class AppAudioJitterBuffer {
  constructor(targetFrames, capFrames) {
    this._target = targetFrames;
    this._cap = capFrames;
    /** Interleaved chunks, oldest first. */
    this._chunks = [];
    /** Samples already read from the oldest chunk. */
    this._offset = 0;
    this._frames = 0;
    this._primed = false;
    /** Frames played while more than twice the target was buffered. */
    this._highFrames = 0;
  }

  get frames() {
    return this._frames;
  }

  get playing() {
    return this._primed;
  }

  /** Queue interleaved stereo samples; drops the oldest audio beyond the cap. */
  push(samples) {
    const frames = Math.floor(samples.length / APP_AUDIO_CHANNELS);
    if (frames === 0) return;
    this._chunks.push(samples);
    this._frames += frames;
    this._drop(this._frames - this._cap);
  }

  /** Drop the `excess` oldest frames. */
  _drop(excess) {
    while (excess > 0 && this._chunks.length > 0) {
      const head = this._chunks[0];
      const headFrames = (head.length - this._offset) / APP_AUDIO_CHANNELS;
      if (headFrames <= excess) {
        this._chunks.shift();
        this._offset = 0;
        this._frames -= headFrames;
        excess -= headFrames;
      } else {
        this._offset += excess * APP_AUDIO_CHANNELS;
        this._frames -= excess;
        excess = 0;
      }
    }
  }

  /**
   * Fill `left` and `right` (equal length) with the next frames. Returns true
   * when they carry audio, false when they were left silent (still filling, or
   * not enough buffered: the buffer then waits for the target again).
   */
  pull(left, right) {
    const need = left.length;
    if (!this._primed && this._frames >= this._target) this._primed = true;
    if (!this._primed) {
      this._highFrames = 0;
      return this._silence(left, right);
    }
    if (this._frames < need) {
      this._primed = false;
      return this._silence(left, right);
    }
    let written = 0;
    while (written < need) {
      const head = this._chunks[0];
      const available = (head.length - this._offset) / APP_AUDIO_CHANNELS;
      const take = Math.min(available, need - written);
      for (let i = 0; i < take; i++) {
        left[written + i] = head[this._offset + i * 2];
        right[written + i] = head[this._offset + i * 2 + 1];
      }
      written += take;
      this._offset += take * APP_AUDIO_CHANNELS;
      this._frames -= take;
      if (this._offset >= head.length) {
        this._chunks.shift();
        this._offset = 0;
      }
    }
    if (this._frames > this._target * 2) {
      this._highFrames += need;
      if (this._highFrames >= APP_AUDIO_TRIM_AFTER_FRAMES) {
        this._drop(this._frames - this._target);
        this._highFrames = 0;
      }
    } else {
      this._highFrames = 0;
    }
    return true;
  }

  _silence(left, right) {
    left.fill(0);
    right.fill(0);
    return false;
  }
}

class AppAudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = new AppAudioJitterBuffer(APP_AUDIO_TARGET_FRAMES, APP_AUDIO_CAP_FRAMES);
    // oxlint-disable-next-line prefer-add-event-listener -- MessagePort does not support addEventListener
    this.port.onmessage = (event) => {
      const data = event.data;
      if (data instanceof Float32Array) this._buffer.push(data);
    };
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    if (out === undefined || out.length === 0) return true;
    const left = out[0];
    // A mono-configured output gets the left channel only.
    const right = out.length > 1 ? out[1] : new Float32Array(left.length);
    this._buffer.pull(left, right);
    return true;
  }
}

registerProcessor("app-audio-processor", AppAudioProcessor);
