import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as mocks from "../../helpers/videoGridMocks";
import { cascadedDeclaration, keyword } from "../../helpers/app-css";
import { expectConsole } from "../../helpers/console";
import { type VideoGridComponent, type TileConfig } from "../../../src/components/VideoGrid";
import type { ShareSenderSample } from "../../../src/features/voice/shareSenderStats";
import { fakeStream, makeTileConfig, useVideoGridHarness } from "../../helpers/videoGridHarness";

vi.mock("@lib/ui/toast", () => mocks.uiToastMock());
vi.mock("@lib/voice/livekitSession", () => mocks.voiceLivekitSessionMock());

const { mockShowToast } = mocks;

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

  describe("full screen, pop-out and stream info (PR 4)", () => {
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

    let fullscreenElement: Element | null = null;
    let requestFullscreen: ReturnType<typeof vi.fn>;
    let exitFullscreen: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      // Attached, as in the app: the theatre view's keys are document-level.
      document.body.appendChild(container);
      fullscreenElement = null;
      const enter = (el: Element): void => {
        fullscreenElement = el;
      };
      requestFullscreen = vi.fn(function (this: Element) {
        enter(this);
        document.dispatchEvent(new Event("fullscreenchange"));
        return Promise.resolve();
      });
      exitFullscreen = vi.fn(() => {
        fullscreenElement = null;
        document.dispatchEvent(new Event("fullscreenchange"));
        return Promise.resolve();
      });
      Object.defineProperty(document, "fullscreenElement", {
        configurable: true,
        get: () => fullscreenElement,
      });
      Object.defineProperty(document, "exitFullscreen", {
        configurable: true,
        value: exitFullscreen,
      });
      Object.defineProperty(HTMLElement.prototype, "requestFullscreen", {
        configurable: true,
        value: requestFullscreen,
      });
    });

    afterEach(() => {
      container.remove();
      delete (HTMLElement.prototype as { requestFullscreen?: unknown }).requestFullscreen;
      delete (document as { exitFullscreen?: unknown }).exitFullscreen;
      delete (document as { fullscreenElement?: unknown }).fullscreenElement;
      vi.useRealTimers();
    });

    it("puts the tile in full screen and back, and keeps the window full screen with it", async () => {
      const setWindowFullscreen = vi.fn().mockResolvedValue(undefined);
      grid.setCallbacks({ setWindowFullscreen });
      grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screenCfg);

      const fs = control(SCREEN, "fullscreen");
      expect(fs.getAttribute("aria-label")).toBe("Full screen");
      fs.click();
      await Promise.resolve();

      expect(requestFullscreen).toHaveBeenCalledTimes(1);
      expect(requestFullscreen.mock.contexts[0]).toBe(cell(SCREEN));
      expect(control(SCREEN, "fullscreen").getAttribute("aria-label")).toBe("Exit full screen");
      expect(setWindowFullscreen).toHaveBeenLastCalledWith(true);

      control(SCREEN, "fullscreen").click();
      await Promise.resolve();
      expect(exitFullscreen).toHaveBeenCalledTimes(1);
      expect(control(SCREEN, "fullscreen").getAttribute("aria-label")).toBe("Full screen");
      expect(setWindowFullscreen).toHaveBeenLastCalledWith(false);
    });

    it("toggles full screen with F from inside the tile, and with a double-click", async () => {
      grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screenCfg);
      control(SCREEN, "select").dispatchEvent(
        new KeyboardEvent("keydown", { key: "f", bubbles: true }),
      );
      await Promise.resolve();
      expect(requestFullscreen).toHaveBeenCalledTimes(1);

      cell(SCREEN).dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
      await Promise.resolve();
      expect(exitFullscreen).toHaveBeenCalledTimes(1);
    });

    it("falls back to a window-filling theatre view when the full-screen API is refused", async () => {
      requestFullscreen.mockImplementation(() => Promise.reject(new Error("denied")));
      const setWindowFullscreen = vi.fn().mockResolvedValue(undefined);
      grid.setCallbacks({ setWindowFullscreen });
      grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screenCfg);

      control(SCREEN, "fullscreen").click();
      await vi.waitFor(() =>
        expect(cell(SCREEN).classList.contains("video-cell--theatre")).toBe(true),
      );
      expect(setWindowFullscreen).toHaveBeenLastCalledWith(true);

      cell(SCREEN).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      expect(cell(SCREEN).classList.contains("video-cell--theatre")).toBe(false);
      expect(setWindowFullscreen).toHaveBeenLastCalledWith(false);
    });

    it("leaves the theatre view with Escape or F after focus has left the tile", async () => {
      requestFullscreen.mockImplementation(() => Promise.reject(new Error("denied")));
      grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screenCfg);
      const root = container.querySelector<HTMLElement>("[data-testid='video-grid']")!;

      for (const key of ["Escape", "f"]) {
        control(SCREEN, "fullscreen").click();
        await vi.waitFor(() =>
          expect(cell(SCREEN).classList.contains("video-cell--theatre")).toBe(true),
        );
        // A click on the video moves focus to the grid, outside the tile.
        root.focus();
        root.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
        expect(cell(SCREEN).classList.contains("video-cell--theatre")).toBe(false);
      }
    });

    it("keeps the call controls at hand in full screen", async () => {
      const onMuteToggle = vi.fn();
      const onLeave = vi.fn();
      grid.setCallbacks({ callControls: { onMuteToggle, onDeafenToggle: vi.fn(), onLeave } });
      grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screenCfg);
      control(SCREEN, "fullscreen").click();
      await Promise.resolve();

      const calls = cell(SCREEN).querySelector<HTMLElement>(".video-fs-calls")!;
      expect(calls).not.toBeNull();
      const mute = calls.querySelector<HTMLButtonElement>("[data-call-control='mute']")!;
      mute.click();
      expect(onMuteToggle).toHaveBeenCalledTimes(1);
      grid.setCallState({ muted: true, deafened: false, listenOnly: false });
      expect(mute.getAttribute("aria-pressed")).toBe("true");
      // Listen-only: no mic to mute, so the control reads mic-off and is inert.
      grid.setCallState({ muted: false, deafened: false, listenOnly: true });
      expect(mute.querySelector("svg")!.getAttribute("data-icon")).toBe("mic-off");
      expect(mute.disabled).toBe(true);
      expect(mute.title).toBe("Listening only — no microphone access");
      expect(keyword(cascadedDeclaration(".video-fs-btn:disabled", "opacity"))).toBe("0.5");
      grid.setCallState({ muted: false, deafened: false, listenOnly: false });
      expect(mute.disabled).toBe(false);
      expect(mute.querySelector("svg")!.getAttribute("data-icon")).toBe("mic");
      calls.querySelector<HTMLButtonElement>("[data-call-control='leave']")!.click();
      expect(onLeave).toHaveBeenCalledTimes(1);

      control(SCREEN, "fullscreen").click();
      await Promise.resolve();
      expect(cell(SCREEN).querySelector(".video-fs-calls")).toBeNull();
    });

    /** Nodes taken out of the tree since `observer` started: removing a
     *  full-screen element (or an ancestor) ends full screen in a browser. */
    const removedNodes = (observer: MutationObserver): Node[] =>
      observer.takeRecords().flatMap((r) => [...r.removedNodes]);

    it("never takes a full-screen tile out of the page while others come and go", async () => {
      grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screenCfg);
      grid.addStream(7, "Ada", fakeStream(), makeTileConfig({ audioUserId: 7 }));
      control(SCREEN, "fullscreen").click();
      await Promise.resolve();
      const fsCell = cell(SCREEN);
      expect(fullscreenElement).toBe(fsCell);
      expect(grid.getFocusedTileId()).toBe(SCREEN);
      expect(control(SCREEN, "select").hidden).toBe(true);

      const observer = new MutationObserver(() => {});
      observer.observe(container, { childList: true, subtree: true });
      grid.addStream(8, "Bea", fakeStream(), makeTileConfig({ audioUserId: 8 }));
      grid.setPeople([{ userId: 9, label: "Cy", content: document.createElement("div") }]);
      grid.removeStream(7);
      grid.setFocusedTile(SCREEN);
      // The first click of a double-click lands on the video, not a focus swap.
      fsCell.querySelector("video")!.click();

      expect(removedNodes(observer).some((n) => n.contains(fsCell))).toBe(false);
      observer.disconnect();
      expect(grid.getFocusedTileId()).toBe(SCREEN);
      expect(exitFullscreen).not.toHaveBeenCalled();
    });

    it("leaves full screen when Back to grid moves focus off the tile", async () => {
      const setWindowFullscreen = vi.fn().mockResolvedValue(undefined);
      grid.setCallbacks({ setWindowFullscreen });
      grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screenCfg);
      control(SCREEN, "fullscreen").click();
      await Promise.resolve();

      control(SCREEN, "grid").click();
      await Promise.resolve();

      expect(exitFullscreen).toHaveBeenCalledTimes(1);
      expect(grid.getFocusedTileId()).toBeNull();
      expect(setWindowFullscreen).toHaveBeenLastCalledWith(false);
    });

    it("takes the window out of full screen when the grid goes away mid-stream", async () => {
      const setWindowFullscreen = vi.fn().mockResolvedValue(undefined);
      grid.setCallbacks({ setWindowFullscreen });
      grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screenCfg);
      control(SCREEN, "fullscreen").click();
      await Promise.resolve();
      setWindowFullscreen.mockClear();

      grid.destroy?.();

      expect(exitFullscreen).toHaveBeenCalledTimes(1);
      expect(setWindowFullscreen).toHaveBeenCalledWith(false);
    });

    it("takes the window out of the theatre view when the grid goes away", async () => {
      requestFullscreen.mockImplementation(() => Promise.reject(new Error("denied")));
      const setWindowFullscreen = vi.fn().mockResolvedValue(undefined);
      grid.setCallbacks({ setWindowFullscreen });
      grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screenCfg);
      control(SCREEN, "fullscreen").click();
      await vi.waitFor(() => expect(setWindowFullscreen).toHaveBeenLastCalledWith(true));

      grid.destroy?.();

      expect(setWindowFullscreen).toHaveBeenLastCalledWith(false);
    });

    it("opens the tile menu inside the full-screen tile, where it can be seen", async () => {
      document.body.appendChild(container);
      grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screenCfg);
      control(SCREEN, "fullscreen").click();
      await Promise.resolve();

      cell(SCREEN).dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, clientX: 10, clientY: 10 }),
      );

      await vi.waitFor(() => expect(document.querySelector(".video-tile-menu")).not.toBeNull());
      expect(cell(SCREEN).contains(document.querySelector(".video-tile-menu"))).toBe(true);
      container.remove();
    });

    it("shows the frame rate your screen share achieves, not the one it asked for", async () => {
      vi.useFakeTimers();
      try {
        const track = {
          id: "t",
          kind: "video",
          muted: false,
          getSettings: () => ({ height: 1080, frameRate: 120 }),
          addEventListener: () => {},
          removeEventListener: () => {},
        };
        const stream = {
          getTracks: () => [track],
          getVideoTracks: () => [track],
          getAudioTracks: () => [],
        } as unknown as MediaStream;
        const getLocalShareStats = vi.fn(async (): Promise<ShareSenderSample | null> => ({}));
        grid.setCallbacks({ getLocalShareStats });
        grid.addStream(1 + 1_000_000, "Your Screen", stream, {
          isSelf: true,
          audioUserId: 1,
          isScreenshare: true,
        });
        const detail = () => cell(1 + 1_000_000).querySelector(".video-self-detail")!.textContent;
        const sender = () => cell(1 + 1_000_000).querySelector<HTMLElement>(".video-self-stats")!;
        // 1080p, not 1,080p; and never the requested 120 before a measurement.
        expect(detail()).toBe("1080p · No audio");
        expect(sender().hidden).toBe(true);

        getLocalShareStats.mockResolvedValue({ sentFps: 58.4 });
        await vi.advanceTimersByTimeAsync(2000);
        expect(detail()).toBe("1080p · 58 fps · No audio");
        expect(sender().hidden).toBe(true);

        // M-1: why the share sends what it does.
        getLocalShareStats.mockResolvedValue({
          sentFps: 61,
          captureFps: 120,
          limitation: "cpu",
          codec: "video/VP8",
          encoder: "libvpx",
        });
        await vi.advanceTimersByTimeAsync(2000);
        expect(detail()).toBe("1080p · 61 fps · No audio");
        expect(sender().hidden).toBe(false);
        expect(sender().textContent).toBe("Capture 120 fps · Limited by CPU · VP8 · libvpx");

        // Each simulcast layer gets its own line in the tooltip.
        getLocalShareStats.mockResolvedValue({
          sentFps: 24,
          captureFps: 60,
          captureFpsSource: "configured",
          layers: [
            { active: true, height: 1080, sentFps: 24 },
            { active: false, height: 720 },
          ],
        });
        await vi.advanceTimersByTimeAsync(2000);
        expect(sender().textContent).toBe("Capture set to 60 fps");
        expect(sender().title).toBe("1080p · 24 fps\n720p paused");

        getLocalShareStats.mockResolvedValue({ sentFps: 117, limitation: "none" });
        await vi.advanceTimersByTimeAsync(2000);
        expect(sender().title).toBe("");
        expect(detail()).toBe("1080p · 117 fps · No audio");
        expect(sender().textContent).toBe("Not limited");

        // A share with no sender stats (the Linux native share) says so.
        getLocalShareStats.mockResolvedValue(null);
        await vi.advanceTimersByTimeAsync(2000);
        expect(detail()).toBe("1080p · No audio");
        expect(sender().textContent).toBe("Encoder details not available");

        // The poll goes with the tile.
        grid.removeStream(1 + 1_000_000);
        const calls = getLocalShareStats.mock.calls.length;
        await vi.advanceTimersByTimeAsync(6000);
        expect(getLocalShareStats).toHaveBeenCalledTimes(calls);
      } finally {
        vi.useRealTimers();
      }
    });

    it("leaves the video in its tile when no pop-out window opens", () => {
      vi.stubGlobal("open", () => null);
      try {
        grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screenCfg);
        control(SCREEN, "pip").click();
        expectConsole("warn", "Pop out window refused");
        expect(mockShowToast).toHaveBeenCalledWith("Couldn't open the pop-out window", "error");
        expect(cell(SCREEN).querySelector("video")).not.toBeNull();
        expect(cell(SCREEN).querySelector(".video-popped")).toBeNull();
        expect(control(SCREEN, "pip").getAttribute("aria-pressed")).toBe("false");
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it("shows resolution and frame rate on the focused stream, with a stats popover", async () => {
      // Focus needs a connected tree.
      document.body.appendChild(container);
      vi.useFakeTimers();
      let frames = 0;
      let ts = 0;
      const getStreamStats = vi.fn(async () => {
        const sample = {
          frameWidth: 1920,
          frameHeight: 1080,
          framesDecoded: frames,
          timestamp: ts,
          bitrate: 5_800_000,
          codec: "video/VP8",
          packetsLost: 1,
          packetsReceived: 999,
        };
        frames += 60;
        ts += 2000;
        return sample;
      });
      grid.setCallbacks({ getStreamStats });
      grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screenCfg);
      expect(getStreamStats).not.toHaveBeenCalled();

      grid.setFocusedTile(SCREEN);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(2000);
      expect(getStreamStats).toHaveBeenCalledWith(SCREEN);

      const chip = cell(SCREEN).querySelector<HTMLButtonElement>(".video-quality")!;
      expect(chip.textContent).toBe("1080p · 30 fps");
      expect(chip.getAttribute("aria-label")).toBe("Stream info: 1080p, 30 frames per second");
      expect(chip.getAttribute("aria-expanded")).toBe("false");

      chip.click();
      const pop = cell(SCREEN).querySelector<HTMLElement>(".video-stats")!;
      expect(pop.getAttribute("role")).toBe("dialog");
      expect(chip.getAttribute("aria-expanded")).toBe("true");
      const text = pop.textContent ?? "";
      for (const part of ["1920×1080", "30 fps", "5.8 Mbps", "VP8", "0.1 %"]) {
        expect(text).toContain(part);
      }
      pop.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      expect(cell(SCREEN).querySelector(".video-stats")).toBeNull();
      expect(document.activeElement).toBe(chip);

      // Leaving focus view stops polling.
      grid.setFocusedTile(null);
      const calls = getStreamStats.mock.calls.length;
      await vi.advanceTimersByTimeAsync(6000);
      expect(getStreamStats.mock.calls.length).toBe(calls);
      container.remove();
    });

    it("gives a camera tile no quality chip and polls no stats for it, even focused", async () => {
      document.body.appendChild(container);
      vi.useFakeTimers();
      const getStreamStats = vi.fn(async () => null);
      grid.setCallbacks({ getStreamStats });
      grid.addStream(2, "Otto", fakeStream(), {
        isSelf: false,
        audioUserId: 2,
        isScreenshare: false,
      });
      grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screenCfg);

      expect(cell(2).querySelector(".video-quality")).toBeNull();
      expect(cell(SCREEN).querySelector(".video-quality")).not.toBeNull();

      grid.setFocusedTile(2);
      await vi.advanceTimersByTimeAsync(4000);
      expect(getStreamStats).not.toHaveBeenCalled();
      container.remove();
    });
  });

  describe("mini-player", () => {
    const mini = (): HTMLElement | null =>
      document.querySelector<HTMLElement>("[data-testid='stream-mini-player']");
    /** The mini-player module loads on first use. */
    const opened = (): Promise<void> => vi.waitFor(() => expect(mini()).not.toBeNull());

    afterEach(() => {
      grid.hideMiniPlayer();
    });

    it("takes the focused remote stream's video along, and gives it back", async () => {
      grid.addStream(7, "Otto", fakeStream(), makeTileConfig({ audioUserId: 7, name: "Otto" }));
      grid.setFocusedTile(7);
      const video = container.querySelector(".video-cell[data-user-id='7'] video")!;

      grid.showMiniPlayer();
      await opened();

      expect(mini()!.contains(video)).toBe(true);
      expect(mini()!.textContent).toContain("Otto");
      grid.hideMiniPlayer();
      expect(mini()).toBeNull();
      expect(container.querySelector(".video-cell[data-user-id='7']")!.contains(video)).toBe(true);
    });

    it("opens nothing for your own preview or an unwatched stream", async () => {
      grid.addStream(1, "You", fakeStream(), makeTileConfig({ isSelf: true, audioUserId: 1 }));
      grid.addStream(7, "Otto", null, makeTileConfig({ audioUserId: 7 }));

      grid.showMiniPlayer();
      await new Promise((r) => setTimeout(r, 20));

      expect(mini()).toBeNull();
    });

    it("a hide before it has loaded cancels it", async () => {
      grid.addStream(7, "Otto", fakeStream(), makeTileConfig({ audioUserId: 7 }));

      grid.showMiniPlayer();
      grid.hideMiniPlayer();
      await new Promise((r) => setTimeout(r, 20));

      expect(mini()).toBeNull();
    });

    it("closes when the stream ends", async () => {
      grid.addStream(7, "Otto", fakeStream(), makeTileConfig({ audioUserId: 7 }));
      grid.showMiniPlayer();
      await opened();

      grid.removeStream(7);

      expect(mini()).toBeNull();
    });

    it("Return asks the host for the full view of that stream", async () => {
      const onReturnToStream = vi.fn();
      grid.setCallbacks({ onReturnToStream });
      grid.addStream(7, "Otto", fakeStream(), makeTileConfig({ audioUserId: 7 }));
      grid.showMiniPlayer();
      await opened();

      mini()!.querySelector<HTMLButtonElement>("[data-testid='stream-mini-return']")!.click();

      expect(onReturnToStream).toHaveBeenCalledWith(7);
    });

    it("stops the stream's video while the app is hidden, and resumes it when shown", async () => {
      const setStreamView = vi.fn();
      let hidden = false;
      Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
      try {
        grid.setCallbacks({ setStreamView });
        grid.addStream(7, "Otto", fakeStream(), makeTileConfig({ audioUserId: 7 }));
        grid.showMiniPlayer();
        await opened();

        hidden = true;
        document.dispatchEvent(new Event("visibilitychange"));
        expect(setStreamView).toHaveBeenLastCalledWith(7, { enabled: false });

        hidden = false;
        document.dispatchEvent(new Event("visibilitychange"));
        expect(setStreamView).toHaveBeenLastCalledWith(
          7,
          expect.objectContaining({ enabled: true }),
        );
      } finally {
        delete (document as { hidden?: boolean }).hidden;
      }
    });

    it("moves focus off the closing mini-player, but not when focus was elsewhere", async () => {
      const focusFallback = vi.fn();
      grid.setCallbacks({ focusFallback });
      grid.addStream(7, "Otto", fakeStream(), makeTileConfig({ audioUserId: 7 }));
      grid.showMiniPlayer();
      await opened();

      mini()!.focus();
      grid.hideMiniPlayer();
      expect(focusFallback).toHaveBeenCalledTimes(1);

      grid.showMiniPlayer();
      await opened();
      grid.hideMiniPlayer();
      expect(focusFallback).toHaveBeenCalledTimes(1);
    });

    it("Return from the keyboard lands focus in the grid, not on the page", async () => {
      const focusFallback = vi.fn();
      document.body.appendChild(container);
      grid.setCallbacks({ focusFallback, onReturnToStream: () => grid.hideMiniPlayer() });
      grid.addStream(7, "Otto", fakeStream(), makeTileConfig({ audioUserId: 7 }));
      grid.showMiniPlayer();
      await opened();

      const btn = mini()!.querySelector<HTMLButtonElement>("[data-testid='stream-mini-return']")!;
      btn.focus();
      btn.click();

      expect(container.contains(document.activeElement)).toBe(true);
    });
  });
});
