import { beforeEach, vi } from "vitest";
import {
  createVideoModeController,
  type VideoModeControllerOptions,
} from "../../src/pages/main-page/VideoModeController";
import {
  mockGetLocalCameraStream,
  mockGetLocalScreenshareStream,
  mockVoiceStoreGetState,
} from "./videoModeControllerMocks";

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

export type StubUser = { userId: number; camera: boolean; screenshare: boolean; username: string };

export function vUser(
  userId: number,
  username: string,
  flags: Partial<Pick<StubUser, "camera" | "screenshare">> = {},
): StubUser {
  return { userId, camera: false, screenshare: false, username, ...flags };
}

export function usersOf(...users: StubUser[]): Map<number, StubUser> {
  return new Map(users.map((u) => [u.userId, u]));
}

/** Makes the stubbed voice store report channel 10 holding `users`. */
export function stubVoiceChannel(
  users: Map<number, StubUser>,
  state: Partial<VoiceStateStub> = {},
): void {
  mockVoiceStoreGetState.mockReturnValue(
    makeVoiceState({ currentChannelId: 10, voiceUsers: new Map([[10, users]]), ...state }),
  );
}

/** Registers the beforeEach that resets the stubbed voice store and local streams. */
export function useVideoModeControllerHarness(): void {
  beforeEach(() => {
    vi.clearAllMocks();
    mockVoiceStoreGetState.mockReturnValue(makeVoiceState());
    mockGetLocalCameraStream.mockReturnValue(null);
    mockGetLocalScreenshareStream.mockReturnValue(null);
  });
}

/** A controller over fresh slots, chat column and grid unless `over` supplies them. */
export function setupController(over: Partial<VideoModeControllerOptions> = {}) {
  const slots = over.slots ?? makeSlots();
  const chatColumn = over.chatColumn ?? document.createElement("div");
  const videoGrid = over.videoGrid ?? makeVideoGrid();
  const ctrl = createVideoModeController({
    getCurrentUserId: () => 1,
    ...over,
    slots,
    chatColumn,
    videoGrid,
  });
  return { ctrl, slots, chatColumn, videoGrid };
}

export function makeController(over: Partial<VideoModeControllerOptions> = {}) {
  return setupController(over).ctrl;
}
