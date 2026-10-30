import { vi } from "vitest";

export const mockSwitchInputDevice = vi.fn().mockResolvedValue(undefined);

export const mockSwitchOutputDevice = vi.fn().mockResolvedValue(undefined);

export const mockSwitchVideoDevice = vi.fn().mockResolvedValue(undefined);

export const mockSetVoiceSensitivity = vi.fn();

export const mockSetInputVolume = vi.fn();

/** The native engine's level reports: the meter's listener and its release. */
export let nativeLevelListener: ((rms: number | null, open: boolean) => void) | null = null;

export const mockUnsubscribeNativeLevel = vi.fn(() => {
  nativeLevelListener = null;
});

export const mockSetOutputVolume = vi.fn();

export const mockReapplyAudioProcessing = vi.fn().mockResolvedValue(undefined);

export const mockReapplyEnhancedNoiseSuppression = vi.fn().mockResolvedValue(undefined);

export const mockGetLocalMicSettings = vi.fn((): MediaTrackSettings | null => null);

export const mockApplyInputMode = vi.fn();

export const mockPttStop = vi.fn(async () => {});

export const mockPttUpdateKey = vi.fn(async (_vk: number) => {});

export function desktopPushToTalkMock() {
  return {
    pushToTalk: {
      supported: async () => true,
      captureKeyPress: async () => 0,
      stop: () => mockPttStop(),
      updateKey: (vk: number) => mockPttUpdateKey(vk),
    },
  };
}

export function voiceLivekitSessionMock() {
  return {
    switchInputDevice: (...args: unknown[]) => mockSwitchInputDevice(...args),
    switchOutputDevice: (...args: unknown[]) => mockSwitchOutputDevice(...args),
    switchVideoDevice: (...args: unknown[]) => mockSwitchVideoDevice(...args),
    setVoiceSensitivity: (...args: unknown[]) => mockSetVoiceSensitivity(...args),
    applyInputMode: () => mockApplyInputMode(),
    setInputVolume: (...args: unknown[]) => mockSetInputVolume(...args),
    onNativeInputLevel: (listener: (rms: number | null, open: boolean) => void) => {
      nativeLevelListener = listener;
      return mockUnsubscribeNativeLevel;
    },
    setOutputVolume: (...args: unknown[]) => mockSetOutputVolume(...args),
    reapplyAudioProcessing: (...args: unknown[]) => mockReapplyAudioProcessing(...args),
    reapplyEnhancedNoiseSuppression: (...args: unknown[]) =>
      mockReapplyEnhancedNoiseSuppression(...args),
    getLocalMicSettings: () => mockGetLocalMicSettings(),
  };
}
