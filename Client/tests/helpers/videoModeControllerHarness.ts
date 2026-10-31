import { vi } from "vitest";
import type { VideoModeControllerOptions } from "../../src/pages/main-page/VideoModeController";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function makeSlots() {
  return {
    messagesSlot: document.createElement("div"),
    typingSlot: document.createElement("div"),
    inputSlot: document.createElement("div"),
    videoGridSlot: document.createElement("div"),
  };
}

export function makeVideoGrid(): VideoModeControllerOptions["videoGrid"] {
  return {
    mount: vi.fn(),
    destroy: vi.fn(),
    addStream: vi.fn(),
    removeStream: vi.fn(),
    clearStreams: vi.fn(),
    hasStreams: vi.fn(() => false),
    setFocusedTile: vi.fn(),
    getFocusedTileId: vi.fn(() => null),
    setExitVisible: vi.fn(),
    showMiniPlayer: vi.fn(),
    hideMiniPlayer: vi.fn(),
    raiseCallPopout: vi.fn(() => false),
    setPeople: vi.fn(),
  } as unknown as VideoModeControllerOptions["videoGrid"];
}

export interface VoiceStateStub {
  currentChannelId: number | null;
  localCamera: boolean;
  localScreenshare: boolean;
  voiceUsers: Map<
    number,
    Map<number, { userId: number; camera: boolean; screenshare: boolean; username: string }>
  >;
}

export function makeVoiceState(overrides: Partial<VoiceStateStub> = {}): VoiceStateStub {
  return {
    currentChannelId: null,
    localCamera: false,
    localScreenshare: false,
    voiceUsers: new Map(),
    ...overrides,
  };
}
