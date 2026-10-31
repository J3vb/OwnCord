import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { stubCapturingResizeObserver } from "../../helpers/resizeObserverStub";
import * as mocks from "../../helpers/videoGridMocks";
import { createVideoGrid, type VideoGridComponent } from "../../../src/components/VideoGrid";
import { RemoteTracks } from "../../../src/features/voice/remoteTracks";
import { VideoQuality, type Room } from "livekit-client";
import {
  addAudioTile,
  fakeStream,
  fakeStreamWithTrack,
  fakePopup,
  makeTileConfig,
  useVideoGridHarness,
} from "../../helpers/videoGridHarness";

vi.mock("@lib/ui/toast", () => mocks.uiToastMock());
vi.mock("@lib/voice/livekitSession", () => mocks.voiceLivekitSessionMock());

describe("VideoGrid", () => {
  let container: HTMLDivElement;
  let grid: VideoGridComponent;

  const harness = useVideoGridHarness((c, g) => {
    container = c;
    grid = g;
  });

  // -----------------------------------------------------------------------
  // Focus mode tests (Spec 2)
  // -----------------------------------------------------------------------

  describe("focus mode", () => {
    it("setFocusedTile creates focus layout with main and strip areas", () => {
      grid.addStream(1, "Alice", fakeStream());
      grid.addStream(2, "Bob", fakeStream());

      grid.setFocusedTile(1);

      const mainArea = container.querySelector(".video-focus-main");
      const stripArea = container.querySelector(".video-focus-strip");
      expect(mainArea).not.toBeNull();
      expect(stripArea).not.toBeNull();

      // Focused tile should be in main area
      const focusedCell = mainArea!.querySelector('[data-user-id="1"]');
      expect(focusedCell).not.toBeNull();
      expect(focusedCell!.classList.contains("focused")).toBe(true);

      // Other tile should be in strip area
      const thumbCell = stripArea!.querySelector('[data-user-id="2"]');
      expect(thumbCell).not.toBeNull();
      expect(thumbCell!.classList.contains("thumb")).toBe(true);
    });

    it("clicking a thumbnail switches focus", () => {
      grid.addStream(1, "Alice", fakeStream());
      grid.addStream(2, "Bob", fakeStream());

      grid.setFocusedTile(1);

      // Click the second tile (thumbnail in strip)
      const thumbCell = container.querySelector('[data-user-id="2"]') as HTMLElement;
      expect(thumbCell).not.toBeNull();
      thumbCell.click();

      // Now tile 2 should be focused in main area
      const mainArea = container.querySelector(".video-focus-main");
      expect(mainArea).not.toBeNull();
      const newFocused = mainArea!.querySelector('[data-user-id="2"]');
      expect(newFocused).not.toBeNull();
      expect(newFocused!.classList.contains("focused")).toBe(true);

      // Tile 1 should now be a thumbnail
      const stripArea = container.querySelector(".video-focus-strip");
      expect(stripArea).not.toBeNull();
      const oldFocused = stripArea!.querySelector('[data-user-id="1"]');
      expect(oldFocused).not.toBeNull();
      expect(oldFocused!.classList.contains("thumb")).toBe(true);
    });

    it("removeStream auto-focuses next tile when focused tile is removed", () => {
      grid.addStream(1, "Alice", fakeStream());
      grid.addStream(2, "Bob", fakeStream());

      grid.setFocusedTile(1);
      expect(grid.getFocusedTileId()).toBe(1);

      grid.removeStream(1);

      // Remaining tile 2 should become focused
      expect(grid.getFocusedTileId()).toBe(2);
    });

    it("removeStream clears focus when last tile removed", () => {
      grid.addStream(1, "Alice", fakeStream());

      grid.setFocusedTile(1);
      expect(grid.getFocusedTileId()).toBe(1);

      grid.removeStream(1);

      // Focus cleared — no focus-mode class
      expect(grid.getFocusedTileId()).toBeNull();
      const root = container.querySelector(".video-grid");
      expect(root!.classList.contains("focus-mode")).toBe(false);
    });

    it("getFocusedTileId returns correct value", () => {
      grid.addStream(1, "Alice", fakeStream());

      expect(grid.getFocusedTileId()).toBeNull();

      grid.setFocusedTile(1);
      expect(grid.getFocusedTileId()).toBe(1);
    });

    it("focus-mode class is added to root when a tile is focused", () => {
      grid.addStream(1, "Alice", fakeStream());
      grid.addStream(2, "Bob", fakeStream());

      const root = container.querySelector(".video-grid") as HTMLElement;
      expect(root.classList.contains("focus-mode")).toBe(false);

      grid.setFocusedTile(1);
      expect(root.classList.contains("focus-mode")).toBe(true);
    });

    it("strip area not shown when only one tile is focused (no thumbnails)", () => {
      grid.addStream(1, "Alice", fakeStream());

      grid.setFocusedTile(1);

      const mainArea = container.querySelector(".video-focus-main");
      expect(mainArea).not.toBeNull();
      // Only one tile — no strip should be rendered
      const stripArea = container.querySelector(".video-focus-strip");
      expect(stripArea).toBeNull();
    });

    it("clicking mute button on a focused tile does not switch focus", () => {
      addAudioTile(grid, 1, "Alice", false);
      grid.addStream(2, "Bob", fakeStream());

      grid.setFocusedTile(1);
      expect(grid.getFocusedTileId()).toBe(1);

      // Click the mute button on Alice's tile
      const muteBtn = container.querySelector(".tile-mute-btn") as HTMLButtonElement;
      muteBtn.click();

      // Focus should remain on tile 1
      expect(grid.getFocusedTileId()).toBe(1);
    });

    it("adding a stream during focus mode preserves focus layout", () => {
      grid.addStream(1, "Alice", fakeStream());
      grid.addStream(2, "Bob", fakeStream());

      grid.setFocusedTile(1);

      // Add a third stream
      grid.addStream(3, "Charlie", fakeStream());

      // Focus should still be on tile 1
      expect(grid.getFocusedTileId()).toBe(1);

      const mainArea = container.querySelector(".video-focus-main");
      expect(mainArea).not.toBeNull();
      expect(mainArea!.querySelector('[data-user-id="1"]')).not.toBeNull();

      // Both Bob and Charlie should be in strip
      const stripArea = container.querySelector(".video-focus-strip");
      expect(stripArea).not.toBeNull();
      expect(stripArea!.querySelectorAll(".video-cell").length).toBe(2);
    });

    it("focused cell retains data-stream-type attribute in focus layout", () => {
      const config = makeTileConfig({ isScreenshare: true });
      grid.addStream(1, "Alice (Screen)", fakeStream(), config);
      grid.addStream(2, "Bob", fakeStream());

      grid.setFocusedTile(1);

      const mainArea = container.querySelector(".video-focus-main");
      const focusedCell = mainArea!.querySelector(".video-cell") as HTMLElement;
      expect(focusedCell.dataset.streamType).toBe("screenshare");
    });

    it("thumbnail cells retain data-stream-type attribute in strip", () => {
      const cameraConfig = makeTileConfig({ isScreenshare: false });
      grid.addStream(1, "Alice", fakeStream(), cameraConfig);

      const screenConfig = makeTileConfig({ isScreenshare: true });
      grid.addStream(2, "Bob (Screen)", fakeStream(), screenConfig);

      grid.setFocusedTile(2);

      const stripArea = container.querySelector(".video-focus-strip");
      const thumbCell = stripArea!.querySelector(".video-cell") as HTMLElement;
      expect(thumbCell.dataset.streamType).toBe("camera");
    });

    it("removing non-focused tile preserves current focus", () => {
      grid.addStream(1, "Alice", fakeStream());
      grid.addStream(2, "Bob", fakeStream());
      grid.addStream(3, "Charlie", fakeStream());

      grid.setFocusedTile(1);
      grid.removeStream(3);

      expect(grid.getFocusedTileId()).toBe(1);
      const mainArea = container.querySelector(".video-focus-main");
      expect(mainArea!.querySelector('[data-user-id="1"]')).not.toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // clearStreams (B1-8: stale remote tiles survive join -> leave -> join)
  // -----------------------------------------------------------------------

  describe("clearStreams", () => {
    it("removes every tile", () => {
      grid.addStream(1, "Alice", fakeStream());
      grid.addStream(2, "Bob", fakeStream());
      expect(grid.hasStreams()).toBe(true);

      grid.clearStreams();

      expect(grid.hasStreams()).toBe(false);
      expect(container.querySelectorAll(".video-cell").length).toBe(0);
    });

    it("clears focus state along with the tiles", () => {
      grid.addStream(1, "Alice", fakeStream());
      grid.setFocusedTile(1);
      expect(grid.getFocusedTileId()).toBe(1);

      grid.clearStreams();

      expect(grid.getFocusedTileId()).toBeNull();
    });

    it("cleans up track listeners for every cell", () => {
      const { stream, track } = fakeStreamWithTrack();
      grid.addStream(1, "Alice", stream);

      grid.clearStreams();

      expect(track.listeners["ended"]?.length ?? 0).toBe(0);
    });

    it("is a no-op on an empty grid", () => {
      expect(() => grid.clearStreams()).not.toThrow();
      expect(grid.hasStreams()).toBe(false);
    });
  });

  describe("people without a camera (avatar tiles)", () => {
    const person = (userId: number, label: string) => {
      const content = document.createElement("div");
      content.className = "test-avatar";
      return { userId, label, content };
    };
    const avatarTiles = () => [...container.querySelectorAll<HTMLElement>(".video-cell--avatar")];

    it("draws an avatar tile, with the host's content and a name, for each person", () => {
      const otto = person(2, "Otto");
      grid.setPeople([otto, person(1, "You")]);

      const tiles = avatarTiles();
      expect(tiles.map((t) => t.dataset.personId)).toEqual(["2", "1"]);
      expect(tiles[0]!.contains(otto.content)).toBe(true);
      expect(tiles[0]!.querySelector(".video-username")!.textContent).toBe("Otto");
    });

    it("puts streams first, and hides a person's avatar while their camera tile is up", () => {
      grid.setPeople([person(2, "Otto"), person(1, "You")]);
      grid.addStream(2, "Otto", fakeStream(), makeTileConfig({ audioUserId: 2 }));

      expect(avatarTiles().map((t) => t.dataset.personId)).toEqual(["1"]);
      const cells = [...container.querySelectorAll(".video-cell")];
      expect(cells[0]!.getAttribute("data-user-id")).toBe("2");

      grid.removeStream(2);
      expect(avatarTiles().map((t) => t.dataset.personId)).toEqual(["2", "1"]);
    });

    it("keeps a person's avatar beside their screen share: only a camera replaces it", () => {
      grid.setPeople([person(2, "Otto")]);
      grid.addStream(2 + 1_000_000, "Otto's screen", fakeStream(), {
        isSelf: false,
        audioUserId: 2,
        isScreenshare: true,
      });
      expect(avatarTiles().map((t) => t.dataset.personId)).toEqual(["2"]);
    });

    it("does not count people as streams", () => {
      grid.setPeople([person(2, "Otto")]);
      expect(grid.hasStreams()).toBe(false);
    });

    it("reuses a person's tile across updates, and drops people who left", () => {
      const otto = person(2, "Otto");
      grid.setPeople([otto, person(3, "Sam")]);
      const before = avatarTiles()[0];

      grid.setPeople([otto]);
      expect(avatarTiles()).toHaveLength(1);
      expect(avatarTiles()[0]).toBe(before);
    });

    it("clears every avatar tile when the host stops drawing people", () => {
      grid.setPeople([person(2, "Otto")]);
      grid.setPeople([]);
      expect(avatarTiles()).toHaveLength(0);
    });

    it("rings the avatar tile of a person speaking, and only theirs", () => {
      grid.setPeople([person(2, "Otto"), person(3, "Sam")]);
      grid.setSpeaking(new Set([2]));

      const [otto, sam] = avatarTiles();
      expect(otto!.classList.contains("video-cell--speaking")).toBe(true);
      expect(sam!.classList.contains("video-cell--speaking")).toBe(false);

      grid.setSpeaking(new Set());
      expect(otto!.classList.contains("video-cell--speaking")).toBe(false);
    });

    it("rings a person's avatar tile drawn after they started speaking", () => {
      grid.setSpeaking(new Set([2]));
      grid.setPeople([person(2, "Otto")]);
      expect(avatarTiles()[0]!.classList.contains("video-cell--speaking")).toBe(true);
    });

    it("badges a muted or deafened person's avatar tile", () => {
      grid.setPeople([person(2, "Otto"), person(3, "Sam")]);
      grid.setUserAudioState(new Map([[3, { muted: true, deafened: true }]]));

      const [otto, sam] = avatarTiles();
      expect(otto!.querySelector("[data-testid='tile-audio-state']")).toBeNull();
      const badge = sam!.querySelector("[data-testid='tile-audio-state']");
      expect(badge!.classList.contains("video-cell__audio--deafened")).toBe(true);

      grid.setUserAudioState(new Map());
      expect(sam!.querySelector("[data-testid='tile-audio-state']")).toBeNull();
    });

    it("adds no ring or badge to a person whose host marks their state itself", () => {
      grid.setPeople([{ ...person(2, "Otto"), marksOwnState: true }]);
      grid.setSpeaking(new Set([2]));
      grid.setUserAudioState(new Map([[2, { muted: true, deafened: false }]]));

      const tile = avatarTiles()[0]!;
      expect(tile.classList.contains("video-cell--speaking")).toBe(false);
      expect(tile.querySelector("[data-testid='tile-audio-state']")).toBeNull();
    });
  });

  describe("video layers follow what each tile shows", () => {
    const SCREEN = 3 + 1_000_000;
    /** Rendered tile sizes by data-user-id; an absent tile renders 0 × 0. */
    let sizes: Map<string, { width: number; height: number }>;
    let observers: Array<() => void>;
    let hidden: boolean;
    let pubs: Map<string, ReturnType<typeof publication>>;

    function publication() {
      return {
        track: {},
        isSubscribed: true,
        setEnabled: vi.fn(),
        setVideoQuality: vi.fn(),
        setVideoDimensions: vi.fn(),
      };
    }
    /** The room the grid's views land on, through the real RemoteTracks. */
    function room(): Room {
      const participants = new Map<string, unknown>();
      for (const uid of [2, 3]) {
        participants.set(`user-${uid}`, {
          identity: `user-${uid}`,
          getTrackPublication: (source: string) => pubs.get(`${uid}:${source}`),
        });
      }
      return { remoteParticipants: participants } as unknown as Room;
    }
    const pub = (uid: number, source = "camera") => pubs.get(`${uid}:${source}`)!;
    /** The last enabled state asked of a publication. */
    const enabled = (uid: number, source = "camera") =>
      pub(uid, source).setEnabled.mock.lastCall?.[0] as boolean | undefined;
    /** Resize tiles and let the sizes settle (views follow a resize after 150 ms). */
    function resize(entries: Record<number, [number, number]>): void {
      for (const [id, [width, height]] of Object.entries(entries)) sizes.set(id, { width, height });
      for (const fire of observers) fire();
      vi.advanceTimersByTime(150);
    }
    const cellOf = (id: number) =>
      container.querySelector<HTMLElement>(`.video-cell[data-user-id='${id}']`)!;

    beforeEach(() => {
      grid.destroy?.();
      vi.useFakeTimers();
      sizes = new Map();
      observers = [];
      hidden = false;
      pubs = new Map([
        ["2:camera", publication()],
        ["3:camera", publication()],
        ["3:screen_share", publication()],
      ]);
      stubCapturingResizeObserver(observers);
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
        this: HTMLElement,
      ) {
        const size = sizes.get(this.dataset["userId"] ?? "") ?? { width: 0, height: 0 };
        return { ...size, top: 0, left: 0, right: size.width, bottom: size.height } as DOMRect;
      });
      Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });

      const tracks = new RemoteTracks(room);
      grid = harness.adopt(createVideoGrid());
      grid.mount(container);
      grid.setCallbacks({
        setStreamView: (tileId, view) =>
          tileId >= 1_000_000
            ? tracks.setRemoteVideoView(tileId - 1_000_000, "screenshare", view)
            : tracks.setRemoteVideoView(tileId, "camera", view),
      });
    });

    afterEach(() => {
      vi.useRealTimers();
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
      delete (document as { hidden?: unknown }).hidden;
    });

    function addCameras(): void {
      grid.addStream(1, "me (You)", fakeStream(), makeTileConfig({ isSelf: true, audioUserId: 1 }));
      grid.addStream(2, "Otto", fakeStream(), makeTileConfig({ audioUserId: 2 }));
      grid.addStream(3, "Ada", fakeStream(), makeTileConfig({ audioUserId: 3 }));
      resize({ 1: [320, 180], 2: [320, 180], 3: [320, 180] });
    }

    it("hiding the grid calls setEnabled(false) on every remote camera publication, and showing it re-enables them", () => {
      addCameras();
      expect(enabled(2)).toBe(true);
      expect(enabled(3)).toBe(true);

      // The grid slot goes display:none (back to chat): every tile renders 0 × 0.
      resize({ 1: [0, 0], 2: [0, 0], 3: [0, 0] });
      expect(enabled(2)).toBe(false);
      expect(enabled(3)).toBe(false);

      resize({ 1: [320, 180], 2: [320, 180], 3: [320, 180] });
      expect(enabled(2)).toBe(true);
      expect(enabled(3)).toBe(true);
    });

    it("sends one view per tile once a burst of resizes settles (a window drag)", () => {
      addCameras();
      pub(2).setVideoDimensions.mockClear();
      for (const width of [400, 480, 560, 640]) {
        sizes.set("2", { width, height: (width * 9) / 16 });
        for (const fire of observers) fire();
        vi.advanceTimersByTime(16);
      }
      expect(pub(2).setVideoDimensions).not.toHaveBeenCalled();
      vi.advanceTimersByTime(150);
      expect(pub(2).setVideoDimensions).toHaveBeenCalledTimes(1);
      expect(pub(2).setVideoDimensions).toHaveBeenLastCalledWith({ width: 640, height: 360 });
    });

    it("stops the video while the app is hidden (minimised), and resumes it when shown", () => {
      addCameras();
      hidden = true;
      document.dispatchEvent(new Event("visibilitychange"));
      expect(enabled(2)).toBe(false);
      expect(enabled(3)).toBe(false);

      hidden = false;
      document.dispatchEvent(new Event("visibilitychange"));
      expect(enabled(2)).toBe(true);
      expect(enabled(3)).toBe(true);
    });

    it("a 160-px tile requests a lower quality than a focused tile", () => {
      addCameras();
      pub(2).setVideoDimensions.mockClear();
      grid.setFocusedTile(2);
      resize({ 2: [1280, 720], 3: [160, 90] });

      expect(pub(3).setVideoDimensions).toHaveBeenLastCalledWith({ width: 160, height: 90 });
      expect(pub(2).setVideoQuality).toHaveBeenLastCalledWith(VideoQuality.HIGH);
      expect(pub(2).setVideoDimensions).not.toHaveBeenCalled();
      expect(enabled(2)).toBe(true);
      expect(enabled(3)).toBe(true);

      // Back to the grid: tile 2 is sized like any other again.
      grid.setFocusedTile(null);
      resize({ 2: [320, 180], 3: [320, 180] });
      expect(pub(2).setVideoDimensions).toHaveBeenLastCalledWith({ width: 320, height: 180 });
    });

    it("a focused screen share keeps its top layer however small its tile renders", () => {
      grid.addStream(
        SCREEN,
        "Ada (Screen)",
        fakeStream(),
        makeTileConfig({ audioUserId: 3, isScreenshare: true }),
      );
      grid.setFocusedTile(SCREEN);
      resize({ [SCREEN]: [200, 112] });
      expect(pub(3, "screen_share").setVideoQuality).toHaveBeenLastCalledWith(VideoQuality.HIGH);
      expect(pub(3, "screen_share").setVideoDimensions).not.toHaveBeenCalled();
      expect(enabled(3, "screen_share")).toBe(true);
    });

    it("a stopped tile stops its video, and Watch brings it back", () => {
      addCameras();
      cellOf(2).querySelector<HTMLButtonElement>("[data-tile-control='stop']")!.click();
      expect(enabled(2)).toBe(false);
      expect(enabled(3)).toBe(true);
      cellOf(2).querySelector<HTMLButtonElement>("[data-tile-control='watch']")!.click();
      expect(enabled(2)).toBe(true);
    });

    it("a tile popped out to a window keeps its video at the top layer while the grid is hidden", () => {
      addCameras();
      const popup = fakePopup();
      vi.stubGlobal("open", () => popup.win);
      cellOf(2).querySelector<HTMLButtonElement>("[data-tile-control='pip']")!.click();
      resize({ 1: [0, 0], 2: [0, 0], 3: [0, 0] });
      hidden = true;
      document.dispatchEvent(new Event("visibilitychange"));
      expect(enabled(2)).toBe(true);
      expect(pub(2).setVideoQuality).toHaveBeenLastCalledWith(VideoQuality.HIGH);
      expect(enabled(3)).toBe(false);

      // Back in a hidden grid, it stops like the others.
      popup.win.closed = true;
      vi.advanceTimersByTime(1000);
      expect(enabled(2)).toBe(false);
    });

    it("asks a replacement publication (after a reconnect) for the tile's view again", () => {
      addCameras();
      resize({ 2: [0, 0] });
      expect(enabled(2)).toBe(false);
      pubs.set("2:camera", publication());
      const { stream } = fakeStreamWithTrack();
      grid.addStream(2, "Otto", stream, makeTileConfig({ audioUserId: 2 }));
      expect(enabled(2)).toBe(false);
    });
  });
});
