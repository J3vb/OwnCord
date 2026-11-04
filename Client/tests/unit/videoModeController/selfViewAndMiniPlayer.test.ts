import { describe, it, expect, vi } from "vitest";
import * as mocks from "../../helpers/videoModeControllerMocks";
import {
  makeSlots,
  makeVideoGrid,
  makeVoiceState,
  makeController,
  vUser,
  usersOf,
  stubVoiceChannel,
  useVideoModeControllerHarness,
} from "../../helpers/videoModeControllerHarness";

vi.mock("@stores/voice.store", () => mocks.voiceStoreMock());
vi.mock("@lib/voice/livekitSession", () => mocks.voiceLivekitSessionMock());

const {
  mockVoiceStoreGetState,
  mockGetLocalCameraStream,
  mockGetLocalScreenshareStream,
  mockHasLocalScreenshareAudio,
} = mocks;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createVideoModeController", () => {
  useVideoModeControllerHarness();

  it("starts in chat mode", () => {
    const slots = makeSlots();
    const ctrl = makeController({ slots });
    expect(ctrl.isVideoMode()).toBe(false);
  });

  it("stays in chat mode when no voice channel", () => {
    const ctrl = makeController();
    ctrl.checkVideoMode();
    expect(ctrl.isVideoMode()).toBe(false);
  });

  it("checkVideoMode does NOT auto-open for remote camera", () => {
    const users = usersOf(vUser(2, "bob", { camera: true }));
    mockVoiceStoreGetState.mockReturnValue(
      makeVoiceState({ currentChannelId: 10, voiceUsers: new Map([[10, users]]) }),
    );

    const slots = makeSlots();
    const ctrl = makeController({ slots });
    ctrl.checkVideoMode();

    // Remote streams require manual click — no auto-open
    expect(ctrl.isVideoMode()).toBe(false);
  });

  it("checkVideoMode auto-closes video grid when no streams remain", () => {
    const users = usersOf(vUser(2, "bob", { camera: true }));
    mockVoiceStoreGetState.mockReturnValue(
      makeVoiceState({ currentChannelId: 10, voiceUsers: new Map([[10, users]]) }),
    );

    const slots = makeSlots();
    const ctrl = makeController({ slots });

    // Manually open video grid first
    ctrl.showVideoGrid();
    expect(ctrl.isVideoMode()).toBe(true);

    // All cameras off — should auto-close
    users.set(2, vUser(2, "bob"));
    ctrl.checkVideoMode();
    expect(ctrl.isVideoMode()).toBe(false);
    expect(slots.messagesSlot.style.display).toBe("");
  });

  it("turning on your camera while reading chat stays in chat", () => {
    const users = usersOf(vUser(1, "me"));
    stubVoiceChannel(users, { localCamera: true });

    const ctrl = makeController();
    ctrl.checkVideoMode();
    expect(ctrl.isVideoMode()).toBe(false);
  });

  it("adds local self-view tile when local camera is on", () => {
    const fakeStream = { getVideoTracks: () => [] } as unknown as MediaStream;
    mockGetLocalCameraStream.mockReturnValue(fakeStream);
    const users = usersOf(vUser(1, "me"));
    stubVoiceChannel(users, { localCamera: true });

    const vg = makeVideoGrid();
    const ctrl = makeController({ videoGrid: vg });
    ctrl.checkVideoMode();

    expect(vg.addStream).toHaveBeenCalledWith(1, "me (You)", fakeStream, {
      isSelf: true,
      audioUserId: 1,
      isScreenshare: false,
    });
  });

  describe("self camera tile after a camera switch", () => {
    const streamOf = (id: string) => ({ getVideoTracks: () => [{ id }] }) as unknown as MediaStream;
    const users = usersOf(vUser(1, "me"));
    const cameraOn = () =>
      makeVoiceState({
        currentChannelId: 10,
        localCamera: true,
        voiceUsers: new Map([[10, users]]),
      });

    function start() {
      mockVoiceStoreGetState.mockReturnValue(cameraOn());
      mockGetLocalCameraStream.mockReturnValue(streamOf("cam-a"));
      const vg = makeVideoGrid();
      const ctrl = makeController({ videoGrid: vg });
      ctrl.checkVideoMode();
      return { vg, ctrl };
    }

    it("draws the tile again with the new track when the capture was replaced", () => {
      const { vg, ctrl } = start();
      const second = streamOf("cam-b");
      mockGetLocalCameraStream.mockReturnValue(second);
      ctrl.checkVideoMode();
      expect(vg.removeStream).toHaveBeenCalledWith(1);
      expect(vg.addStream).toHaveBeenCalledTimes(2);
      expect(vg.addStream).toHaveBeenLastCalledWith(
        1,
        "me (You)",
        second,
        expect.objectContaining({ isSelf: true, isScreenshare: false }),
      );
    });

    it("leaves the tile alone when nothing changed", () => {
      const { vg, ctrl } = start();
      mockGetLocalCameraStream.mockReturnValue(streamOf("cam-a"));
      ctrl.checkVideoMode();
      ctrl.checkVideoMode();
      expect(vg.removeStream).not.toHaveBeenCalledWith(1);
      expect(vg.addStream).toHaveBeenCalledTimes(1);
    });

    it("removes the tile when the camera goes off", () => {
      const { vg, ctrl } = start();
      stubVoiceChannel(users, { localCamera: false });
      ctrl.checkVideoMode();
      expect(vg.removeStream).toHaveBeenCalledWith(1);
      expect(vg.addStream).toHaveBeenCalledTimes(1);
    });
  });

  it("removes local tile when local camera is off", () => {
    const users = usersOf(vUser(1, "me"));
    stubVoiceChannel(users, { localCamera: false });

    const vg = makeVideoGrid();
    const ctrl = makeController({ videoGrid: vg });
    ctrl.checkVideoMode();

    expect(vg.removeStream).toHaveBeenCalledWith(1);
  });

  it("does NOT remove remote tiles in checkVideoMode (delegated to onRemoteVideoRemoved)", () => {
    const users = usersOf(vUser(1, "me"), vUser(2, "bob"));
    stubVoiceChannel(users);

    const vg = makeVideoGrid();
    const ctrl = makeController({ videoGrid: vg });
    ctrl.checkVideoMode();

    // Remote tile removal is handled by onRemoteVideoRemoved (LiveKit TrackUnsubscribed),
    // not by checkVideoMode, to avoid race conditions with voice store updates.
    expect(vg.removeStream).not.toHaveBeenCalledWith(2);
  });

  it("showChat switches back to chat mode", () => {
    const slots = makeSlots();
    const ctrl = makeController({ slots });
    ctrl.showVideoGrid();
    expect(ctrl.isVideoMode()).toBe(true);

    ctrl.showChat();
    expect(ctrl.isVideoMode()).toBe(false);
    expect(slots.videoGridSlot.style.display).toBe("none");
  });

  describe("mini-player", () => {
    it("going to a text channel hands the watched stream to the mini-player before the grid drops its focus", () => {
      const grid = makeVideoGrid();
      const ctrl = makeController({ videoGrid: grid });
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
      const ctrl = makeController({ videoGrid: grid });
      ctrl.showVideoGrid();

      ctrl.showChat();

      expect(ctrl.isVideoMode()).toBe(false);
      expect(grid.showMiniPlayer).not.toHaveBeenCalled();
    });

    it("showChat with the grid already closed opens no mini-player", () => {
      const grid = makeVideoGrid();
      const ctrl = makeController({ videoGrid: grid });

      ctrl.showChat({ keepWatching: true });

      expect(grid.showMiniPlayer).not.toHaveBeenCalled();
    });

    it("the grid closing on its own (no streams left) opens no mini-player", () => {
      const users = usersOf(vUser(2, "bob"));
      mockVoiceStoreGetState.mockReturnValue(
        makeVoiceState({ currentChannelId: 10, voiceUsers: new Map([[10, users]]) }),
      );
      const grid = makeVideoGrid();
      const ctrl = makeController({ videoGrid: grid });
      ctrl.showVideoGrid();

      ctrl.checkVideoMode();

      expect(ctrl.isVideoMode()).toBe(false);
      expect(grid.showMiniPlayer).not.toHaveBeenCalled();
    });

    it("showVideoGrid takes the stream back from the mini-player", () => {
      const grid = makeVideoGrid();
      const ctrl = makeController({ videoGrid: grid });

      ctrl.showVideoGrid();

      expect(grid.hideMiniPlayer).toHaveBeenCalled();
    });
  });

  it("destroy resets video mode state and restores DOM", () => {
    const slots = makeSlots();
    const ctrl = makeController({ slots });
    ctrl.showVideoGrid();
    expect(ctrl.isVideoMode()).toBe(true);
    expect(slots.messagesSlot.style.display).toBe("none");

    ctrl.destroy();
    expect(ctrl.isVideoMode()).toBe(false);
    expect(slots.messagesSlot.style.display).toBe("");
    expect(slots.videoGridSlot.style.display).toBe("none");
  });

  it("turning on your screen share while reading chat stays in chat", () => {
    const users = usersOf(vUser(1, "me"));
    stubVoiceChannel(users, { localCamera: false, localScreenshare: true });

    const slots = makeSlots();
    const ctrl = makeController({ slots });
    ctrl.checkVideoMode();

    expect(ctrl.isVideoMode()).toBe(false);
    expect(slots.messagesSlot.style.display).toBe("");
  });

  it("adds local screenshare self-view tile when local screenshare is on", () => {
    const fakeStream = { getVideoTracks: () => [] } as unknown as MediaStream;
    mockGetLocalScreenshareStream.mockReturnValue(fakeStream);
    const users = usersOf(vUser(1, "me"));
    stubVoiceChannel(users, { localCamera: false, localScreenshare: true });

    const vg = makeVideoGrid();
    const ctrl = makeController({ videoGrid: vg });
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
    const users = usersOf(vUser(1, "me"));
    stubVoiceChannel(users, { localScreenshare: true });
    const first = streamOf("window-a");
    mockGetLocalScreenshareStream.mockReturnValue(first);
    const vg = makeVideoGrid();
    const ctrl = makeController({ videoGrid: vg });
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
    const users = usersOf(vUser(1, "me"));

    // First call: screenshare on — tile added
    stubVoiceChannel(users, { localScreenshare: true });
    const fakeStream = { getTracks: () => [], getVideoTracks: () => [] } as unknown as MediaStream;
    mockGetLocalScreenshareStream.mockReturnValue(fakeStream);

    const vg = makeVideoGrid();
    const ctrl = makeController({ videoGrid: vg });
    ctrl.checkVideoMode();
    expect(vg.addStream).toHaveBeenCalledWith(1_000_001, "me (Screen)", fakeStream, {
      isSelf: true,
      audioUserId: 1,
      isScreenshare: true,
      hasAudio: false,
    });

    // Second call: screenshare off — tile removed
    stubVoiceChannel(users, { localScreenshare: false });
    ctrl.checkVideoMode();
    expect(vg.removeStream).toHaveBeenCalledWith(1_000_001);
  });

  it("checkVideoMode does NOT auto-open for remote screenshare", () => {
    const users = usersOf(vUser(1, "me"), vUser(2, "bob", { screenshare: true }));
    mockVoiceStoreGetState.mockReturnValue(
      makeVoiceState({ currentChannelId: 10, voiceUsers: new Map([[10, users]]) }),
    );

    const ctrl = makeController();
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
    const users = usersOf(vUser(5, "me"));
    stubVoiceChannel(users, { localCamera: true });

    const vg = makeVideoGrid();
    const ctrl = makeController({ videoGrid: vg, getCurrentUserId: () => 5 });
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
    const users = usersOf(vUser(5, "me"));
    stubVoiceChannel(users, { localScreenshare: true });

    const vg = makeVideoGrid();
    const ctrl = makeController({ videoGrid: vg, getCurrentUserId: () => 5 });
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
    const ctrl = makeController({ videoGrid: vg });
    ctrl.setFocus(42);
    expect(vg.setFocusedTile).toHaveBeenCalledWith(42);
  });

  it("getFocusedTileId returns null initially", () => {
    const ctrl = makeController();
    expect(ctrl.getFocusedTileId()).toBeNull();
  });

  it("getFocusedTileId returns set value", () => {
    const ctrl = makeController();
    ctrl.setFocus(42);
    expect(ctrl.getFocusedTileId()).toBe(42);
  });

  it("showChat resets focusedTileId", () => {
    const ctrl = makeController();
    ctrl.showVideoGrid();
    ctrl.setFocus(42);
    expect(ctrl.getFocusedTileId()).toBe(42);

    ctrl.showChat();
    expect(ctrl.getFocusedTileId()).toBeNull();
  });
});
