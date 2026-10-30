import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as mocks from "../../helpers/videoGridMocks";
import { cascadedDeclaration, keyword } from "../../helpers/app-css";
import { expectConsole } from "../../helpers/console";
import { registerVideoSurface } from "../../../src/lib/voice/videoSurface";
import {
  createVideoGrid,
  type VideoGridComponent,
  type TileConfig,
} from "../../../src/components/VideoGrid";
import {
  fakeStream,
  fakeStreamWithTrack,
  fakePopup,
  makeTileConfig,
  useVideoGridHarness,
} from "../../helpers/videoGridHarness";

vi.mock("@lib/ui/toast", () => mocks.uiToastMock());
vi.mock("@lib/voice/livekitSession", () => mocks.voiceLivekitSessionMock());

const { mockMuteScreenshareAudio, mockSetScreenshareAudioVolume, mockShowToast } = mocks;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("VideoGrid", () => {
  let container: HTMLDivElement;
  let grid: VideoGridComponent;

  useVideoGridHarness({
    wired: (c, g) => {
      container = c;
      grid = g;
    },
    currentGrid: () => grid,
  });

  describe("pop-out window (Discord-style)", () => {
    const SCREEN = 2 + 1_000_000;
    const screenCfg: TileConfig = {
      isSelf: false,
      audioUserId: 2,
      isScreenshare: true,
      name: "Otto",
    };
    const cell = (id: number) =>
      container.querySelector<HTMLElement>(`.video-cell[data-user-id='${id}']`)!;
    const control = (id: number, name: string) =>
      cell(id).querySelector<HTMLButtonElement>(`[data-tile-control='${name}']`)!;
    let popup: ReturnType<typeof fakePopup>;
    let open: ReturnType<typeof vi.fn>;
    let requestFullscreen: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      document.body.appendChild(container);
      vi.useFakeTimers();
      popup = fakePopup();
      open = vi.fn(() => popup.win as unknown as Window);
      vi.stubGlobal("open", open);
      requestFullscreen = vi.fn(function (this: Element) {
        popup.enterFullscreen(this);
        return Promise.resolve();
      });
      Object.defineProperty(HTMLElement.prototype, "requestFullscreen", {
        configurable: true,
        value: requestFullscreen,
      });
    });

    afterEach(() => {
      grid.destroy?.();
      container.remove();
      vi.useRealTimers();
      vi.unstubAllGlobals();
      delete (HTMLElement.prototype as { requestFullscreen?: unknown }).requestFullscreen;
    });

    it("moves the tile's own video into a window of its own", () => {
      const stream = fakeStream();
      grid.addStream(SCREEN, "Otto (Screen)", stream, screenCfg);
      const video = cell(SCREEN).querySelector("video")!;

      control(SCREEN, "pip").click();

      expect(open).toHaveBeenCalledTimes(1);
      const label = String(open.mock.calls[0]![1]);
      expect(label).toMatch(/^owncord-popout-\d+$/);
      expect(open.mock.calls[0]![0]).toBe(`about:blank#${label}`);
      expect(popup.doc.body.contains(video)).toBe(true);
      expect(video.srcObject).toBe(stream);
      expect(popup.doc.title).toBe("Otto (Screen) — OwnCord");
      expect(cell(SCREEN).querySelector("video")).toBeNull();
      expect(cell(SCREEN).querySelector(".video-popped")).not.toBeNull();
      expect(control(SCREEN, "pip").getAttribute("aria-pressed")).toBe("true");
    });

    it("zooms and pans in the window as on the tile, starting unzoomed", () => {
      grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screenCfg);
      const wheelIn = () =>
        new WheelEvent("wheel", { deltaY: -1, ctrlKey: true, bubbles: true, cancelable: true });
      cell(SCREEN).dispatchEvent(wheelIn());
      expect(cell(SCREEN).style.getPropertyValue("--video-scale")).not.toBe("");

      control(SCREEN, "pip").click();
      expect(cell(SCREEN).style.getPropertyValue("--video-scale")).toBe("");
      const root = popup.doc.querySelector<HTMLElement>(".video-popout")!;
      root.querySelector("video")!.dispatchEvent(wheelIn());
      root.dispatchEvent(wheelIn());
      expect(Number(root.style.getPropertyValue("--video-scale"))).toBeGreaterThan(1.3);

      // The drag follows the pointer in the window's own document.
      root.dispatchEvent(new MouseEvent("mousedown", { clientX: 0, clientY: 0, bubbles: true }));
      expect(root.classList.contains("video-panning")).toBe(true);
      popup.doc.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      expect(root.classList.contains("video-panning")).toBe(false);
    });

    it("offers Pop out where picture-in-picture is missing too (WebKitGTK)", () => {
      Object.defineProperty(document, "pictureInPictureEnabled", {
        configurable: true,
        value: false,
      });
      try {
        grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screenCfg);
        expect(control(SCREEN, "pip").hidden).toBe(false);
      } finally {
        delete (document as { pictureInPictureEnabled?: unknown }).pictureInPictureEnabled;
      }
    });

    it("puts the video back in its tile when the window is closed", () => {
      grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screenCfg);
      const video = cell(SCREEN).querySelector("video")!;
      control(SCREEN, "pip").click();

      popup.win.closed = true;
      vi.advanceTimersByTime(1000);

      expect(cell(SCREEN).contains(video)).toBe(true);
      expect(cell(SCREEN).querySelector(".video-popped")).toBeNull();
      expect(control(SCREEN, "pip").getAttribute("aria-pressed")).toBe("false");
    });

    it("gives a video that came back empty its stream again", () => {
      // WebKitGTK drops a <video>'s player with the window it played in.
      const stream = fakeStream();
      grid.addStream(SCREEN, "Otto (Screen)", stream, screenCfg);
      const video = cell(SCREEN).querySelector("video")!;
      control(SCREEN, "pip").click();
      const given: unknown[] = [];
      Object.defineProperty(video, "srcObject", {
        configurable: true,
        get: () => given.at(-1) ?? stream,
        set: (v: unknown) => {
          given.push(v);
        },
      });

      popup.win.closed = true;
      vi.advanceTimersByTime(1000);

      expect(video.readyState).toBe(HTMLMediaElement.HAVE_NOTHING);
      expect(given).toEqual([null, stream]);
      expect(cell(SCREEN).contains(video)).toBe(true);
    });

    it("leaves a video that still plays on its return alone", () => {
      const stream = fakeStream();
      grid.addStream(SCREEN, "Otto (Screen)", stream, screenCfg);
      const video = cell(SCREEN).querySelector("video")!;
      control(SCREEN, "pip").click();
      Object.defineProperty(video, "readyState", {
        configurable: true,
        get: () => HTMLMediaElement.HAVE_ENOUGH_DATA,
      });
      const given: unknown[] = [];
      Object.defineProperty(video, "srcObject", {
        configurable: true,
        get: () => stream,
        set: (v: unknown) => {
          given.push(v);
        },
      });

      control(SCREEN, "pop-in").click();

      expect(given).toEqual([]);
    });

    it("shows a canvas-drawn stream's canvas with its video, in the window and back", () => {
      // Linux draws remote video into a canvas (lib/voice/videoSurface.ts).
      const { stream, track } = fakeStreamWithTrack();
      const canvas = document.createElement("canvas");
      registerVideoSurface(track as unknown as MediaStreamTrack, canvas);
      grid.addStream(SCREEN, "Otto (Screen)", stream, screenCfg);
      const video = cell(SCREEN).querySelector("video")!;
      expect(video.nextSibling).toBe(canvas);
      expect(video.dataset.surface).toBe("");

      control(SCREEN, "pip").click();
      expect(popup.doc.body.contains(canvas)).toBe(true);
      expect(video.nextSibling).toBe(canvas);
      expect(cell(SCREEN).contains(canvas)).toBe(false);

      control(SCREEN, "pop-in").click();
      expect(cell(SCREEN).contains(canvas)).toBe(true);
      expect(video.nextSibling).toBe(canvas);

      // Its stream gone (not watched), the canvas goes with it.
      grid.addStream(SCREEN, "Otto (Screen)", null, screenCfg);
      expect(canvas.parentNode).toBeNull();
      expect(video.dataset.surface).toBeUndefined();
    });

    it("Bring back closes the window and returns the video", () => {
      grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screenCfg);
      const video = cell(SCREEN).querySelector("video")!;
      control(SCREEN, "pip").click();

      control(SCREEN, "pop-in").click();

      expect(popup.win.close).toHaveBeenCalledTimes(1);
      expect(cell(SCREEN).contains(video)).toBe(true);

      // Pop out again, and back with the same toggle.
      control(SCREEN, "pip").click();
      expect(open).toHaveBeenCalledTimes(2);
      control(SCREEN, "pip").click();
      expect(cell(SCREEN).contains(video)).toBe(true);
    });

    it("pops the same tile out again right after Bring back, under a new window label", () => {
      // The old window may still be registered while it closes: reusing its
      // label would make the desktop refuse the new one.
      grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screenCfg);
      control(SCREEN, "pip").click();
      control(SCREEN, "pop-in").click();
      popup = fakePopup();
      open.mockReturnValue(popup.win as unknown as Window);
      control(SCREEN, "pip").click();

      expect(open).toHaveBeenCalledTimes(2);
      const [first, second] = open.mock.calls.map((c) => String(c[0]));
      expect(first).toMatch(/^about:blank#owncord-popout-\d+$/);
      expect(second).toMatch(/^about:blank#owncord-popout-\d+$/);
      expect(second).not.toBe(first);
    });

    it("a stopped tile pops out watching again, not as a blank window", () => {
      grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screenCfg);
      const video = cell(SCREEN).querySelector("video")!;
      control(SCREEN, "stop").click();

      control(SCREEN, "pip").click();

      expect(popup.doc.body.contains(video)).toBe(true);
      expect(video.hidden).toBe(false);
      expect(cell(SCREEN).classList.contains("video-cell--stopped")).toBe(false);
      expect(cell(SCREEN).querySelector(".video-stopped")).toBeNull();
    });

    it("a stream offered with Watch pops out watching: it asks for the stream", () => {
      const setStreamWatched = vi.fn();
      grid.setCallbacks({ setStreamWatched });
      grid.addStream(SCREEN, "Otto (Screen)", null, screenCfg);

      control(SCREEN, "pip").click();

      expect(setStreamWatched).toHaveBeenCalledWith(SCREEN, true);
      expect(cell(SCREEN).classList.contains("video-cell--stopped")).toBe(false);
    });

    it("takes the stream's volume and mute along into the window, and brings them back", () => {
      grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screenCfg);
      control(SCREEN, "pip").click();

      const overlay = popup.doc.querySelector<HTMLElement>(".video-tile-overlay")!;
      expect(overlay).not.toBeNull();
      expect(overlay.hasAttribute("inert")).toBe(false);
      const slider = overlay.querySelector<HTMLInputElement>(".tile-volume-slider")!;
      expect(slider.getAttribute("aria-label")).toBe("Otto stream volume");
      slider.value = "40";
      slider.dispatchEvent(new Event("input"));
      expect(mockSetScreenshareAudioVolume).toHaveBeenLastCalledWith(2, 0.4);
      overlay.querySelector<HTMLButtonElement>(".tile-mute-btn")!.click();
      expect(mockMuteScreenshareAudio).toHaveBeenLastCalledWith(2, true);
      // Shown in the window, where no tile hover reveals it.
      expect(keyword(cascadedDeclaration(".video-popout .video-tile-overlay", "opacity"))).toBe(
        "1",
      );

      popup.win.close();
      vi.advanceTimersByTime(1000);
      expect(cell(SCREEN).querySelector(".video-tile-overlay")).toBe(overlay);
      expect(popup.doc.querySelector(".video-tile-overlay")).toBeNull();
    });

    it("hides a muted track's stalled frame in the window too", () => {
      const { stream, track } = fakeStreamWithTrack();
      grid.addStream(SCREEN, "Otto (Screen)", stream, screenCfg);
      control(SCREEN, "pip").click();
      const video = popup.doc.querySelector("video")!;

      track.dispatchEvent("mute");
      expect(video.classList.contains("track-muted")).toBe(true);
      expect(keyword(cascadedDeclaration(".video-popout video.track-muted", "visibility"))).toBe(
        "hidden",
      );
      track.dispatchEvent("unmute");
      expect(video.classList.contains("track-muted")).toBe(false);
    });

    it("keeps keyboard focus on the tile when Bring back goes", () => {
      grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screenCfg);
      control(SCREEN, "pip").click();
      const back = control(SCREEN, "pop-in");
      back.focus();

      back.click();

      expect(document.activeElement).toBe(control(SCREEN, "pip"));
    });

    it("takes the covered tile controls out of reach while popped out, Bring back aside", () => {
      grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screenCfg);
      control(SCREEN, "pip").click();

      for (const name of ["select", "stop", "pip", "fullscreen"]) {
        expect(control(SCREEN, name).closest("[inert]"), name).not.toBeNull();
      }
      // The volume controls went into the window with the video.
      expect(cell(SCREEN).querySelector(".tile-mute-btn")).toBeNull();
      expect(control(SCREEN, "pop-in").closest("[inert]")).toBeNull();

      control(SCREEN, "pop-in").click();
      expect(cell(SCREEN).querySelector("[inert]")).toBeNull();
    });

    it("puts keyboard focus back on the tile when the window is closed from outside", () => {
      grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screenCfg);
      control(SCREEN, "pip").focus();
      control(SCREEN, "pip").click();
      (document.activeElement as HTMLElement | null)?.blur();

      popup.win.closed = true;
      vi.advanceTimersByTime(1000);

      expect(document.activeElement).toBe(control(SCREEN, "pip"));
    });

    it("leaves focus where it is when it is elsewhere as the window closes", () => {
      const input = document.createElement("input");
      document.body.appendChild(input);
      try {
        grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screenCfg);
        control(SCREEN, "pip").click();
        input.focus();

        popup.win.closed = true;
        vi.advanceTimersByTime(1000);

        expect(document.activeElement).toBe(input);
      } finally {
        input.remove();
      }
    });

    it("goes full screen in the window, and takes the window itself with it", async () => {
      const setWindowFullscreen = vi.fn().mockResolvedValue(undefined);
      grid.setCallbacks({ setWindowFullscreen });
      grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screenCfg);
      control(SCREEN, "pip").click();
      const label = String(open.mock.calls[0]![1]);
      const fs = popup.doc.querySelector<HTMLButtonElement>("[data-popout-control='fullscreen']")!;
      expect(fs.getAttribute("aria-label")).toBe("Full screen");

      fs.click();
      await Promise.resolve();
      expect(requestFullscreen).toHaveBeenCalledTimes(1);
      expect(popup.doc.contains(requestFullscreen.mock.contexts[0] as Node)).toBe(true);
      expect(setWindowFullscreen).toHaveBeenLastCalledWith(true, label);
      expect(fs.getAttribute("aria-label")).toBe("Exit full screen");

      // F in the window toggles it back, as on a tile.
      popup.doc.body.dispatchEvent(new KeyboardEvent("keydown", { key: "f", bubbles: true }));
      await Promise.resolve();
      expect(popup.exitFullscreen).toHaveBeenCalledTimes(1);
      expect(setWindowFullscreen).toHaveBeenLastCalledWith(false, label);
      expect(fs.getAttribute("aria-label")).toBe("Full screen");

      // Double-click on the video goes full screen too.
      popup.doc
        .querySelector("video")!
        .dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
      await Promise.resolve();
      expect(requestFullscreen).toHaveBeenCalledTimes(2);
    });

    it("fills the screen with the window alone where the page cannot go full screen", async () => {
      delete (HTMLElement.prototype as { requestFullscreen?: unknown }).requestFullscreen;
      const setWindowFullscreen = vi.fn().mockResolvedValue(undefined);
      grid.setCallbacks({ setWindowFullscreen });
      grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screenCfg);
      control(SCREEN, "pip").click();
      const label = String(open.mock.calls[0]![1]);

      popup.doc.querySelector<HTMLButtonElement>("[data-popout-control='fullscreen']")!.click();
      expect(setWindowFullscreen).toHaveBeenLastCalledWith(true, label);
      popup.doc.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      expect(setWindowFullscreen).toHaveBeenLastCalledWith(false, label);
    });

    it("a new track reaches the popped-out video", () => {
      grid.addStream(SCREEN, "Otto (Screen)", fakeStreamWithTrack().stream, screenCfg);
      control(SCREEN, "pip").click();
      const next = fakeStreamWithTrack().stream;

      grid.addStream(SCREEN, "Otto (Screen)", next, screenCfg);

      expect(popup.doc.querySelector("video")!.srcObject).toBe(next);
    });

    it("draws the window again when it loads its page after opening", () => {
      grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screenCfg);
      const video = cell(SCREEN).querySelector("video")!;
      control(SCREEN, "pip").click();

      popup.reload();

      expect(popup.doc.body.contains(video)).toBe(true);
      expect(popup.doc.title).toBe("Otto (Screen) — OwnCord");
    });

    it("closes the window with its stream, the grid, or the app page", () => {
      grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screenCfg);
      control(SCREEN, "pip").click();
      grid.removeStream(SCREEN);
      expect(popup.win.close).toHaveBeenCalledTimes(1);

      popup = fakePopup();
      grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screenCfg);
      control(SCREEN, "pip").click();
      grid.destroy?.();
      expect(popup.win.close).toHaveBeenCalledTimes(1);

      grid = createVideoGrid();
      grid.mount(container);
      popup = fakePopup();
      grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screenCfg);
      control(SCREEN, "pip").click();
      window.dispatchEvent(new Event("pagehide"));
      expect(popup.win.close).toHaveBeenCalledTimes(1);
    });

    describe("teardown of the pop-out's listeners and poll", () => {
      const closers: Array<[string, () => void]> = [
        [
          "the user closes the window",
          () => {
            popup.win.closed = true;
            vi.advanceTimersByTime(1000);
          },
        ],
        ["Bring back", () => control(SCREEN, "pop-in").click()],
        ["the stream is removed", () => grid.removeStream(SCREEN)],
        ["the grid is destroyed", () => grid.destroy?.()],
      ];

      it.each(closers)("leaves nothing alive when %s", async (_name, close) => {
        const setWindowFullscreen = vi.fn().mockResolvedValue(undefined);
        grid.setCallbacks({ setWindowFullscreen });
        grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screenCfg);
        const before = vi.getTimerCount();
        control(SCREEN, "pip").click();
        expect(vi.getTimerCount()).toBeGreaterThan(before);
        const oldDoc = popup.doc;

        close();
        expect(vi.getTimerCount()).toBeLessThanOrEqual(before);
        popup.win.close.mockClear();
        setWindowFullscreen.mockClear();

        window.dispatchEvent(new Event("pagehide"));
        oldDoc.body.dispatchEvent(new KeyboardEvent("keydown", { key: "f", bubbles: true }));
        oldDoc.dispatchEvent(new Event("fullscreenchange"));
        await Promise.resolve();
        expect(popup.win.close).not.toHaveBeenCalled();
        expect(setWindowFullscreen).not.toHaveBeenCalled();
      });
    });

    it("full screen on a popped-out tile brings it back first", async () => {
      grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screenCfg);
      const video = cell(SCREEN).querySelector("video")!;
      control(SCREEN, "pip").click();

      control(SCREEN, "fullscreen").click();

      expect(popup.win.close).toHaveBeenCalledTimes(1);
      expect(cell(SCREEN).contains(video)).toBe(true);
      expect(requestFullscreen.mock.contexts[0]).toBe(cell(SCREEN));
    });
  });
  describe("pop out the whole call", () => {
    const OTTO = 2;
    let popup: ReturnType<typeof fakePopup>;
    let open: ReturnType<typeof vi.fn>;
    let focusWindow: ReturnType<typeof vi.fn>;
    const controls = () => ({
      onMuteToggle: vi.fn(),
      onDeafenToggle: vi.fn(),
      onLeave: vi.fn(),
      onCameraToggle: vi.fn(),
      onCameraDevice: vi.fn(),
      onScreenshareToggle: vi.fn(),
    });
    const root = () =>
      document.querySelector<HTMLElement>("[data-testid='video-grid']") ??
      popup.doc.querySelector<HTMLElement>("[data-testid='video-grid']")!;
    const popButton = () =>
      root().querySelector<HTMLButtonElement>("[data-grid-control='popout']")!;
    const barButton = (id: string) =>
      root().querySelector<HTMLButtonElement>(`.video-grid__controls [data-call-control='${id}']`)!;
    const exit = () => root().querySelector<HTMLButtonElement>("[data-tile-control='exit-grid']")!;

    beforeEach(() => {
      localStorage.clear();
      document.body.appendChild(container);
      vi.useFakeTimers();
      popup = fakePopup();
      focusWindow = vi.fn();
      Object.assign(popup.win, { focus: focusWindow });
      open = vi.fn(() => popup.win as unknown as Window);
      vi.stubGlobal("open", open);
    });

    afterEach(() => {
      grid.destroy?.();
      container.remove();
      vi.useRealTimers();
      vi.unstubAllGlobals();
    });

    function startCall() {
      const cc = controls();
      const onCallPopout = vi.fn();
      grid.setCallbacks({ callControls: cc, onCallPopout });
      grid.setExitVisible(true);
      grid.addStream(OTTO, "Otto", fakeStream(), makeTileConfig({ audioUserId: OTTO }));
      return { cc, onCallPopout };
    }

    it("offers Pop out only in the call view", () => {
      grid.setCallbacks({ callControls: controls() });
      expect(container.querySelector("[data-grid-control='popout']")).toBeNull();
      grid.setExitVisible(true);
      expect(popButton().getAttribute("aria-label")).toBe("Pop out call");
      expect(popButton().getAttribute("aria-pressed")).toBe("false");
    });

    it("moves the grid, its toggles and the control bar into a window of its own", () => {
      const { onCallPopout } = startCall();
      const grid0 = root();
      const video = grid0.querySelector("video")!;

      popButton().click();

      expect(open).toHaveBeenCalledTimes(1);
      expect(String(open.mock.calls[0]![1])).toMatch(/^owncord-popout-\d+$/);
      expect(popup.doc.title).toBe("Call — OwnCord");
      expect(container.querySelector("[data-testid='video-grid']")).toBeNull();
      expect(popup.doc.body.contains(grid0)).toBe(true);
      expect(grid0.querySelector("video")).toBe(video);
      expect(grid0.querySelector(".video-grid__views")).not.toBeNull();
      expect(grid0.querySelector(".video-grid__controls")).not.toBeNull();
      expect(onCallPopout).toHaveBeenCalledWith(true, false);
      expect(popButton().getAttribute("aria-pressed")).toBe("true");
      expect(popButton().getAttribute("aria-label")).toBe("Bring the call back");
      // No Show chat in the window (the app window shows the chat), and no
      // camera picker (its menu opens in the app window).
      expect(exit().hidden).toBe(true);
      expect(barButton("camera-device").style.display).toBe("none");
    });

    it("keeps the call controls working in the pop-out", () => {
      const { cc } = startCall();
      popButton().click();

      barButton("mute").click();
      barButton("leave").click();
      expect(cc.onMuteToggle).toHaveBeenCalledTimes(1);
      expect(cc.onLeave).toHaveBeenCalledTimes(1);

      grid.setCallState({ muted: true, deafened: false, listenOnly: false });
      expect(barButton("mute").getAttribute("aria-pressed")).toBe("true");
    });

    it("brings the call back to the app window before a share picker opens there", () => {
      const { cc, onCallPopout } = startCall();
      popButton().click();
      const grid0 = root();

      barButton("share").click();

      expect(container.contains(grid0)).toBe(true);
      expect(onCallPopout).toHaveBeenLastCalledWith(false, true);
      expect(cc.onScreenshareToggle).toHaveBeenCalledTimes(1);
    });

    it("stops a share from the pop-out without leaving it", () => {
      const { cc } = startCall();
      grid.setCallState({ muted: false, deafened: false, listenOnly: false, screenshare: true });
      popButton().click();

      barButton("share").click();

      expect(popup.doc.body.contains(root())).toBe(true);
      expect(cc.onScreenshareToggle).toHaveBeenCalledTimes(1);
    });

    it("brings the grid back to the app window with Bring back", () => {
      const { onCallPopout } = startCall();
      popButton().click();
      const grid0 = root();

      popButton().click();

      expect(popup.win.close).toHaveBeenCalled();
      expect(container.contains(grid0)).toBe(true);
      expect(grid0.querySelector(".video-grid__controls")).not.toBeNull();
      expect(onCallPopout).toHaveBeenLastCalledWith(false, true);
      expect(popButton().getAttribute("aria-pressed")).toBe("false");
      expect(exit().hidden).toBe(false);
      expect(barButton("camera-device").style.display).toBe("");
      expect(document.activeElement).toBe(popButton());
    });

    it("brings the grid back when the user closes the window", () => {
      const { onCallPopout } = startCall();
      popButton().click();
      const grid0 = root();

      popup.win.closed = true;
      vi.advanceTimersByTime(300);

      expect(container.contains(grid0)).toBe(true);
      expect(onCallPopout).toHaveBeenLastCalledWith(false, true);
    });

    it("closes the window without restoring when the call view ends", () => {
      const { onCallPopout } = startCall();
      popButton().click();
      const grid0 = root();

      grid.setExitVisible(false);

      expect(popup.win.close).toHaveBeenCalled();
      expect(container.contains(grid0)).toBe(true);
      expect(onCallPopout).toHaveBeenLastCalledWith(false, false);
      expect(grid0.querySelector(".video-grid__controls")).toBeNull();
    });

    it("closes the window when the grid is torn down", () => {
      startCall();
      popButton().click();
      grid.destroy?.();
      expect(popup.win.close).toHaveBeenCalled();
    });

    it("stays in the app window, with a toast, when no window opens", () => {
      vi.stubGlobal("open", () => null);
      const { onCallPopout } = startCall();
      popButton().click();
      expectConsole("warn", "Call pop out window refused");
      expect(mockShowToast).toHaveBeenCalledWith("Couldn't open the pop-out window", "error");
      expect(container.querySelector("[data-testid='video-grid']")).not.toBeNull();
      expect(onCallPopout).not.toHaveBeenCalled();
      expect(popButton().getAttribute("aria-pressed")).toBe("false");
    });

    it("raises the window rather than moving the call back", () => {
      startCall();
      expect(grid.raiseCallPopout()).toBe(false);
      popButton().click();
      expect(grid.raiseCallPopout()).toBe(true);
      expect(focusWindow).toHaveBeenCalledTimes(1);
      expect(popup.doc.body.contains(root())).toBe(true);
    });

    it("opens a tile's menu in the pop-out, without the profile card", async () => {
      grid.setCallbacks({
        callControls: controls(),
        tileMenu: { onProfile: vi.fn(), onMessage: vi.fn() },
      });
      grid.setExitVisible(true);
      grid.addStream(OTTO, "Otto", fakeStream(), makeTileConfig({ audioUserId: OTTO }));
      popButton().click();

      root()
        .querySelector(`.video-cell[data-user-id='${OTTO}']`)!
        .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
      await vi.dynamicImportSettled();

      const menu = popup.doc.querySelector<HTMLElement>(".video-tile-menu");
      expect(menu).not.toBeNull();
      expect(document.querySelector(".video-tile-menu")).toBeNull();
      expect(menu!.querySelector("[data-action='profile']")).toBeNull();
      expect(menu!.querySelector("[data-action='message']")).not.toBeNull();
    });

    it("follows full screen in the pop-out's own document and window", () => {
      const setWindowFullscreen = vi.fn(() => Promise.resolve());
      grid.setCallbacks({ callControls: controls(), setWindowFullscreen });
      grid.setExitVisible(true);
      grid.addStream(OTTO, "Otto", fakeStream(), makeTileConfig({ audioUserId: OTTO }));
      popButton().click();
      const label = String(open.mock.calls[0]![1]);
      const tile = root().querySelector(`.video-cell[data-user-id='${OTTO}']`)!;

      popup.enterFullscreen(tile);
      expect(setWindowFullscreen).toHaveBeenLastCalledWith(true, label);
      expect(tile.querySelector(".video-fs-calls")).not.toBeNull();

      // Closing the window ends its full screen; the app window's is untouched.
      popup.win.closed = true;
      vi.advanceTimersByTime(300);
      expect(tile.querySelector(".video-fs-calls")).toBeNull();
      expect(setWindowFullscreen).not.toHaveBeenCalledWith(false);
    });
  });
});
