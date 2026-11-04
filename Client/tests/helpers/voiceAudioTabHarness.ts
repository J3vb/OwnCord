import { afterEach, beforeEach, vi } from "vitest";
import { installFakeAudio } from "./fakeAudioContext";

/** The volume sliders, not the Push to Talk release delay in the input mode card. */
export const VOLUME_SLIDERS = 'input[type="range"]:not([data-testid="ptt-release-delay"])';

/** Fires the `devicechange` listeners registered on the stubbed MediaDevices. */
let currentEmit: () => void = () => {};
export const emitDeviceChange = (): void => currentEmit();

export type FakeDevice = { kind: string; deviceId: string; label: string; groupId?: string };
export function stubNavigator(devices: FakeDevice[] = []): {
  setDevices(next: FakeDevice[]): void;
} {
  const audioStream = {
    getTracks: () => [{ stop: vi.fn(), kind: "audio" }],
    getAudioTracks: () => [{ stop: vi.fn(), kind: "audio" }],
  } as unknown as MediaStream;

  let current = devices;
  const listeners = new Set<() => void>();
  currentEmit = () => {
    for (const l of listeners) l();
  };

  vi.stubGlobal("navigator", {
    mediaDevices: {
      enumerateDevices: vi.fn().mockImplementation(() => Promise.resolve(current)),
      getUserMedia: vi.fn().mockResolvedValue(audioStream),
      addEventListener: (type: string, handler: () => void) => {
        if (type === "devicechange") listeners.add(handler);
      },
      removeEventListener: (_type: string, handler: () => void) => {
        listeners.delete(handler);
      },
    },
  });

  return {
    setDevices(next) {
      current = next;
    },
  };
}

const CAM_1: FakeDevice = { kind: "videoinput", deviceId: "cam-1", label: "Camera 1" };

/**
 * Stubs the navigator so video-only `getUserMedia` calls resolve through
 * `camera` and every other call yields an audio stream.
 */
export function stubCameraNavigator(opts: {
  camera: () => Promise<MediaStream>;
  devices?: FakeDevice[];
  audio?: MediaStream;
}): void {
  const audio = opts.audio ?? fakeAudioStream();
  vi.stubGlobal("navigator", {
    mediaDevices: {
      enumerateDevices: vi.fn().mockResolvedValue(opts.devices ?? [CAM_1]),
      getUserMedia: vi.fn().mockImplementation((constraints: MediaStreamConstraints) => {
        if (constraints.video && constraints.audio === false) return opts.camera();
        return Promise.resolve(audio);
      }),
    },
  });
}

/** A stream with one audio track whose `stop` is the given spy. */
export function fakeAudioStream(stop: () => void = vi.fn()): MediaStream {
  return {
    getTracks: () => [{ stop, kind: "audio" }],
    getAudioTracks: () => [{ stop, kind: "audio" }],
  } as unknown as MediaStream;
}

/** A stream with no tracks. */
export function emptyStream(): MediaStream {
  return { getTracks: () => [], getAudioTracks: () => [] } as unknown as MediaStream;
}

/** Registers the hooks that give a tab suite clean storage, fake audio and no stubbed globals left over. */
export function useTabEnv(): void {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    document.body.innerHTML = "";
    installFakeAudio({ worklets: true });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });
}
