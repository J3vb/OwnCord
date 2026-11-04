import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as mocks from "../../helpers/videoModeControllerMocks";
import { CALL_CHAT_STACK_BELOW_PX } from "../../../src/pages/main-page/VideoModeController";
import { createVideoGrid } from "../../../src/components/VideoGrid";
import {
  makeSlots,
  makeVideoGrid,
  VoiceStateStub,
  makeVoiceState,
  makeController,
  vUser,
  usersOf,
  useVideoModeControllerHarness,
  callUser,
  mountCallGrid,
  unmountCallGrid,
} from "../../helpers/videoModeControllerHarness";

vi.mock("@stores/voice.store", () => mocks.voiceStoreMock());
vi.mock("@lib/voice/livekitSession", () => mocks.voiceLivekitSessionMock());

const { mockVoiceStoreGetState, mockGetLocalCameraStream } = mocks;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createVideoModeController", () => {
  useVideoModeControllerHarness();

  describe("chat beside the grid", () => {
    function setup() {
      const slots = makeSlots();
      const chatColumn = document.createElement("div");
      const ctrl = makeController({ slots, chatColumn });
      return { slots, chatColumn, ctrl };
    }

    it("chatBeside keeps the chat slots visible with the grid", () => {
      const { slots, chatColumn, ctrl } = setup();
      ctrl.setChatBeside(true);
      ctrl.showVideoGrid();

      expect(ctrl.isVideoMode()).toBe(true);
      expect(slots.videoGridSlot.style.display).toBe("block");
      expect(slots.messagesSlot.style.display).toBe("");
      expect(slots.typingSlot.style.display).toBe("");
      expect(slots.inputSlot.style.display).toBe("");
      expect(chatColumn.classList.contains("chat-area--call-chat")).toBe(true);
    });

    it("without chatBeside the grid still covers the chat", () => {
      const { slots, chatColumn, ctrl } = setup();
      ctrl.showVideoGrid();

      expect(slots.messagesSlot.style.display).toBe("none");
      expect(chatColumn.classList.contains("chat-area--call-chat")).toBe(false);
    });

    it("turning chatBeside on or off while the grid is up re-lays it out", () => {
      const { slots, chatColumn, ctrl } = setup();
      ctrl.showVideoGrid();
      ctrl.setChatBeside(true);
      expect(slots.inputSlot.style.display).toBe("");
      expect(chatColumn.classList.contains("chat-area--call-chat")).toBe(true);

      ctrl.setChatBeside(false);
      expect(slots.inputSlot.style.display).toBe("none");
      expect(chatColumn.classList.contains("chat-area--call-chat")).toBe(false);
    });

    it("closing the grid clears the split", () => {
      const { slots, chatColumn, ctrl } = setup();
      ctrl.setChatBeside(true);
      ctrl.showVideoGrid();
      ctrl.showChat();

      expect(chatColumn.classList.contains("chat-area--call-chat")).toBe(false);
      expect(slots.videoGridSlot.style.display).toBe("none");
      expect(slots.messagesSlot.style.display).toBe("");
    });

    it("popping the call out clears the split, and restoring brings it back", () => {
      const { chatColumn, ctrl } = setup();
      ctrl.setChatBeside(true);
      ctrl.showVideoGrid();

      ctrl.setCallPoppedOut(true, false);
      expect(chatColumn.classList.contains("chat-area--call-chat")).toBe(false);

      ctrl.setCallPoppedOut(false, true);
      expect(chatColumn.classList.contains("chat-area--call-chat")).toBe(true);
    });

    it("a chat column narrower than the split needs stacks the chat under the grid", () => {
      let report: ResizeObserverCallback = () => undefined;
      const disconnect = vi.fn();
      vi.stubGlobal(
        "ResizeObserver",
        class {
          constructor(cb: ResizeObserverCallback) {
            report = cb;
          }
          observe(): void {}
          disconnect = disconnect;
        },
      );
      try {
        const { chatColumn, ctrl } = setup();
        ctrl.setChatBeside(true);
        ctrl.showVideoGrid();
        const resize = (width: number) =>
          report([{ contentRect: { width } } as ResizeObserverEntry], {} as ResizeObserver);

        resize(CALL_CHAT_STACK_BELOW_PX - 1);
        expect(chatColumn.classList.contains("chat-area--call-chat-stacked")).toBe(true);
        resize(CALL_CHAT_STACK_BELOW_PX);
        expect(chatColumn.classList.contains("chat-area--call-chat-stacked")).toBe(false);

        resize(400);
        ctrl.showChat();
        expect(chatColumn.classList.contains("chat-area--call-chat-stacked")).toBe(false);
        expect(disconnect).toHaveBeenCalled();
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it("destroy clears the split", () => {
      const { chatColumn, ctrl } = setup();
      ctrl.setChatBeside(true);
      ctrl.showVideoGrid();
      ctrl.destroy();

      expect(chatColumn.classList.contains("chat-area--call-chat")).toBe(false);
    });
  });

  describe("your own video never takes over the chat", () => {
    const me = () => usersOf(vUser(1, "me"));

    it("camera on while reading chat stays in chat, and the tile waits in the grid", () => {
      const fakeStream = { getVideoTracks: () => [] } as unknown as MediaStream;
      mockGetLocalCameraStream.mockReturnValue(fakeStream);
      const state = makeVoiceState({ currentChannelId: 10, voiceUsers: new Map([[10, me()]]) });
      mockVoiceStoreGetState.mockReturnValue(state);
      const slots = makeSlots();
      const videoGrid = makeVideoGrid();
      const ctrl = makeController({ slots, videoGrid });
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
      const ctrl = makeController({ videoGrid });
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
      const ctrl = makeController({ slots });
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
      const ctrl = makeController();
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
      const users = usersOf(vUser(1, "me"));
      const inChannel = makeVoiceState({
        currentChannelId: 10,
        localCamera: true,
        voiceUsers: new Map([[10, users]]),
      });
      mockVoiceStoreGetState.mockReturnValue(inChannel);

      const vg = makeVideoGrid();
      const ctrl = makeController({ videoGrid: vg });

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
      const users = usersOf(vUser(1, "me"));
      mockVoiceStoreGetState.mockReturnValue(
        makeVoiceState({ currentChannelId: 10, voiceUsers: new Map([[10, users]]) }),
      );

      const vg = makeVideoGrid();
      const ctrl = makeController({ videoGrid: vg });

      ctrl.checkVideoMode();

      expect(vg.clearStreams).not.toHaveBeenCalled();
    });

    it("clears videoGrid streams on a voice channel switch (A -> B) even though currentChannelId never passes through null", () => {
      // VoiceCallbacks.onVoiceJoin moves currentChannelId straight from the
      // old channel to the new one (joinVoiceChannel is optimistic), so the
      // channelId === null branch never runs on a switch. Remote tiles left
      // over from channel A must still be cleared when we land in channel B.
      const usersA = usersOf(vUser(1, "me"));
      mockVoiceStoreGetState.mockReturnValue(
        makeVoiceState({ currentChannelId: 10, voiceUsers: new Map([[10, usersA]]) }),
      );

      const vg = makeVideoGrid();
      const ctrl = makeController({ videoGrid: vg });

      ctrl.checkVideoMode();
      expect(vg.clearStreams).not.toHaveBeenCalled();

      // Switch straight to channel B — currentChannelId goes 10 -> 20, never
      // through null.
      const usersB = usersOf(vUser(1, "me"));
      mockVoiceStoreGetState.mockReturnValue(
        makeVoiceState({ currentChannelId: 20, voiceUsers: new Map([[20, usersB]]) }),
      );
      ctrl.checkVideoMode();

      expect(vg.clearStreams).toHaveBeenCalledTimes(1);
    });

    it("does not clear videoGrid streams across repeated checkVideoMode calls for the same channel (auto-reconnect)", () => {
      const users = usersOf(vUser(1, "me"));
      mockVoiceStoreGetState.mockReturnValue(
        makeVoiceState({ currentChannelId: 10, voiceUsers: new Map([[10, users]]) }),
      );

      const vg = makeVideoGrid();
      const ctrl = makeController({ videoGrid: vg });

      ctrl.checkVideoMode();
      ctrl.checkVideoMode();
      ctrl.checkVideoMode();

      expect(vg.clearStreams).not.toHaveBeenCalled();
    });

    it("closeVideoGrid clears the videoGrid's own focus state, not just the controller's", () => {
      const vg = makeVideoGrid();
      const ctrl = makeController({ videoGrid: vg });
      ctrl.showVideoGrid();
      ctrl.setFocus(42);
      expect(vg.setFocusedTile).toHaveBeenCalledWith(42);

      ctrl.showChat();

      // Without this, the grid reopens later still pinned in focus mode on
      // tile 42 even though the controller's own focusedTileId was reset.
      expect(vg.setFocusedTile).toHaveBeenCalledWith(null);
    });
  });
  describe("call pop-out", () => {
    const user = callUser;
    let container: HTMLDivElement;
    let grid: ReturnType<typeof createVideoGrid>;
    let slots: ReturnType<typeof makeSlots>;
    let users: Map<number, ReturnType<typeof user>>;
    let popDoc: Document;
    let win: EventTarget & { closed: boolean; close: () => void; focus: () => void };

    function setVoice(overrides: Partial<VoiceStateStub> = {}): void {
      mockVoiceStoreGetState.mockReturnValue(
        makeVoiceState({ currentChannelId: 10, voiceUsers: new Map([[10, users]]), ...overrides }),
      );
    }
    const popButton = () =>
      popDoc.querySelector<HTMLButtonElement>("[data-grid-control='popout']") ??
      container.querySelector<HTMLButtonElement>("[data-grid-control='popout']")!;
    const inWindow = () => popDoc.querySelector("[data-testid='video-grid']") !== null;
    const tileIds = (d: ParentNode) =>
      [...d.querySelectorAll<HTMLElement>(".video-cell--avatar")].map((t) => t.dataset.personId);

    function openPoppedCall() {
      const ctrl = makeController({ slots, videoGrid: grid });
      grid.setCallbacks({ onCallPopout: (out, restore) => ctrl.setCallPoppedOut(out, restore) });
      ctrl.openCall();
      popButton().click();
      return ctrl;
    }

    beforeEach(() => {
      vi.useFakeTimers();
      popDoc = document.implementation.createHTMLDocument("");
      win = Object.assign(new EventTarget(), {
        closed: false,
        close: vi.fn(() => {
          win.closed = true;
        }),
        focus: vi.fn(),
      });
      Object.defineProperty(win, "document", { get: () => popDoc });
      vi.stubGlobal(
        "open",
        vi.fn(() => win as unknown as Window),
      );
      ({ container, grid, slots, users } = mountCallGrid());
      setVoice();
    });

    afterEach(() => {
      unmountCallGrid({ container, grid });
      vi.useRealTimers();
      vi.unstubAllGlobals();
    });

    it("shows the chat here while the call view lives on in its window", () => {
      const ctrl = openPoppedCall();

      expect(inWindow()).toBe(true);
      expect(ctrl.isVideoMode()).toBe(true);
      expect(slots.messagesSlot.style.display).toBe("");
      expect(slots.inputSlot.style.display).toBe("");
      expect(slots.videoGridSlot.style.display).toBe("none");

      // The roster still reaches the call in its window.
      users.set(3, user(3, "cara"));
      ctrl.checkVideoMode();
      expect(tileIds(popDoc)).toEqual(["1", "2", "3"]);
    });

    it("keeps the call in its window when this window switches to a text channel", () => {
      const ctrl = openPoppedCall();
      ctrl.showChat({ keepWatching: true });
      expect(win.close).not.toHaveBeenCalled();
      expect(inWindow()).toBe(true);
      expect(ctrl.isVideoMode()).toBe(true);
    });

    it("raises the window when the call is opened again from here", () => {
      const ctrl = openPoppedCall();
      ctrl.openCall();
      expect(win.focus).toHaveBeenCalled();
      expect(inWindow()).toBe(true);
      expect(slots.videoGridSlot.style.display).toBe("none");
    });

    it("shows the call here again on Bring back", () => {
      openPoppedCall();
      popButton().click();
      expect(inWindow()).toBe(false);
      expect(slots.videoGridSlot.style.display).toBe("block");
      expect(slots.messagesSlot.style.display).toBe("none");
      expect(tileIds(container)).toEqual(["1", "2"]);
    });

    it("shows the call here again when the user closes the window", () => {
      openPoppedCall();
      win.closed = true;
      vi.advanceTimersByTime(300);
      expect(slots.videoGridSlot.style.display).toBe("block");
      expect(container.querySelector("[data-testid='video-grid']")).not.toBeNull();
    });

    it("closes the window and stays on the chat when you leave the call", () => {
      const ctrl = openPoppedCall();
      setVoice({ currentChannelId: null });
      ctrl.checkVideoMode();
      expect(win.close).toHaveBeenCalled();
      expect(ctrl.isVideoMode()).toBe(false);
      expect(slots.videoGridSlot.style.display).toBe("none");
      expect(slots.messagesSlot.style.display).toBe("");
    });
  });
});
