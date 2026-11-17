/**
 * A Web Audio stand-in for the app-sound tests: every AudioParam method the
 * player schedules, and an AudioContext that records the oscillators and gain
 * nodes it hands out.
 */
import { vi } from "vitest";

/** An AudioParam whose scheduling methods are spies. */
export function paramSpy() {
  return {
    setValueAtTime: vi.fn(),
    linearRampToValueAtTime: vi.fn(),
    exponentialRampToValueAtTime: vi.fn(),
  };
}

export interface RecordedOscillator {
  /** Every frequency set or ramped to, in order. */
  readonly hz: number[];
  readonly connect: ReturnType<typeof vi.fn>;
  readonly start: ReturnType<typeof vi.fn>;
  readonly stop: ReturnType<typeof vi.fn>;
}

export interface RecordedGain {
  readonly connect: ReturnType<typeof vi.fn>;
  readonly gain: { value: number } & ReturnType<typeof paramSpy>;
}

export class RecordingAudioContext {
  static instances: RecordingAudioContext[] = [];
  readonly currentTime = 0;
  readonly destination = { kind: "destination" };
  readonly oscillators: RecordedOscillator[] = [];
  readonly gains: RecordedGain[] = [];
  readonly close = vi.fn(async () => {});

  constructor() {
    RecordingAudioContext.instances.push(this);
  }

  createOscillator() {
    const hz: number[] = [];
    const osc = {
      hz,
      connect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      frequency: {
        setValueAtTime: (value: number) => hz.push(value),
        exponentialRampToValueAtTime: (value: number) => hz.push(value),
      },
    };
    this.oscillators.push(osc);
    return osc;
  }

  createGain(): RecordedGain {
    const node: RecordedGain = { connect: vi.fn(), gain: { value: 1, ...paramSpy() } };
    this.gains.push(node);
    return node;
  }
}

/** Every oscillator any recording context has handed out. */
export function recordedOscillators(): RecordedOscillator[] {
  return RecordingAudioContext.instances.flatMap((c) => c.oscillators);
}
