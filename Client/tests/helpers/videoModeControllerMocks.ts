import { vi } from "vitest";
import { withOverrides } from "./voiceSessionMock";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

export const {
  mockVoiceStoreGetState,
  mockGetLocalCameraStream,
  mockGetLocalScreenshareStream,
  mockHasLocalScreenshareAudio,
} = {
  mockVoiceStoreGetState: vi.fn(),
  mockGetLocalCameraStream: vi.fn((): MediaStream | null => null),
  mockGetLocalScreenshareStream: vi.fn((): MediaStream | null => null),
  mockHasLocalScreenshareAudio: vi.fn(() => false),
};

export function voiceStoreMock() {
  return {
    voiceStore: { getState: mockVoiceStoreGetState },
  };
}

export function voiceLivekitSessionMock() {
  return withOverrides({
    getLocalCameraStream: mockGetLocalCameraStream,
    getLocalScreenshareStream: mockGetLocalScreenshareStream,
    hasLocalScreenshareAudio: mockHasLocalScreenshareAudio,
  });
}
