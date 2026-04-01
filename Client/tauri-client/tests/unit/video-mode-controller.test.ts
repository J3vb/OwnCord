import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const { mockVoiceStoreGetState, mockGetLocalCameraStream, mockGetLocalScreenshareStream } =
  vi.hoisted(() => ({
    mockVoiceStoreGetState: vi.fn(),
    mockGetLocalCameraStream: vi.fn((): MediaStream | null => null),
    mockGetLocalScreenshareStream: vi.fn((): MediaStream | null => null),
  }));

vi.mock("@stores/voice.store", () => ({
  voiceStore: { getState: mockVoiceStoreGetState },
}));

vi.mock("@lib/livekitSession", () => ({
  getLocalCameraStream: mockGetLocalCameraStream,
  getLocalScreenshareStream: mockGetLocalScreenshareStream,
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { createVideoModeController } from "../../src/pages/main-page/VideoModeController";
import type { VideoModeControllerOptions } from "../../src/pages/main-page/VideoModeController";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSlots() {
  return {
    messagesSlot: document.createElement("div"),
    typingSlot: document.createElement("div"),
    inputSlot: document.createElement("div"),
    videoGridSlot: document.createElement("div"),
  };
}

function makeVideoGrid(): VideoModeControllerOptions["videoGrid"] {
  return {
    mount: vi.fn(),
    destroy: vi.fn(),
    addStream: vi.fn(),
    removeStream: vi.fn(),
    hasStreams: vi.fn(() => false),
    setFocusedTile: vi.fn(),
    getFocusedTileId: vi.fn(() => null),
  } as unknown as VideoModeControllerOptions["videoGrid"];
}

interface VoiceStateStub {
  currentChannelId: number | null;
  localCamera: boolean;
  localScreenshare: boolean;
  voiceUsers: Map<
    number,
    Map<number, { userId: number; camera: boolean; screenshare: boolean; username: string }>
  >;
}

function makeVoiceState(overrides: Partial<VoiceStateStub> = {}): VoiceStateStub {
  return {
    currentChannelId: null,
    localCamera: false,
    localScreenshare: false,
    voiceUsers: new Map(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createVideoModeController", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockVoiceStoreGetState.mockReturnValue(makeVoiceState());
    mockGetLocalCameraStream.mockReturnValue(null);
    mockGetLocalScreenshareStream.mockReturnValue(null);
  });

  it("starts in chat mode", () => {
    const slots = makeSlots();
    const ctrl = createVideoModeController({
      slots,
      videoGrid: makeVideoGrid(),
      getCurrentUserId: () => 1,
    });
    expect(ctrl.isVideoMode()).toBe(false);
  });

  it("stays in chat mode when no voice channel", () => {
    const ctrl = createVideoModeController({
      slots: makeSlots(),
      videoGrid: makeVideoGrid(),
      getCurrentUserId: () => 1,
    });
    ctrl.checkVideoMode();
    expect(ctrl.isVideoMode()).toBe(false);
  });

  it("checkVideoMode does NOT auto-switch to video grid when remote has camera", () => {
    const users = new Map([[2, { userId: 2, camera: true, screenshare: false, username: "bob" }]]);
    mockVoiceStoreGetState.mockReturnValue(
      makeVoiceState({ currentChannelId: 10, voiceUsers: new Map([[10, users]]) }),
    );

    const slots = makeSlots();
    const ctrl = createVideoModeController({
      slots,
      videoGrid: makeVideoGrid(),
      getCurrentUserId: () => 1,
    });
    ctrl.checkVideoMode();

    // Auto-open was removed — video mode requires manual activation
    expect(ctrl.isVideoMode()).toBe(false);
  });

  it("checkVideoMode auto-closes video grid when no streams remain", () => {
    const users = new Map([[2, { userId: 2, camera: true, screenshare: false, username: "bob" }]]);
    mockVoiceStoreGetState.mockReturnValue(
      makeVoiceState({ currentChannelId: 10, voiceUsers: new Map([[10, users]]) }),
    );

    const slots = makeSlots();
    const ctrl = createVideoModeController({
      slots,
      videoGrid: makeVideoGrid(),
      getCurrentUserId: () => 1,
    });

    // Manually open video grid first
    ctrl.showVideoGrid();
    expect(ctrl.isVideoMode()).toBe(true);

    // All cameras off — should auto-close
    users.set(2, { userId: 2, camera: false, screenshare: false, username: "bob" });
    ctrl.checkVideoMode();
    expect(ctrl.isVideoMode()).toBe(false);
    expect(slots.messagesSlot.style.display).toBe("");
  });

  it("checkVideoMode does NOT auto-switch when local camera is on", () => {
    const users = new Map([[1, { userId: 1, camera: false, screenshare: false, username: "me" }]]);
    mockVoiceStoreGetState.mockReturnValue(
      makeVoiceState({
        currentChannelId: 10,
        localCamera: true,
        voiceUsers: new Map([[10, users]]),
      }),
    );

    const ctrl = createVideoModeController({
      slots: makeSlots(),
      videoGrid: makeVideoGrid(),
      getCurrentUserId: () => 1,
    });
    ctrl.checkVideoMode();
    // Auto-open removed — must be activated manually
    expect(ctrl.isVideoMode()).toBe(false);
  });

  it("adds local self-view tile when local camera is on", () => {
    const fakeStream = {} as MediaStream;
    mockGetLocalCameraStream.mockReturnValue(fakeStream);
    const users = new Map([[1, { userId: 1, camera: false, screenshare: false, username: "me" }]]);
    mockVoiceStoreGetState.mockReturnValue(
      makeVoiceState({
        currentChannelId: 10,
        localCamera: true,
        voiceUsers: new Map([[10, users]]),
      }),
    );

    const vg = makeVideoGrid();
    const ctrl = createVideoModeController({
      slots: makeSlots(),
      videoGrid: vg,
      getCurrentUserId: () => 1,
    });
    ctrl.checkVideoMode();

    expect(vg.addStream).toHaveBeenCalledWith(1, "me (You)", fakeStream, {
      isSelf: true,
      audioUserId: 1,
      isScreenshare: false,
    });
  });

  it("removes local tile when local camera is off", () => {
    const users = new Map([[1, { userId: 1, camera: false, screenshare: false, username: "me" }]]);
    mockVoiceStoreGetState.mockReturnValue(
      makeVoiceState({
        currentChannelId: 10,
        localCamera: false,
        voiceUsers: new Map([[10, users]]),
      }),
    );

    const vg = makeVideoGrid();
    const ctrl = createVideoModeController({
      slots: makeSlots(),
      videoGrid: vg,
      getCurrentUserId: () => 1,
    });
    ctrl.checkVideoMode();

    expect(vg.removeStream).toHaveBeenCalledWith(1);
  });

  it("does NOT remove remote tiles in checkVideoMode (delegated to onRemoteVideoRemoved)", () => {
    const users = new Map([
      [1, { userId: 1, camera: false, screenshare: false, username: "me" }],
      [2, { userId: 2, camera: false, screenshare: false, username: "bob" }],
    ]);
    mockVoiceStoreGetState.mockReturnValue(
      makeVoiceState({
        currentChannelId: 10,
        voiceUsers: new Map([[10, users]]),
      }),
    );

    const vg = makeVideoGrid();
    const ctrl = createVideoModeController({
      slots: makeSlots(),
      videoGrid: vg,
      getCurrentUserId: () => 1,
    });
    ctrl.checkVideoMode();

    // Remote tile removal is handled by onRemoteVideoRemoved (LiveKit TrackUnsubscribed),
    // not by checkVideoMode, to avoid race conditions with voice store updates.
    expect(vg.removeStream).not.toHaveBeenCalledWith(2);
  });

  it("showChat switches back to chat mode", () => {
    const slots = makeSlots();
    const ctrl = createVideoModeController({
      slots,
      videoGrid: makeVideoGrid(),
      getCurrentUserId: () => 1,
    });
    ctrl.showVideoGrid();
    expect(ctrl.isVideoMode()).toBe(true);

    ctrl.showChat();
    expect(ctrl.isVideoMode()).toBe(false);
    expect(slots.videoGridSlot.style.display).toBe("none");
  });

  it("destroy resets video mode state and restores DOM", () => {
    const slots = makeSlots();
    const ctrl = createVideoModeController({
      slots,
      videoGrid: makeVideoGrid(),
      getCurrentUserId: () => 1,
    });
    ctrl.showVideoGrid();
    expect(ctrl.isVideoMode()).toBe(true);
    expect(slots.messagesSlot.style.display).toBe("none");

    ctrl.destroy();
    expect(ctrl.isVideoMode()).toBe(false);
    expect(slots.messagesSlot.style.display).toBe("");
    expect(slots.videoGridSlot.style.display).toBe("none");
  });

  it("checkVideoMode does NOT auto-switch when local screenshare is on", () => {
    const users = new Map([[1, { userId: 1, camera: false, screenshare: false, username: "me" }]]);
    mockVoiceStoreGetState.mockReturnValue(
      makeVoiceState({
        currentChannelId: 10,
        localCamera: false,
        localScreenshare: true,
        voiceUsers: new Map([[10, users]]),
      }),
    );

    const slots = makeSlots();
    const ctrl = createVideoModeController({
      slots,
      videoGrid: makeVideoGrid(),
      getCurrentUserId: () => 1,
    });
    ctrl.checkVideoMode();

    // Auto-open removed — must be activated manually
    expect(ctrl.isVideoMode()).toBe(false);
  });

  it("adds local screenshare self-view tile when local screenshare is on", () => {
    const fakeStream = {} as MediaStream;
    mockGetLocalScreenshareStream.mockReturnValue(fakeStream);
    const users = new Map([[1, { userId: 1, camera: false, screenshare: false, username: "me" }]]);
    mockVoiceStoreGetState.mockReturnValue(
      makeVoiceState({
        currentChannelId: 10,
        localCamera: false,
        localScreenshare: true,
        voiceUsers: new Map([[10, users]]),
      }),
    );

    const vg = makeVideoGrid();
    const ctrl = createVideoModeController({
      slots: makeSlots(),
      videoGrid: vg,
      getCurrentUserId: () => 1,
    });
    ctrl.checkVideoMode();

    // screenshareUserId = currentUserId + 1_000_000 = 1 + 1_000_000 = 1_000_001
    expect(vg.addStream).toHaveBeenCalledWith(1_000_001, "me (Screen)", fakeStream, {
      isSelf: true,
      audioUserId: 1,
      isScreenshare: true,
    });
  });

  it("removes local screenshare tile when screenshare is turned off", () => {
    const users = new Map([[1, { userId: 1, camera: false, screenshare: false, username: "me" }]]);

    // First call: screenshare on — tile added
    mockVoiceStoreGetState.mockReturnValue(
      makeVoiceState({
        currentChannelId: 10,
        localScreenshare: true,
        voiceUsers: new Map([[10, users]]),
      }),
    );
    const fakeStream = { getTracks: () => [] } as unknown as MediaStream;
    mockGetLocalScreenshareStream.mockReturnValue(fakeStream);

    const vg = makeVideoGrid();
    const ctrl = createVideoModeController({
      slots: makeSlots(),
      videoGrid: vg,
      getCurrentUserId: () => 1,
    });
    ctrl.checkVideoMode();
    expect(vg.addStream).toHaveBeenCalledWith(1_000_001, "me (Screen)", fakeStream, {
      isSelf: true,
      audioUserId: 1,
      isScreenshare: true,
    });

    // Second call: screenshare off — tile removed
    mockVoiceStoreGetState.mockReturnValue(
      makeVoiceState({
        currentChannelId: 10,
        localScreenshare: false,
        voiceUsers: new Map([[10, users]]),
      }),
    );
    ctrl.checkVideoMode();
    expect(vg.removeStream).toHaveBeenCalledWith(1_000_001);
  });

  it("checkVideoMode does NOT auto-switch when remote has screenshare on", () => {
    const users = new Map([
      [1, { userId: 1, camera: false, screenshare: false, username: "me" }],
      [2, { userId: 2, camera: false, screenshare: true, username: "bob" }],
    ]);
    mockVoiceStoreGetState.mockReturnValue(
      makeVoiceState({ currentChannelId: 10, voiceUsers: new Map([[10, users]]) }),
    );

    const ctrl = createVideoModeController({
      slots: makeSlots(),
      videoGrid: makeVideoGrid(),
      getCurrentUserId: () => 1,
    });
    ctrl.checkVideoMode();

    // Auto-open removed — must be activated manually
    expect(ctrl.isVideoMode()).toBe(false);
  });

  // -----------------------------------------------------------------------
  // TileConfig verification tests (Spec 1)
  // -----------------------------------------------------------------------

  it("checkVideoMode passes isSelf:true for local camera tile", () => {
    const fakeStream = {} as MediaStream;
    mockGetLocalCameraStream.mockReturnValue(fakeStream);
    const users = new Map([[5, { userId: 5, camera: false, screenshare: false, username: "me" }]]);
    mockVoiceStoreGetState.mockReturnValue(
      makeVoiceState({
        currentChannelId: 10,
        localCamera: true,
        voiceUsers: new Map([[10, users]]),
      }),
    );

    const vg = makeVideoGrid();
    const ctrl = createVideoModeController({
      slots: makeSlots(),
      videoGrid: vg,
      getCurrentUserId: () => 5,
    });
    ctrl.checkVideoMode();

    expect(vg.addStream).toHaveBeenCalledWith(
      5,
      "me (You)",
      fakeStream,
      expect.objectContaining({ isSelf: true, audioUserId: 5, isScreenshare: false }),
    );
  });

  it("checkVideoMode passes isSelf:true and isScreenshare:true for local screenshare tile", () => {
    const fakeStream = {} as MediaStream;
    mockGetLocalScreenshareStream.mockReturnValue(fakeStream);
    const users = new Map([[5, { userId: 5, camera: false, screenshare: false, username: "me" }]]);
    mockVoiceStoreGetState.mockReturnValue(
      makeVoiceState({
        currentChannelId: 10,
        localScreenshare: true,
        voiceUsers: new Map([[10, users]]),
      }),
    );

    const vg = makeVideoGrid();
    const ctrl = createVideoModeController({
      slots: makeSlots(),
      videoGrid: vg,
      getCurrentUserId: () => 5,
    });
    ctrl.checkVideoMode();

    // screenshareUserId = 5 + 1_000_000 = 1_000_005
    expect(vg.addStream).toHaveBeenCalledWith(
      1_000_005,
      "me (Screen)",
      fakeStream,
      expect.objectContaining({ isSelf: true, audioUserId: 5, isScreenshare: true }),
    );
  });

  // -----------------------------------------------------------------------
  // Focus mode tests (Spec 2)
  // -----------------------------------------------------------------------

  it("setFocus sets focused tile and calls videoGrid.setFocusedTile", () => {
    const vg = makeVideoGrid();
    const ctrl = createVideoModeController({
      slots: makeSlots(),
      videoGrid: vg,
      getCurrentUserId: () => 1,
    });
    ctrl.setFocus(42);
    expect(vg.setFocusedTile).toHaveBeenCalledWith(42);
  });

  it("getFocusedTileId returns null initially", () => {
    const ctrl = createVideoModeController({
      slots: makeSlots(),
      videoGrid: makeVideoGrid(),
      getCurrentUserId: () => 1,
    });
    expect(ctrl.getFocusedTileId()).toBeNull();
  });

  it("getFocusedTileId returns set value", () => {
    const ctrl = createVideoModeController({
      slots: makeSlots(),
      videoGrid: makeVideoGrid(),
      getCurrentUserId: () => 1,
    });
    ctrl.setFocus(42);
    expect(ctrl.getFocusedTileId()).toBe(42);
  });

  it("showChat resets focusedTileId", () => {
    const ctrl = createVideoModeController({
      slots: makeSlots(),
      videoGrid: makeVideoGrid(),
      getCurrentUserId: () => 1,
    });
    ctrl.showVideoGrid();
    ctrl.setFocus(42);
    expect(ctrl.getFocusedTileId()).toBe(42);

    ctrl.showChat();
    expect(ctrl.getFocusedTileId()).toBeNull();
  });
});
