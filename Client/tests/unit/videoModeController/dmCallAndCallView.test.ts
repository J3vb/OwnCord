import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as mocks from "../../helpers/videoModeControllerMocks";
import { createVideoModeController } from "../../../src/pages/main-page/VideoModeController";
import { createVideoGrid } from "../../../src/components/VideoGrid";
import {
  makeSlots,
  makeVideoGrid,
  VoiceStateStub,
  makeVoiceState,
} from "../../helpers/videoModeControllerHarness";

vi.mock("@stores/voice.store", () => mocks.voiceStoreMock());
vi.mock("@lib/voice/livekitSession", () => mocks.voiceLivekitSessionMock());

const { mockVoiceStoreGetState, mockGetLocalCameraStream, mockGetLocalScreenshareStream } = mocks;

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
        chatColumn: document.createElement("div"),
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
      mockGetLocalCameraStream.mockReturnValue({
        getVideoTracks: () => [],
      } as unknown as MediaStream);
      const { slots } = mountedSlots();
      const { host, state } = panelHost();
      const vg = makeVideoGrid();
      const ctrl = createVideoModeController({
        slots,
        chatColumn: document.createElement("div"),
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
        chatColumn: document.createElement("div"),
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
        chatColumn: document.createElement("div"),
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
        chatColumn: document.createElement("div"),
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
        chatColumn: document.createElement("div"),
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
      return createVideoModeController({
        slots,
        chatColumn: document.createElement("div"),
        videoGrid: grid,
        getCurrentUserId: () => 1,
      });
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
        chatColumn: document.createElement("div"),
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
