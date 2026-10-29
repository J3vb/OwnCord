// Fakes for the voice-message recorder (WP 8.9): a microphone stream whose
// tracks record that they were stopped, a MediaRecorder and an AudioContext.
import { vi } from "vitest";

export class FakeTrack extends EventTarget {
  stopped = false;
  stop = vi.fn(() => {
    this.stopped = true;
  });
}

export class FakeStream {
  readonly tracks = [new FakeTrack()];
  getTracks(): FakeTrack[] {
    return this.tracks;
  }
  get allStopped(): boolean {
    return this.tracks.every((t) => t.stopped);
  }
}

/** The level every fake analyser reports, 0..1 (set per test). */
export const analyserLevel = { value: 0.5 };

export class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  sampleRate = 48_000;
  state: AudioContextState = "running";
  closed = false;
  destination = {};
  audioWorklet = undefined;
  scriptProcessor: { onaudioprocess: ((e: unknown) => void) | null } | null = null;
  constructor() {
    FakeAudioContext.instances.push(this);
  }
  resume = vi.fn(async () => {});
  close = vi.fn(async () => {
    this.closed = true;
  });
  createMediaStreamSource() {
    return { connect: vi.fn(), disconnect: vi.fn() };
  }
  createAnalyser() {
    return {
      fftSize: 2048,
      connect: vi.fn(),
      disconnect: vi.fn(),
      getFloatTimeDomainData(buf: Float32Array) {
        buf.fill(0);
        buf[0] = analyserLevel.value;
      },
    };
  }
  createGain() {
    return { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() };
  }
  createScriptProcessor() {
    const node = {
      onaudioprocess: null as ((e: unknown) => void) | null,
      connect: vi.fn(),
      disconnect: vi.fn(),
    };
    this.scriptProcessor = node;
    return node;
  }
}

export class FakeMediaRecorder extends EventTarget {
  static supported: readonly string[] = ["audio/webm;codecs=opus"];
  static instances: FakeMediaRecorder[] = [];
  static isTypeSupported(type: string): boolean {
    return FakeMediaRecorder.supported.includes(type);
  }
  state: "inactive" | "recording" = "inactive";
  readonly mimeType: string;
  constructor(
    readonly stream: unknown,
    options: { mimeType?: string } = {},
  ) {
    super();
    this.mimeType = options.mimeType ?? "";
    FakeMediaRecorder.instances.push(this);
  }
  start() {
    this.state = "recording";
  }
  stop() {
    if (this.state === "inactive") return;
    this.state = "inactive";
    this.dispatchEvent(
      Object.assign(new Event("dataavailable"), {
        data: new Blob(["opus-bytes"], { type: this.mimeType }),
      }),
    );
    this.dispatchEvent(new Event("stop"));
  }
}

export function resetFakes(): void {
  FakeAudioContext.instances = [];
  FakeMediaRecorder.instances = [];
  FakeMediaRecorder.supported = ["audio/webm;codecs=opus"];
  analyserLevel.value = 0.5;
}

export function blobBytes(blob: Blob): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}
