/**
 * A Web Audio stand-in for jsdom: every node records its connections, gain
 * changes land on `gain.value` at once, and the destination's stream carries
 * one fake track. `vi.stubGlobal("AudioContext", FakeAudioContext)` and, for
 * code that builds `new MediaStream([track])`, `vi.stubGlobal("MediaStream",
 * FakeMediaStream)`.
 */
import { vi } from "vitest";

export interface FakeNode {
  readonly kind: string;
  readonly outputs: FakeNode[];
  connect(node: FakeNode): FakeNode;
  disconnect(): void;
}

function node(kind: string, extra: Record<string, unknown> = {}): FakeNode & Record<string, any> {
  const n: FakeNode & Record<string, any> = {
    kind,
    outputs: [],
    connect(target: FakeNode) {
      n.outputs.push(target);
      return target;
    },
    disconnect() {
      n.outputs.length = 0;
    },
    ...extra,
  };
  return n;
}

export function fakeMediaStreamTrack(id: string, kind = "audio"): MediaStreamTrack {
  return {
    kind,
    id,
    label: id,
    enabled: true,
    muted: false,
    readyState: "live",
    getSettings: () => ({ deviceId: id }),
    getConstraints: () => ({}),
    applyConstraints: vi.fn(async () => {}),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    stop: vi.fn(),
  } as unknown as MediaStreamTrack;
}

export class FakeMediaStream {
  constructor(readonly tracks: MediaStreamTrack[] = []) {}
  getTracks = (): MediaStreamTrack[] => this.tracks;
  getAudioTracks = (): MediaStreamTrack[] => this.tracks.filter((t) => t.kind === "audio");
  getVideoTracks = (): MediaStreamTrack[] => this.tracks.filter((t) => t.kind === "video");
}

let contexts = 0;

export class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  /** Whether addModule resolves (worklets available) or rejects. */
  static workletsLoad = false;
  readonly id = ++contexts;
  readonly sampleRate: number;
  state = "running";
  currentTime = 0;
  readonly nodes: Array<FakeNode & Record<string, any>> = [];
  /** The one track every MediaStreamDestination of this context emits. */
  readonly outputTrack: MediaStreamTrack;
  readonly audioWorklet: { addModule: ReturnType<typeof vi.fn> };
  readonly resume = vi.fn(async () => {});
  readonly close = vi.fn(async () => {
    this.state = "closed";
  });

  constructor(options?: { sampleRate?: number }) {
    this.sampleRate = options?.sampleRate ?? 48000;
    this.outputTrack = fakeMediaStreamTrack(`processed-${this.id}`);
    // Rejects unless a test resolves it: jsdom has no worklets.
    this.audioWorklet = {
      addModule: vi.fn(async () =>
        FakeAudioContext.workletsLoad ? undefined : Promise.reject(new Error("no worklet")),
      ),
    };
    FakeAudioContext.instances.push(this);
  }

  private make(kind: string, extra: Record<string, unknown> = {}) {
    const n = node(kind, extra);
    this.nodes.push(n);
    return n;
  }

  createGain() {
    const gain = { value: 1, setValueAtTime: vi.fn(), setTargetAtTime: vi.fn() };
    gain.setValueAtTime.mockImplementation((v: number) => {
      gain.value = v;
    });
    gain.setTargetAtTime.mockImplementation((v: number) => {
      gain.value = v;
    });
    return this.make("gain", { gain });
  }

  createAnalyser() {
    return this.make("analyser", {
      fftSize: 2048,
      smoothingTimeConstant: 0,
      getFloatTimeDomainData: vi.fn((arr: Float32Array) => arr.fill(0)),
      // livekit-client's silence check on a new LocalAudioTrack reads this.
      getByteTimeDomainData: vi.fn((arr: Uint8Array) => arr.fill(128)),
    });
  }

  createDelay(maxDelay = 1) {
    return this.make("delay", { maxDelay, delayTime: { value: 0 } });
  }

  createMediaStreamSource(stream: { getTracks?: () => MediaStreamTrack[] }) {
    return this.make("source", { track: stream.getTracks?.()[0] });
  }

  createMediaStreamDestination() {
    return this.make("destination", { stream: new FakeMediaStream([this.outputTrack]) });
  }

  /** Whether `from` reaches `to` through connections. */
  reaches(from: FakeNode, to: FakeNode): boolean {
    const seen = new Set<FakeNode>();
    const walk = (n: FakeNode): boolean => {
      if (n === to) return true;
      if (seen.has(n)) return false;
      seen.add(n);
      return n.outputs.some(walk);
    };
    return walk(from);
  }

  node(kind: string): FakeNode & Record<string, any> {
    const found = this.nodes.filter((n) => n.kind === kind);
    if (found.length !== 1) throw new Error(`${found.length} ${kind} nodes`);
    return found[0]!;
  }

  /** The most recently created node of a kind (sources are replaced on restart). */
  latest(kind: string): FakeNode & Record<string, any> {
    const found = this.nodes.filter((n) => n.kind === kind);
    if (found.length === 0) throw new Error(`no ${kind} node`);
    return found[found.length - 1]!;
  }
}

/** Stubs for one test: `AudioContext` and `MediaStream`. With `worklets`,
 *  also an AudioWorkletNode whose port records config messages and can be
 *  driven with `emit`, and contexts whose addModule resolves. */
export function installFakeAudio(options: { worklets?: boolean } = {}): void {
  FakeAudioContext.instances = [];
  FakeAudioContext.workletsLoad = options.worklets === true;
  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal("MediaStream", FakeMediaStream);
  if (options.worklets === true) {
    FakeAudioWorkletNode.instances = [];
    vi.stubGlobal("AudioWorkletNode", FakeAudioWorkletNode);
  }
}

export class FakeAudioWorkletNode {
  static instances: FakeAudioWorkletNode[] = [];
  readonly port = {
    onmessage: null as ((event: { data: unknown }) => void) | null,
    postMessage: vi.fn(),
  };
  readonly outputs: FakeNode[] = [];
  readonly kind = "worklet";
  connect = vi.fn();
  disconnect = vi.fn();
  constructor(
    readonly context: unknown,
    readonly name: string,
  ) {
    FakeAudioWorkletNode.instances.push(this);
  }
  emit(data: unknown): void {
    this.port.onmessage?.({ data });
  }
}
