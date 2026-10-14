import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const {
  mockVoiceStoreGetState,
  mockGetLocalCameraStream,
  mockGetLocalScreenshareStream,
  mockHasLocalScreenshareAudio,
} = vi.hoisted(() => ({
  mockVoiceStoreGetState: vi.fn(),
  mockGetLocalCameraStream: vi.fn((): MediaStream | null => null),
  mockGetLocalScreenshareStream: vi.fn((): MediaStream | null => null),
  mockHasLocalScreenshareAudio: vi.fn(() => false),
}));

vi.mock("@stores/voice.store", () => ({
  voiceStore: { getState: mockVoiceStoreGetState },
}));

vi.mock("@lib/livekitSession", () => ({
  getLocalCameraStream: mockGetLocalCameraStream,
  getLocalScreenshareStream: mockGetLocalScreenshareStream,
  hasLocalScreenshareAudio: mockHasLocalScreenshareAudio,
  setScreenshareAudioVolume: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { createVideoModeController } from "../../src/pages/main-page/VideoModeController";
import type { VideoModeControllerOptions } from "../../src/pages/main-page/VideoModeController";
import { createVideoGrid } from "../../src/components/VideoGrid";

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
    clearStreams: vi.fn(),
    hasStreams: vi.fn(() => false),
    setFocusedTile: vi.fn(),
    getFocusedTileId: vi.fn(() => null),
    setExitVisible: vi.fn(),
    showMiniPlayer: vi.fn(),
    hideMiniPlayer: vi.fn(),
    setPeople: vi.fn(),
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

  it("checkVideoMode does NOT auto-open for remote camera (BUG-105)", () => {
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

    // Remote streams require manual click — no auto-open
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

  it("turning on your camera while reading chat stays in chat (WP 1B-4)", () => {
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
    expect(ctrl.isVideoMode()).toBe(false);
  });

  it("adds local self-view tile when local camera is on", () => {
    const fakeStream = { getVideoTracks: () => [] } as unknown as MediaStream;
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

  describe("mini-player", () => {
    it("going to a text channel hands the watched stream to the mini-player before the grid drops its focus", () => {
      const grid = makeVideoGrid();
      const ctrl = createVideoModeController({
        slots: makeSlots(),
        videoGrid: grid,
        getCurrentUserId: () => 1,
      });
      ctrl.showVideoGrid();
      ctrl.setFocus(3);

      ctrl.showChat({ keepWatching: true });

      expect(grid.showMiniPlayer).toHaveBeenCalledTimes(1);
      const mini = vi.mocked(grid.showMiniPlayer).mock.invocationCallOrder[0]!;
      const unfocus = vi.mocked(grid.setFocusedTile).mock.invocationCallOrder.at(-1)!;
      expect(mini).toBeLessThan(unfocus);
    });

    it("closing the grid itself (its Show chat control) opens no mini-player", () => {
      const grid = makeVideoGrid();
      const ctrl = createVideoModeController({
        slots: makeSlots(),
        videoGrid: grid,
        getCurrentUserId: () => 1,
      });
      ctrl.showVideoGrid();

      ctrl.showChat();

      expect(ctrl.isVideoMode()).toBe(false);
      expect(grid.showMiniPlayer).not.toHaveBeenCalled();
    });

    it("showChat with the grid already closed opens no mini-player", () => {
      const grid = makeVideoGrid();
      const ctrl = createVideoModeController({
        slots: makeSlots(),
        videoGrid: grid,
        getCurrentUserId: () => 1,
      });

      ctrl.showChat({ keepWatching: true });

      expect(grid.showMiniPlayer).not.toHaveBeenCalled();
    });

    it("the grid closing on its own (no streams left) opens no mini-player", () => {
      const users = new Map([
        [2, { userId: 2, camera: false, screenshare: false, username: "bob" }],
      ]);
      mockVoiceStoreGetState.mockReturnValue(
        makeVoiceState({ currentChannelId: 10, voiceUsers: new Map([[10, users]]) }),
      );
      const grid = makeVideoGrid();
      const ctrl = createVideoModeController({
        slots: makeSlots(),
        videoGrid: grid,
        getCurrentUserId: () => 1,
      });
      ctrl.showVideoGrid();

      ctrl.checkVideoMode();

      expect(ctrl.isVideoMode()).toBe(false);
      expect(grid.showMiniPlayer).not.toHaveBeenCalled();
    });

    it("showVideoGrid takes the stream back from the mini-player", () => {
      const grid = makeVideoGrid();
      const ctrl = createVideoModeController({
        slots: makeSlots(),
        videoGrid: grid,
        getCurrentUserId: () => 1,
      });

      ctrl.showVideoGrid();

      expect(grid.hideMiniPlayer).toHaveBeenCalled();
    });
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

  it("turning on your screen share while reading chat stays in chat (WP 1B-4)", () => {
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

    expect(ctrl.isVideoMode()).toBe(false);
    expect(slots.messagesSlot.style.display).toBe("");
  });

  it("adds local screenshare self-view tile when local screenshare is on", () => {
    const fakeStream = { getVideoTracks: () => [] } as unknown as MediaStream;
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
      hasAudio: false,
    });
  });

  it("redraws your screen-share tile when the share changes source, not on other updates", () => {
    const streamOf = (id: string) => ({ getVideoTracks: () => [{ id }] }) as unknown as MediaStream;
    const users = new Map([[1, { userId: 1, camera: false, screenshare: false, username: "me" }]]);
    mockVoiceStoreGetState.mockReturnValue(
      makeVoiceState({
        currentChannelId: 10,
        localScreenshare: true,
        voiceUsers: new Map([[10, users]]),
      }),
    );
    const first = streamOf("window-a");
    mockGetLocalScreenshareStream.mockReturnValue(first);
    const vg = makeVideoGrid();
    const ctrl = createVideoModeController({
      slots: makeSlots(),
      videoGrid: vg,
      getCurrentUserId: () => 1,
    });
    ctrl.checkVideoMode();
    // Same capture (a quality change, a roster update): the tile stays.
    mockGetLocalScreenshareStream.mockReturnValue(streamOf("window-a"));
    ctrl.checkVideoMode();
    expect(vg.removeStream).not.toHaveBeenCalledWith(1_000_001);
    expect(vg.addStream).toHaveBeenCalledTimes(1);

    // Change source: a new capture under the same publication.
    const second = streamOf("window-b");
    mockGetLocalScreenshareStream.mockReturnValue(second);
    ctrl.checkVideoMode();
    expect(vg.removeStream).toHaveBeenCalledWith(1_000_001);
    expect(vg.addStream).toHaveBeenLastCalledWith(
      1_000_001,
      "me (Screen)",
      second,
      expect.objectContaining({ isSelf: true, isScreenshare: true }),
    );
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
    const fakeStream = { getTracks: () => [], getVideoTracks: () => [] } as unknown as MediaStream;
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
      hasAudio: false,
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

  it("checkVideoMode does NOT auto-open for remote screenshare (BUG-105)", () => {
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

    // Remote streams require manual click — no auto-open
    expect(ctrl.isVideoMode()).toBe(false);
  });

  // -----------------------------------------------------------------------
  // TileConfig verification tests (Spec 1)
  // -----------------------------------------------------------------------

  it("checkVideoMode passes isSelf:true for local camera tile", () => {
    const fakeStream = { getVideoTracks: () => [] } as unknown as MediaStream;
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
    const fakeStream = { getVideoTracks: () => [] } as unknown as MediaStream;
    mockGetLocalScreenshareStream.mockReturnValue(fakeStream);
    mockHasLocalScreenshareAudio.mockReturnValueOnce(true);
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
      expect.objectContaining({
        isSelf: true,
        audioUserId: 5,
        isScreenshare: true,
        hasAudio: true,
      }),
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

  describe("your own video never takes over the chat (WP 1B-4)", () => {
    const me = () =>
      new Map([[1, { userId: 1, camera: false, screenshare: false, username: "me" }]]);

    it("camera on while reading chat stays in chat, and the tile waits in the grid", () => {
      const fakeStream = { getVideoTracks: () => [] } as unknown as MediaStream;
      mockGetLocalCameraStream.mockReturnValue(fakeStream);
      const state = makeVoiceState({ currentChannelId: 10, voiceUsers: new Map([[10, me()]]) });
      mockVoiceStoreGetState.mockReturnValue(state);
      const slots = makeSlots();
      const videoGrid = makeVideoGrid();
      const ctrl = createVideoModeController({ slots, videoGrid, getCurrentUserId: () => 1 });
      ctrl.checkVideoMode();

      mockVoiceStoreGetState.mockReturnValue({ ...state, localCamera: true });
      ctrl.checkVideoMode();
      expect(ctrl.isVideoMode()).toBe(false);
      expect(slots.messagesSlot.style.display).toBe("");
      expect(slots.inputSlot.style.display).toBe("");
      expect(videoGrid.addStream).toHaveBeenCalledWith(1, expect.any(String), fakeStream, {
        isSelf: true,
        audioUserId: 1,
        isScreenshare: false,
      });

      // Opening the call view shows it.
      ctrl.openCall();
      expect(ctrl.isVideoMode()).toBe(true);
    });

    it("camera on in the open call view shows there, and the call stays open", () => {
      const fakeStream = { getVideoTracks: () => [] } as unknown as MediaStream;
      mockGetLocalCameraStream.mockReturnValue(fakeStream);
      const state = makeVoiceState({ currentChannelId: 10, voiceUsers: new Map([[10, me()]]) });
      mockVoiceStoreGetState.mockReturnValue(state);
      const videoGrid = makeVideoGrid();
      const ctrl = createVideoModeController({
        slots: makeSlots(),
        videoGrid,
        getCurrentUserId: () => 1,
      });
      ctrl.openCall();

      mockVoiceStoreGetState.mockReturnValue({ ...state, localCamera: true });
      ctrl.checkVideoMode();
      expect(ctrl.isVideoMode()).toBe(true);
      expect(videoGrid.addStream).toHaveBeenCalledWith(
        1,
        expect.any(String),
        fakeStream,
        expect.objectContaining({ isSelf: true }),
      );

      // Camera off again: still the call view.
      mockVoiceStoreGetState.mockReturnValue(state);
      ctrl.checkVideoMode();
      expect(ctrl.isVideoMode()).toBe(true);
    });

    it("Show chat while your camera is on stays in chat through later changes", () => {
      const state = makeVoiceState({
        currentChannelId: 10,
        localCamera: true,
        voiceUsers: new Map([[10, me()]]),
      });
      mockVoiceStoreGetState.mockReturnValue(state);
      const slots = makeSlots();
      const ctrl = createVideoModeController({
        slots,
        videoGrid: makeVideoGrid(),
        getCurrentUserId: () => 1,
      });
      ctrl.openCall();
      expect(ctrl.isVideoMode()).toBe(true);

      // User switches to a text channel.
      ctrl.showChat();
      expect(ctrl.isVideoMode()).toBe(false);

      // A remote peer's camera toggling re-invokes checkVideoMode().
      ctrl.checkVideoMode();
      expect(ctrl.isVideoMode()).toBe(false);
      expect(slots.messagesSlot.style.display).toBe("");

      // Camera off and on again: still chat.
      mockVoiceStoreGetState.mockReturnValue({ ...state, localCamera: false });
      ctrl.checkVideoMode();
      mockVoiceStoreGetState.mockReturnValue(state);
      ctrl.checkVideoMode();
      expect(ctrl.isVideoMode()).toBe(false);
    });

    it("leaving and joining again with the camera on stays in chat", () => {
      const inChannel = makeVoiceState({
        currentChannelId: 10,
        localCamera: true,
        voiceUsers: new Map([[10, me()]]),
      });
      mockVoiceStoreGetState.mockReturnValue(inChannel);
      const ctrl = createVideoModeController({
        slots: makeSlots(),
        videoGrid: makeVideoGrid(),
        getCurrentUserId: () => 1,
      });
      ctrl.openCall();
      expect(ctrl.isVideoMode()).toBe(true);

      // leaveVoice() clears currentChannelId before localCamera goes false.
      mockVoiceStoreGetState.mockReturnValue({ ...inChannel, currentChannelId: null });
      ctrl.checkVideoMode();
      expect(ctrl.isVideoMode()).toBe(false);

      mockVoiceStoreGetState.mockReturnValue(inChannel);
      ctrl.checkVideoMode();
      expect(ctrl.isVideoMode()).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Stale remote tile / focus cleanup on close (B1-8, B5-15)
  // -----------------------------------------------------------------------

  describe("grid cleanup on close", () => {
    it("clears videoGrid streams on a real leave (currentChannelId becomes null)", () => {
      const users = new Map([
        [1, { userId: 1, camera: false, screenshare: false, username: "me" }],
      ]);
      const inChannel = makeVoiceState({
        currentChannelId: 10,
        localCamera: true,
        voiceUsers: new Map([[10, users]]),
      });
      mockVoiceStoreGetState.mockReturnValue(inChannel);

      const vg = makeVideoGrid();
      const ctrl = createVideoModeController({
        slots: makeSlots(),
        videoGrid: vg,
        getCurrentUserId: () => 1,
      });

      ctrl.checkVideoMode();
      expect(vg.clearStreams).not.toHaveBeenCalled();

      // Leaving voice clears currentChannelId — remote tiles from the ended
      // session must not survive into the next join.
      mockVoiceStoreGetState.mockReturnValue({ ...inChannel, currentChannelId: null });
      ctrl.checkVideoMode();

      expect(vg.clearStreams).toHaveBeenCalledTimes(1);
    });

    it("does not clear videoGrid streams while merely stopping local video mid-session", () => {
      // Auto-reconnect keeps currentChannelId set, so a transient no-video
      // state (all cameras off, still in the channel) must not wipe
      // in-flight remote tiles.
      const users = new Map([
        [1, { userId: 1, camera: false, screenshare: false, username: "me" }],
      ]);
      mockVoiceStoreGetState.mockReturnValue(
        makeVoiceState({ currentChannelId: 10, voiceUsers: new Map([[10, users]]) }),
      );

      const vg = makeVideoGrid();
      const ctrl = createVideoModeController({
        slots: makeSlots(),
        videoGrid: vg,
        getCurrentUserId: () => 1,
      });

      ctrl.checkVideoMode();

      expect(vg.clearStreams).not.toHaveBeenCalled();
    });

    it("clears videoGrid streams on a voice channel switch (A -> B) even though currentChannelId never passes through null (OC-0012)", () => {
      // VoiceCallbacks.onVoiceJoin moves currentChannelId straight from the
      // old channel to the new one (joinVoiceChannel is optimistic), so the
      // channelId === null branch never runs on a switch. Remote tiles left
      // over from channel A must still be cleared when we land in channel B.
      const usersA = new Map([
        [1, { userId: 1, camera: false, screenshare: false, username: "me" }],
      ]);
      mockVoiceStoreGetState.mockReturnValue(
        makeVoiceState({ currentChannelId: 10, voiceUsers: new Map([[10, usersA]]) }),
      );

      const vg = makeVideoGrid();
      const ctrl = createVideoModeController({
        slots: makeSlots(),
        videoGrid: vg,
        getCurrentUserId: () => 1,
      });

      ctrl.checkVideoMode();
      expect(vg.clearStreams).not.toHaveBeenCalled();

      // Switch straight to channel B — currentChannelId goes 10 -> 20, never
      // through null.
      const usersB = new Map([
        [1, { userId: 1, camera: false, screenshare: false, username: "me" }],
      ]);
      mockVoiceStoreGetState.mockReturnValue(
        makeVoiceState({ currentChannelId: 20, voiceUsers: new Map([[20, usersB]]) }),
      );
      ctrl.checkVideoMode();

      expect(vg.clearStreams).toHaveBeenCalledTimes(1);
    });

    it("does not clear videoGrid streams across repeated checkVideoMode calls for the same channel (auto-reconnect)", () => {
      const users = new Map([
        [1, { userId: 1, camera: false, screenshare: false, username: "me" }],
      ]);
      mockVoiceStoreGetState.mockReturnValue(
        makeVoiceState({ currentChannelId: 10, voiceUsers: new Map([[10, users]]) }),
      );

      const vg = makeVideoGrid();
      const ctrl = createVideoModeController({
        slots: makeSlots(),
        videoGrid: vg,
        getCurrentUserId: () => 1,
      });

      ctrl.checkVideoMode();
      ctrl.checkVideoMode();
      ctrl.checkVideoMode();

      expect(vg.clearStreams).not.toHaveBeenCalled();
    });

    it("closeVideoGrid clears the videoGrid's own focus state, not just the controller's", () => {
      const vg = makeVideoGrid();
      const ctrl = createVideoModeController({
        slots: makeSlots(),
        videoGrid: vg,
        getCurrentUserId: () => 1,
      });
      ctrl.showVideoGrid();
      ctrl.setFocus(42);
      expect(vg.setFocusedTile).toHaveBeenCalledWith(42);

      ctrl.showChat();

      // Without this, the grid reopens later still pinned in focus mode on
      // tile 42 even though the controller's own focusedTileId was reset.
      expect(vg.setFocusedTile).toHaveBeenCalledWith(null);
    });
  });

  // -------------------------------------------------------------------------
  // The DM call panel as the video surface
  // -------------------------------------------------------------------------

  describe("DM call panel host", () => {
    const DM = 50;

    function mountedSlots() {
      const slots = makeSlots();
      const chatArea = document.createElement("div");
      chatArea.append(slots.messagesSlot, slots.typingSlot, slots.inputSlot, slots.videoGridSlot);
      return { slots, chatArea };
    }

    function panelHost(opts: { owns?: boolean; element?: HTMLElement | null } = {}) {
      const state = {
        owns: opts.owns ?? true,
        element: opts.element === undefined ? document.createElement("div") : opts.element,
      };
      const host = {
        ownsCall: vi.fn((channelId: number) => state.owns && channelId === DM),
        element: vi.fn(() => state.element),
        setActive: vi.fn(),
      };
      return { host, state };
    }

    function inDmCall(
      extra: Partial<VoiceStateStub> = {},
      remote = { camera: false, screenshare: false },
    ) {
      const users = new Map([
        [1, { userId: 1, camera: false, screenshare: false, username: "me" }],
        [2, { userId: 2, ...remote, username: "otto" }],
      ]);
      mockVoiceStoreGetState.mockReturnValue(
        makeVoiceState({ currentChannelId: DM, voiceUsers: new Map([[DM, users]]), ...extra }),
      );
    }

    it("shows a remote stream in the panel on its own, with the chat still visible", () => {
      inDmCall({}, { camera: false, screenshare: true });
      const { slots, chatArea } = mountedSlots();
      const { host, state } = panelHost();
      const ctrl = createVideoModeController({
        slots,
        videoGrid: makeVideoGrid(),
        getCurrentUserId: () => 1,
        panelHost: () => host,
      });

      ctrl.checkVideoMode();

      expect(state.element!.contains(slots.videoGridSlot)).toBe(true);
      expect(chatArea.contains(slots.videoGridSlot)).toBe(false);
      expect(slots.videoGridSlot.style.display).not.toBe("none");
      expect(slots.messagesSlot.style.display).toBe("");
      expect(slots.inputSlot.style.display).toBe("");
      expect(ctrl.isVideoMode()).toBe(false);
      expect(host.setActive).toHaveBeenLastCalledWith(true);
    });

    it("puts your own camera in the panel instead of over the chat", () => {
      inDmCall({ localCamera: true });
      mockGetLocalCameraStream.mockReturnValue({} as MediaStream);
      const { slots } = mountedSlots();
      const { host, state } = panelHost();
      const vg = makeVideoGrid();
      const ctrl = createVideoModeController({
        slots,
        videoGrid: vg,
        getCurrentUserId: () => 1,
        panelHost: () => host,
      });

      ctrl.checkVideoMode();

      expect(state.element!.contains(slots.videoGridSlot)).toBe(true);
      expect(slots.messagesSlot.style.display).toBe("");
      expect(ctrl.isVideoMode()).toBe(false);
      expect(vg.addStream).toHaveBeenCalledWith(1, expect.any(String), expect.anything(), {
        isSelf: true,
        audioUserId: 1,
        isScreenshare: false,
      });
    });

    it("never takes over the chat while the panel is collapsed, but tells it video is on", () => {
      inDmCall({ localCamera: true });
      const { slots, chatArea } = mountedSlots();
      const { host } = panelHost({ element: null });
      const ctrl = createVideoModeController({
        slots,
        videoGrid: makeVideoGrid(),
        getCurrentUserId: () => 1,
        panelHost: () => host,
      });

      ctrl.checkVideoMode();

      expect(chatArea.contains(slots.videoGridSlot)).toBe(true);
      expect(slots.videoGridSlot.style.display).toBe("none");
      expect(slots.messagesSlot.style.display).toBe("");
      expect(ctrl.isVideoMode()).toBe(false);
      expect(host.setActive).toHaveBeenLastCalledWith(true);
    });

    it("draws no grid in the panel when nobody is streaming", () => {
      inDmCall();
      const { slots, chatArea } = mountedSlots();
      const { host } = panelHost();
      const ctrl = createVideoModeController({
        slots,
        videoGrid: makeVideoGrid(),
        getCurrentUserId: () => 1,
        panelHost: () => host,
      });

      ctrl.checkVideoMode();

      expect(chatArea.contains(slots.videoGridSlot)).toBe(true);
      expect(host.setActive).toHaveBeenLastCalledWith(false);
    });

    it("hands the grid back to the chat column once the DM is not on screen", () => {
      inDmCall({}, { camera: false, screenshare: true });
      const { slots, chatArea } = mountedSlots();
      const { host, state } = panelHost();
      const ctrl = createVideoModeController({
        slots,
        videoGrid: makeVideoGrid(),
        getCurrentUserId: () => 1,
        panelHost: () => host,
      });
      ctrl.checkVideoMode();
      expect(state.element!.contains(slots.videoGridSlot)).toBe(true);

      state.owns = false;
      ctrl.checkVideoMode();

      expect(chatArea.lastElementChild).toBe(slots.videoGridSlot);
      expect(slots.videoGridSlot.style.display).toBe("none");
      expect(host.setActive).toHaveBeenLastCalledWith(false);
      // A remote-only stream outside the DM is back to BUG-105: no auto-open.
      expect(ctrl.isVideoMode()).toBe(false);
    });

    it("hands the grid back when the call ends", () => {
      inDmCall({}, { camera: true, screenshare: false });
      const { slots, chatArea } = mountedSlots();
      const { host } = panelHost();
      const ctrl = createVideoModeController({
        slots,
        videoGrid: makeVideoGrid(),
        getCurrentUserId: () => 1,
        panelHost: () => host,
      });
      ctrl.checkVideoMode();

      mockVoiceStoreGetState.mockReturnValue(makeVoiceState());
      ctrl.checkVideoMode();

      expect(chatArea.contains(slots.videoGridSlot)).toBe(true);
      expect(host.setActive).toHaveBeenLastCalledWith(false);
    });
  });

  describe("call view (1B-1)", () => {
    const user = (userId: number, username: string, video: Partial<{ camera: boolean }> = {}) => ({
      userId,
      username,
      camera: video.camera ?? false,
      screenshare: false,
    });
    let container: HTMLDivElement;
    let grid: ReturnType<typeof createVideoGrid>;
    let slots: ReturnType<typeof makeSlots>;
    let users: Map<number, ReturnType<typeof user>>;

    function setVoice(overrides: Partial<VoiceStateStub> = {}): void {
      mockVoiceStoreGetState.mockReturnValue(
        makeVoiceState({ currentChannelId: 10, voiceUsers: new Map([[10, users]]), ...overrides }),
      );
    }
    function makeCtrl() {
      return createVideoModeController({ slots, videoGrid: grid, getCurrentUserId: () => 1 });
    }
    const avatarTiles = () => [...container.querySelectorAll<HTMLElement>(".video-cell--avatar")];
    const tileIds = () => avatarTiles().map((t) => t.dataset.personId);

    beforeEach(() => {
      // ResizeObserver is not available in JSDOM
      vi.stubGlobal(
        "ResizeObserver",
        class {
          observe(): void {}
          unobserve(): void {}
          disconnect(): void {}
        },
      );
      container = document.createElement("div");
      document.body.appendChild(container);
      grid = createVideoGrid();
      grid.mount(container);
      slots = makeSlots();
      users = new Map([
        [1, user(1, "me")],
        [2, user(2, "bob")],
      ]);
      setVoice();
    });

    afterEach(() => {
      grid.destroy?.();
      container.remove();
      vi.unstubAllGlobals();
    });

    it("opens with an avatar tile for each person in a call with no video", () => {
      const ctrl = makeCtrl();
      ctrl.openCall();

      expect(ctrl.isVideoMode()).toBe(true);
      expect(slots.messagesSlot.style.display).toBe("none");
      expect(tileIds()).toEqual(["1", "2"]);
      expect(avatarTiles()[1]!.querySelector(".video-username")!.textContent).toBe("bob");
    });

    it("rings the tile of the person who starts speaking", () => {
      makeCtrl().openCall();
      grid.setSpeaking(new Set([2]));

      const [me, bob] = avatarTiles();
      expect(bob!.classList.contains("video-cell--speaking")).toBe(true);
      expect(me!.classList.contains("video-cell--speaking")).toBe(false);
    });

    it("stays open while nobody has video, and follows the roster", () => {
      const ctrl = makeCtrl();
      ctrl.openCall();

      users.set(3, user(3, "sam"));
      ctrl.checkVideoMode();
      expect(ctrl.isVideoMode()).toBe(true);
      expect(tileIds()).toEqual(["1", "2", "3"]);

      users.delete(2);
      ctrl.checkVideoMode();
      expect(tileIds()).toEqual(["1", "3"]);
    });

    it("closes and drops the avatar tiles on leave", () => {
      const ctrl = makeCtrl();
      ctrl.openCall();

      setVoice({ currentChannelId: null, voiceUsers: new Map() });
      ctrl.checkVideoMode();

      expect(ctrl.isVideoMode()).toBe(false);
      expect(slots.messagesSlot.style.display).toBe("");
      expect(avatarTiles()).toHaveLength(0);
    });

    it("goes back to chat on Show chat, and Open call brings the call view back", () => {
      const ctrl = makeCtrl();
      ctrl.openCall();
      ctrl.showChat();
      expect(ctrl.isVideoMode()).toBe(false);
      expect(avatarTiles()).toHaveLength(0);

      ctrl.openCall();
      expect(ctrl.isVideoMode()).toBe(true);
      expect(tileIds()).toEqual(["1", "2"]);
    });

    it("stays in chat after Show chat when the roster changes", () => {
      const ctrl = makeCtrl();
      ctrl.openCall();
      ctrl.showChat();

      users.set(3, user(3, "sam"));
      ctrl.checkVideoMode();
      expect(ctrl.isVideoMode()).toBe(false);
    });

    it("going to a text channel ends the call view, so no-video closes it after", () => {
      const ctrl = makeCtrl();
      ctrl.openCall();
      ctrl.showChat({ keepWatching: true });
      ctrl.showVideoGrid();

      ctrl.checkVideoMode();
      expect(ctrl.isVideoMode()).toBe(false);
    });

    it("moves with a direct channel switch, showing the new channel's people", () => {
      const ctrl = makeCtrl();
      ctrl.openCall();

      users = new Map([
        [1, user(1, "me")],
        [5, user(5, "eve")],
      ]);
      setVoice({ currentChannelId: 11, voiceUsers: new Map([[11, users]]) });
      ctrl.checkVideoMode();

      expect(ctrl.isVideoMode()).toBe(true);
      expect(tileIds()).toEqual(["1", "5"]);
    });

    it("stays open while a reconnect's resync briefly drops the channel's roster", () => {
      const ctrl = makeCtrl();
      ctrl.openCall();

      setVoice({ voiceUsers: new Map() });
      ctrl.checkVideoMode();
      expect(ctrl.isVideoMode()).toBe(true);
      expect(avatarTiles()).toHaveLength(0);

      setVoice();
      ctrl.checkVideoMode();
      expect(tileIds()).toEqual(["1", "2"]);
    });

    it("a grid opened for a stream still closes once the video stops", () => {
      users.set(2, user(2, "bob", { camera: true }));
      const ctrl = makeCtrl();
      ctrl.showVideoGrid();
      ctrl.checkVideoMode();
      expect(tileIds()).toEqual(["1", "2"]);

      users.set(2, user(2, "bob"));
      ctrl.checkVideoMode();
      expect(ctrl.isVideoMode()).toBe(false);
      expect(avatarTiles()).toHaveLength(0);
    });

    it("draws everyone in the call as soon as the grid opens for a stream", () => {
      users.set(2, user(2, "bob", { camera: true }));
      const ctrl = makeCtrl();
      ctrl.checkVideoMode();
      ctrl.showVideoGrid();
      expect(tileIds()).toEqual(["1", "2"]);
    });

    it("keeps each avatar element while the person's name and picture are unchanged", () => {
      const ctrl = makeCtrl();
      ctrl.openCall();
      const before = avatarTiles()[1]!.firstElementChild;

      users.set(3, user(3, "sam"));
      ctrl.checkVideoMode();
      expect(avatarTiles()[1]!.firstElementChild).toBe(before);
    });

    it("leaves the people to the DM call panel while it hosts the call", () => {
      const vg = makeVideoGrid();
      const host = {
        ownsCall: () => true,
        element: () => null,
        setActive: vi.fn(),
      };
      const ctrl = createVideoModeController({
        slots,
        videoGrid: vg,
        getCurrentUserId: () => 1,
        panelHost: () => host,
      });
      ctrl.openCall();

      expect(ctrl.isVideoMode()).toBe(false);
      expect(vg.setPeople).not.toHaveBeenCalled();
    });

    it("takes the avatar tiles back on destroy", () => {
      const ctrl = makeCtrl();
      ctrl.openCall();
      ctrl.destroy();
      expect(avatarTiles()).toHaveLength(0);
    });
  });
});
