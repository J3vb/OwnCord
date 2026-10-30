import { vi } from "vitest";

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
