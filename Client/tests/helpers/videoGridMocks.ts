import { vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing VideoGrid
// ---------------------------------------------------------------------------

export const mockMuteScreenshareAudio = vi.fn();

export const mockSetScreenshareAudioVolume = vi.fn();

export const mockSetUserVolume = vi.fn();

export const mockGetScreenshareAudioMuted = vi.fn((_userId?: unknown) => false);

export const mockGetScreenshareAudioVolume = vi.fn((_userId?: unknown) => 1);

export const mockGetUserVolume = vi.fn((_userId?: unknown) => 100);

export const mockGetUserLocalMute = vi.fn((_userId?: unknown) => false);

export const mockSetUserLocalMute = vi.fn();

export const mockShowToast = vi.fn();

export function uiToastMock() {
  return { showToast: mockShowToast };
}

export function voiceLivekitSessionMock() {
  return {
    muteScreenshareAudio: (...args: unknown[]) => mockMuteScreenshareAudio(...args),
    setScreenshareAudioVolume: (...args: unknown[]) => mockSetScreenshareAudioVolume(...args),
    setUserVolume: (...args: unknown[]) => mockSetUserVolume(...args),
    getScreenshareAudioMuted: (userId: unknown) => mockGetScreenshareAudioMuted(userId),
    getScreenshareAudioVolume: (userId: unknown) => mockGetScreenshareAudioVolume(userId),
    getUserVolume: (userId: unknown) => mockGetUserVolume(userId),
    getUserLocalMute: (userId: unknown) => mockGetUserLocalMute(userId),
    setUserLocalMute: (...args: unknown[]) => mockSetUserLocalMute(...args),
  };
}
