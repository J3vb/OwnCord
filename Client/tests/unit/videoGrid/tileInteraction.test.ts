import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as mocks from "../../helpers/videoGridMocks";
import { type VideoGridComponent, type TileConfig } from "../../../src/components/VideoGrid";
import { fakeStream, useVideoGridHarness } from "../../helpers/videoGridHarness";

vi.mock("@lib/ui/toast", () => mocks.uiToastMock());
vi.mock("@lib/voice/livekitSession", () => mocks.voiceLivekitSessionMock());

const {
  mockMuteScreenshareAudio,
  mockSetScreenshareAudioVolume,
  mockSetUserVolume,
  mockGetScreenshareAudioMuted,
  mockGetScreenshareAudioVolume,
  mockGetUserLocalMute,
  mockSetUserLocalMute,
} = mocks;

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

  describe("tile interaction and labelling (PR 3)", () => {
    const SCREEN = 2 + 1_000_000;
    const screen = (overrides: Partial<TileConfig> = {}): TileConfig => ({
      isSelf: false,
      audioUserId: 2,
      isScreenshare: true,
      name: "Otto",
      ...overrides,
    });
    const camera = (overrides: Partial<TileConfig> = {}): TileConfig => ({
      isSelf: false,
      audioUserId: 3,
      isScreenshare: false,
      name: "Sam",
      ...overrides,
    });
    const cell = (id: number) =>
      container.querySelector<HTMLElement>(`.video-cell[data-user-id='${id}']`)!;
    const select = (id: number) => cell(id).querySelector<HTMLButtonElement>(".video-cell-select")!;

    it("makes each tile a named button that opens it in focus view", () => {
      grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screen());
      grid.addStream(3, "Sam", fakeStream(), camera());

      const btn = select(SCREEN);
      expect(btn.tagName).toBe("BUTTON");
      expect(btn.getAttribute("aria-label")).toBe("Watch Otto (Screen)");
      btn.click();

      expect(grid.getFocusedTileId()).toBe(SCREEN);
      expect(cell(SCREEN).classList.contains("focused")).toBe(true);
      // The focused tile needs no "watch" button; the filmstrip thumbs keep theirs.
      expect(select(SCREEN).hidden).toBe(true);
      expect(select(3).hidden).toBe(false);
      select(3).click();
      expect(grid.getFocusedTileId()).toBe(3);
    });

    it("offers Back to grid in focus view, which leaves it", () => {
      grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screen());
      grid.addStream(3, "Sam", fakeStream(), camera());
      expect(cell(SCREEN).querySelector<HTMLElement>("[data-tile-control='grid']")!.hidden).toBe(
        true,
      );

      select(SCREEN).click();
      const back = cell(SCREEN).querySelector<HTMLButtonElement>("[data-tile-control='grid']")!;
      expect(back.getAttribute("aria-label")).toBe("Back to grid");
      back.click();

      expect(grid.getFocusedTileId()).toBeNull();
      expect(container.querySelector(".video-grid.focus-mode")).toBeNull();
    });

    it("exposes a header control that leaves focus/grid mode and is keyboard reachable", () => {
      // Focus mode pinned a watched peer with no way back once the focused
      // tile's own nav was scrolled off (and an empty grid could cover chat
      // with no control at all). A header button always offers the exit.
      grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screen());
      grid.addStream(3, "Sam", fakeStream(), camera());

      const exit = container.querySelector<HTMLButtonElement>("[data-tile-control='exit-grid']");
      expect(exit).not.toBeNull();
      expect(exit!.tagName).toBe("BUTTON");
      expect(exit!.getAttribute("aria-label")).toBe("Show chat");

      select(SCREEN).click();
      expect(container.querySelector(".video-grid.focus-mode")).not.toBeNull();

      exit!.click();
      expect(grid.getFocusedTileId()).toBeNull();
      expect(container.querySelector(".video-grid.focus-mode")).toBeNull();
    });

    it("marks screen shares LIVE, and cameras not", () => {
      grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screen());
      grid.addStream(3, "Sam", fakeStream(), camera());
      expect(cell(SCREEN).querySelector(".video-live")!.textContent).toBe("LIVE");
      expect(cell(3).querySelector(".video-live")).toBeNull();
    });

    it("rings the camera tile of whoever is speaking, not their screen share", () => {
      grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screen());
      grid.addStream(2, "Otto", fakeStream(), camera({ audioUserId: 2, name: "Otto" }));

      grid.setSpeaking(new Set([2]));
      expect(cell(2).classList.contains("video-cell--speaking")).toBe(true);
      expect(cell(SCREEN).classList.contains("video-cell--speaking")).toBe(false);

      grid.setSpeaking(new Set());
      expect(cell(2).classList.contains("video-cell--speaking")).toBe(false);
    });

    describe("viewer badge", () => {
      const badge = (id: number) =>
        cell(id).querySelector<HTMLElement>("[data-testid='tile-viewers']");

      it("is hidden at zero viewers and absent from cameras", () => {
        grid.addStream(SCREEN, "Otto (Screen)", null, screen());
        grid.addStream(3, "Sam", fakeStream(), camera());
        // Stopped (not played here): no "You", and nobody else watching.
        grid.setStreamViewers(new Map());
        expect(badge(SCREEN)!.hidden).toBe(true);
        expect(badge(3)).toBeNull();
      });

      it("shows the count and lists the names on hover and to screen readers", () => {
        grid.addStream(SCREEN, "Otto (Screen)", null, screen());
        grid.setStreamViewers(new Map([[2, ["Ann", "Bob"]]]));
        const el = badge(SCREEN)!;
        expect(el.hidden).toBe(false);
        expect(el.querySelector(".video-viewers__count")!.textContent).toBe("2");
        expect(el.title).toBe("Watching: Ann, Bob");
        expect(el.getAttribute("aria-label")).toBe("Watching: Ann, Bob");
        expect(cell(SCREEN).classList.contains("video-cell--has-viewers")).toBe(true);
      });

      it("updates live and hides again when the viewers go", () => {
        grid.addStream(SCREEN, "Otto (Screen)", null, screen());
        grid.setStreamViewers(new Map([[2, ["Ann"]]]));
        grid.setStreamViewers(new Map([[2, ["Ann", "Bob", "Cy"]]]));
        expect(badge(SCREEN)!.querySelector(".video-viewers__count")!.textContent).toBe("3");
        grid.setStreamViewers(new Map());
        expect(badge(SCREEN)!.hidden).toBe(true);
        expect(cell(SCREEN).classList.contains("video-cell--has-viewers")).toBe(false);
      });

      it("adds You while the remote share plays here, and drops it when stopped", () => {
        grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screen());
        grid.setStreamViewers(new Map([[2, ["Ann"]]]));
        expect(badge(SCREEN)!.title).toBe("Watching: You, Ann");
        cell(SCREEN).querySelector<HTMLElement>("[data-tile-control='stop']")!.click();
        expect(badge(SCREEN)!.title).toBe("Watching: Ann");
      });

      it("shows on your own share tile without You", () => {
        grid.addStream(
          SCREEN,
          "Me (Screen)",
          fakeStream(),
          screen({ isSelf: true, audioUserId: 1, name: "Me" }),
        );
        grid.setStreamViewers(new Map([[1, ["Ann"]]]));
        expect(badge(SCREEN)!.title).toBe("Watching: Ann");
      });

      it("caps the list at ten names and counts the rest", () => {
        grid.addStream(SCREEN, "Otto (Screen)", null, screen());
        const names = Array.from({ length: 13 }, (_, i) => `U${String(i + 1)}`);
        grid.setStreamViewers(new Map([[2, names]]));
        expect(badge(SCREEN)!.querySelector(".video-viewers__count")!.textContent).toBe("13");
        expect(badge(SCREEN)!.title).toBe(
          "Watching: U1, U2, U3, U4, U5, U6, U7, U8, U9, U10 and 3 more",
        );
      });
    });

    it("marks a muted/deafened peer on their camera tile, and clears it", () => {
      grid.addStream(2, "Otto", fakeStream(), camera({ audioUserId: 2, name: "Otto" }));

      grid.setUserAudioState(new Map([[2, { muted: true, deafened: false }]]));
      const badge = cell(2).querySelector<HTMLElement>("[data-testid='tile-audio-state']")!;
      expect(badge).not.toBeNull();
      expect(badge.classList.contains("video-cell__audio--muted")).toBe(true);

      grid.setUserAudioState(new Map([[2, { muted: true, deafened: true }]]));
      expect(badge.classList.contains("video-cell__audio--deafened")).toBe(true);

      grid.setUserAudioState(new Map());
      expect(cell(2).querySelector("[data-testid='tile-audio-state']")).toBeNull();
    });

    it("names the volume slider for whose stream or voice it is, and shows its value", () => {
      mockGetScreenshareAudioVolume.mockReturnValueOnce(0.65);
      grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screen());
      grid.addStream(3, "Sam", fakeStream(), camera());

      const streamSlider = cell(SCREEN).querySelector<HTMLInputElement>(".tile-volume-slider")!;
      expect(streamSlider.getAttribute("aria-label")).toBe("Otto stream volume");
      expect(streamSlider.getAttribute("aria-valuetext")).toBe("65%");
      const out = cell(SCREEN).querySelector("output")!;
      expect(out.textContent).toBe("65%");

      streamSlider.value = "40";
      streamSlider.dispatchEvent(new Event("input"));
      expect(out.textContent).toBe("40%");
      expect(streamSlider.getAttribute("aria-valuetext")).toBe("40%");

      const voiceSlider = cell(3).querySelector<HTMLInputElement>(".tile-volume-slider")!;
      expect(voiceSlider.getAttribute("aria-label")).toBe("Sam voice volume");
    });

    it("opens a context menu that keeps the stream and voice volumes apart", async () => {
      grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screen());
      cell(SCREEN).dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 10,
          clientY: 20,
        }),
      );
      await vi.dynamicImportSettled();

      const menu = document.querySelector<HTMLElement>(".video-tile-menu")!;
      expect(menu).not.toBeNull();
      expect(menu.getAttribute("role")).toBe("menu");
      const stream = menu.querySelector<HTMLInputElement>("[data-menu-volume='stream']")!;
      const voice = menu.querySelector<HTMLInputElement>("[data-menu-volume='voice']")!;
      expect(stream.getAttribute("aria-label")).toBe("Otto stream volume");
      expect(stream.max).toBe("100");
      expect(voice.getAttribute("aria-label")).toBe("Otto voice volume");
      expect(voice.max).toBe("200");

      voice.value = "70";
      voice.dispatchEvent(new Event("input"));
      expect(mockSetUserVolume).toHaveBeenCalledWith(2, 70);
      stream.value = "30";
      stream.dispatchEvent(new Event("input"));
      expect(mockSetScreenshareAudioVolume).toHaveBeenCalledWith(2, 0.3);

      const labels = [...menu.querySelectorAll("[role='menuitem']")].map((m) => m.textContent);
      expect(labels).toEqual(expect.arrayContaining(["Mute stream", "Stop watching"]));
      menu.remove();
    });

    it("raising the menu's voice slider clears that user's Mute", async () => {
      mockGetUserLocalMute.mockReturnValue(true);
      grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screen());
      cell(SCREEN).dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
      );
      await vi.dynamicImportSettled();

      const menu = document.querySelector<HTMLElement>(".video-tile-menu")!;
      const voice = menu.querySelector<HTMLInputElement>("[data-menu-volume='voice']")!;
      voice.value = "120";
      voice.dispatchEvent(new Event("input"));

      expect(mockSetUserVolume).toHaveBeenCalledWith(2, 120);
      expect(mockSetUserLocalMute).toHaveBeenLastCalledWith(2, false);
      mockGetUserLocalMute.mockReturnValue(false);
      menu.remove();
    });

    it("Unmute stream in the menu brings a stream muted at 0 back at 100%", async () => {
      mockGetScreenshareAudioMuted.mockReturnValue(true);
      mockGetScreenshareAudioVolume.mockReturnValue(0);
      grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screen());
      cell(SCREEN).dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
      );
      await vi.dynamicImportSettled();

      const menu = document.querySelector<HTMLElement>(".video-tile-menu")!;
      const unmute = [...menu.querySelectorAll<HTMLElement>("[role='menuitem']")].find(
        (m) => m.textContent === "Unmute stream",
      )!;
      unmute.click();

      expect(mockSetScreenshareAudioVolume).toHaveBeenLastCalledWith(2, 1);
      expect(mockMuteScreenshareAudio).toHaveBeenLastCalledWith(2, false);
      expect(cell(SCREEN).querySelector("output")!.textContent).toBe("100%");
      expect(cell(SCREEN).querySelector(".video-tile-overlay")!.classList.contains("muted")).toBe(
        false,
      );
    });

    it("opens the same menu from the keyboard (Shift+F10) on the tile's button", async () => {
      grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screen());
      select(SCREEN).dispatchEvent(
        new KeyboardEvent("keydown", { key: "F10", shiftKey: true, bubbles: true }),
      );
      await vi.dynamicImportSettled();
      const menu = document.querySelector(".video-tile-menu");
      expect(menu).not.toBeNull();
      menu!.remove();
    });

    it("Stop watching hides the stream behind a Watch button, and Watch brings it back", () => {
      grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screen());
      const stop = cell(SCREEN).querySelector<HTMLButtonElement>("[data-tile-control='stop']")!;
      expect(stop.getAttribute("aria-label")).toBe("Stop watching");
      stop.click();

      expect(cell(SCREEN).classList.contains("video-cell--stopped")).toBe(true);
      expect(cell(SCREEN).querySelector("video")!.hidden).toBe(true);
      // Hidden locally only: the stream is still there.
      expect(grid.hasStreams()).toBe(true);

      const watch = cell(SCREEN).querySelector<HTMLButtonElement>("[data-tile-control='watch']")!;
      expect(watch.textContent).toBe("Watch stream");
      watch.click();
      expect(cell(SCREEN).classList.contains("video-cell--stopped")).toBe(false);
      expect(cell(SCREEN).querySelector("video")!.hidden).toBe(false);
    });

    it("covers your own screen share with what is going out, Stop sharing and Hide preview", () => {
      const onStopSharing = vi.fn();
      grid.setCallbacks({ onStopSharing });
      grid.addStream(1 + 1_000_000, "Your Screen", fakeStream(), {
        isSelf: true,
        audioUserId: 1,
        isScreenshare: true,
      });
      const self = cell(1 + 1_000_000);
      const cover = self.querySelector<HTMLElement>(".video-self-cover")!;
      expect(cover).not.toBeNull();
      expect(cover.textContent).toContain("You're sharing your screen");
      // No volume or stop-watching controls on your own preview.
      expect(self.querySelector(".tile-volume-slider")).toBeNull();

      cover.querySelector<HTMLButtonElement>("[data-tile-control='stop-sharing']")!.click();
      expect(onStopSharing).toHaveBeenCalledTimes(1);

      cover.querySelector<HTMLButtonElement>("[data-tile-control='hide-preview']")!.click();
      expect(self.classList.contains("video-cell--stopped")).toBe(true);
      const show = self.querySelector<HTMLButtonElement>("[data-tile-control='watch']")!;
      expect(show.textContent).toBe("Show preview");
    });

    it("says whether your screen share is sending audio", () => {
      const self = { isSelf: true, audioUserId: 1, isScreenshare: true };
      grid.addStream(1 + 1_000_000, "Your Screen", fakeStream(), { ...self, hasAudio: true });
      expect(cell(1 + 1_000_000).querySelector(".video-self-detail")!.textContent).toBe(
        "With audio",
      );
      grid.removeStream(1 + 1_000_000);
      grid.addStream(1 + 1_000_000, "Your Screen", fakeStream(), self);
      expect(cell(1 + 1_000_000).querySelector(".video-self-detail")!.textContent).toBe("No audio");
    });

    it("hands focus to Back to grid when a tile opens, and back to the tile after", () => {
      document.body.appendChild(container);
      grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screen());
      grid.addStream(3, "Sam", fakeStream(), camera());

      select(SCREEN).focus();
      select(SCREEN).click();
      const back = cell(SCREEN).querySelector<HTMLButtonElement>("[data-tile-control='grid']")!;
      expect(document.activeElement).toBe(back);

      back.click();
      expect(document.activeElement).toBe(select(SCREEN));
      container.remove();
    });

    it("Watch stream on a filmstrip thumb hands focus to the thumb, not its hidden controls", () => {
      document.body.appendChild(container);
      // The filmstrip's CSS hides a thumb's tile controls.
      const proto = HTMLElement.prototype as { checkVisibility?: () => boolean };
      proto.checkVisibility = function (this: HTMLElement) {
        return this.closest(".video-focus-strip .video-tile-nav") === null;
      };
      try {
        grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screen());
        grid.addStream(3, "Sam", fakeStream(), camera());
        cell(3).querySelector<HTMLButtonElement>("[data-tile-control='stop']")!.click();
        grid.setFocusedTile(SCREEN);

        cell(3).querySelector<HTMLButtonElement>("[data-tile-control='watch']")!.click();
        expect(document.activeElement).toBe(select(3));
      } finally {
        delete proto.checkVisibility;
        container.remove();
      }
    });

    it("removing a tile closes its menu and drops its menu listeners", async () => {
      grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screen());
      const removed = cell(SCREEN);
      removed.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
      await vi.dynamicImportSettled();
      expect(document.querySelector(".video-tile-menu")).not.toBeNull();

      grid.removeStream(SCREEN);
      expect(document.querySelector(".video-tile-menu")).toBeNull();

      removed.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
      removed
        .querySelector(".video-cell-select")!
        .dispatchEvent(new KeyboardEvent("keydown", { key: "F10", shiftKey: true, bubbles: true }));
      await vi.dynamicImportSettled();
      expect(document.querySelector(".video-tile-menu")).toBeNull();
    });

    it("opens no menu for a tile removed while the menu was loading", async () => {
      grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screen());
      cell(SCREEN).dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
      );
      grid.removeStream(SCREEN);
      await vi.dynamicImportSettled();
      expect(document.querySelector(".video-tile-menu")).toBeNull();
    });

    it("keeps the tile menu inside the window", async () => {
      const width = vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(200);
      const height = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(220);
      try {
        grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screen());
        cell(SCREEN).dispatchEvent(
          new MouseEvent("contextmenu", {
            bubbles: true,
            cancelable: true,
            clientX: window.innerWidth - 4,
            clientY: window.innerHeight - 4,
          }),
        );
        await vi.dynamicImportSettled();

        const menu = document.querySelector<HTMLElement>(".video-tile-menu")!;
        expect(menu.style.left).toBe(`${window.innerWidth - 200 - 8}px`);
        expect(menu.style.top).toBe(`${window.innerHeight - 220 - 8}px`);
        menu.remove();
      } finally {
        width.mockRestore();
        height.mockRestore();
      }
    });

    it("Show preview hands focus to Hide preview on your own screen share", () => {
      document.body.appendChild(container);
      grid.addStream(1 + 1_000_000, "Your Screen", fakeStream(), {
        isSelf: true,
        audioUserId: 1,
        isScreenshare: true,
      });
      const self = cell(1 + 1_000_000);
      self.querySelector<HTMLButtonElement>("[data-tile-control='hide-preview']")!.click();
      self.querySelector<HTMLButtonElement>("[data-tile-control='watch']")!.click();

      expect(document.activeElement).toBe(self.querySelector("[data-tile-control='hide-preview']"));
      container.remove();
    });

    it("keeps the person's other tile in step with a voice volume set from a tile menu", async () => {
      const otto = { audioUserId: 2, name: "Otto" };
      grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screen());
      grid.addStream(2, "Otto", fakeStream(), camera(otto));
      cell(SCREEN).dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
      );
      await vi.dynamicImportSettled();

      const menu = document.querySelector<HTMLElement>(".video-tile-menu")!;
      const voice = menu.querySelector<HTMLInputElement>("[data-menu-volume='voice']")!;
      voice.value = "70";
      voice.dispatchEvent(new Event("input"));

      expect(cell(2).querySelector("output")!.textContent).toBe("70%");
      // The screen-share tile's own slider is the stream volume, not the voice.
      expect(cell(SCREEN).querySelector("output")!.textContent).toBe("100%");
      // Mute then unmute on the camera tile keeps the 70, not a stale 100.
      const mute = cell(2).querySelector<HTMLButtonElement>(".tile-mute-btn")!;
      mute.click();
      mute.click();
      expect(mockSetUserVolume).toHaveBeenLastCalledWith(2, 70);
      menu.remove();
    });

    it("renames the tile's controls and menu with the person (setLabel)", async () => {
      grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screen());
      grid.setLabel(SCREEN, "Ottilie (Screen)", "Ottilie");

      expect(cell(SCREEN).querySelector(".video-username")!.textContent).toBe("Ottilie (Screen)");
      expect(select(SCREEN).getAttribute("aria-label")).toBe("Watch Ottilie (Screen)");
      expect(cell(SCREEN).querySelector(".tile-volume-slider")!.getAttribute("aria-label")).toBe(
        "Ottilie stream volume",
      );

      cell(SCREEN).dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
      );
      await vi.dynamicImportSettled();
      const menu = document.querySelector<HTMLElement>(".video-tile-menu")!;
      expect(menu.getAttribute("aria-label")).toBe("Ottilie");
      expect(menu.querySelector("[data-menu-volume='voice']")!.getAttribute("aria-label")).toBe(
        "Ottilie voice volume",
      );
      menu.remove();
    });
  });

  describe("opt-in watching (Discord-style)", () => {
    const SCREEN = 2 + 1_000_000;
    const screen: TileConfig = { isSelf: false, audioUserId: 2, isScreenshare: true, name: "Otto" };
    const cell = (id: number) =>
      container.querySelector<HTMLElement>(`.video-cell[data-user-id='${id}']`)!;
    const control = (id: number, name: string) =>
      cell(id).querySelector<HTMLButtonElement>(`[data-tile-control='${name}']`)!;
    let setStreamWatched: ReturnType<typeof vi.fn<(tileId: number, watched: boolean) => void>>;

    beforeEach(() => {
      document.body.appendChild(container);
      setStreamWatched = vi.fn();
      grid.setCallbacks({ setStreamWatched });
    });

    afterEach(() => {
      container.remove();
    });

    it("offers a published stream nobody watches as a tile with Watch stream, playing nothing", () => {
      const before = document.activeElement;
      grid.addStream(SCREEN, "Otto (Screen)", null, screen);

      expect(cell(SCREEN).classList.contains("video-cell--stopped")).toBe(true);
      const video = cell(SCREEN).querySelector("video")!;
      // jsdom's default is undefined, a browser's null: nothing either way.
      expect(video.srcObject ?? null).toBeNull();
      expect(video.hidden).toBe(true);
      expect(control(SCREEN, "watch").textContent).toBe("Watch stream");
      // A stream someone else started never takes your focus.
      expect(document.activeElement).toBe(before);
      expect(setStreamWatched).not.toHaveBeenCalled();
      expect(grid.hasStreams()).toBe(true);
    });

    it("Watch asks for the stream, and it plays once it arrives", () => {
      grid.addStream(SCREEN, "Otto (Screen)", null, screen);
      control(SCREEN, "watch").click();

      expect(setStreamWatched).toHaveBeenCalledWith(SCREEN, true);
      expect(cell(SCREEN).classList.contains("video-cell--stopped")).toBe(false);
      const stream = fakeStream();
      grid.addStream(SCREEN, "Otto (Screen)", stream, screen);
      expect(cell(SCREEN).querySelector("video")!.srcObject).toBe(stream);
      expect(cell(SCREEN).querySelectorAll(".video-cell")).toHaveLength(0);
      expect(container.querySelectorAll(".video-cell")).toHaveLength(1);
    });

    it("Stop watching stops the stream, and its unsubscribe leaves the tile on Watch", () => {
      grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screen);
      control(SCREEN, "stop").click();
      expect(setStreamWatched).toHaveBeenCalledWith(SCREEN, false);

      grid.addStream(SCREEN, "Otto (Screen)", null, screen);
      expect(cell(SCREEN).querySelector("video")!.srcObject).toBeNull();
      expect(cell(SCREEN).classList.contains("video-cell--stopped")).toBe(true);
      expect(control(SCREEN, "watch")).not.toBeNull();
    });

    it("a stream that arrives on a tile showing Watch plays: it is subscribed only when watched", () => {
      grid.addStream(SCREEN, "Otto (Screen)", null, screen);
      grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screen);
      expect(cell(SCREEN).classList.contains("video-cell--stopped")).toBe(false);
      expect(cell(SCREEN).querySelector("video")!.hidden).toBe(false);
    });

    it("an ended camera or a dropped roster watch is forgotten, not stopped", () => {
      const forgetStreamWatch = vi.fn();
      grid.setCallbacks({ setStreamWatched, forgetStreamWatch });
      const camera = { isSelf: false, audioUserId: 3, isScreenshare: false };
      grid.addStream(3, "Sam", fakeStream(), camera);
      grid.removeStream(3);
      expect(forgetStreamWatch).toHaveBeenCalledWith(3);

      grid.watch(4);
      grid.clearStreams();
      expect(forgetStreamWatch).toHaveBeenCalledWith(4);
      expect(setStreamWatched).not.toHaveBeenCalledWith(3, false);
      expect(setStreamWatched).not.toHaveBeenCalledWith(4, false);
    });

    it("a stream that ends stops its watch; your own preview is never one", () => {
      vi.useFakeTimers();
      try {
        grid.addStream(SCREEN, "Otto (Screen)", fakeStream(), screen);
        grid.removeStream(SCREEN);
        // Held while the tile says it ended, for a re-share (WP 1C-1).
        vi.advanceTimersByTime(3000);
        expect(setStreamWatched).toHaveBeenCalledWith(SCREEN, false);
      } finally {
        vi.useRealTimers();
      }

      setStreamWatched.mockClear();
      grid.addStream(1, "Me (You)", fakeStream(), {
        isSelf: true,
        audioUserId: 1,
        isScreenshare: false,
      });
      control(1, "hide-preview")?.click();
      grid.removeStream(1);
      expect(setStreamWatched).not.toHaveBeenCalled();
    });

    it("a roster watch that never got a stream does not unlock a later offered tile", () => {
      grid.watch(SCREEN);
      setStreamWatched.mockClear();
      grid.addStream(SCREEN, "Otto (Screen)", null, screen);
      expect(cell(SCREEN).classList.contains("video-cell--stopped")).toBe(true);
      expect(setStreamWatched).not.toHaveBeenCalled();
    });

    it("a used roster watch does not start a later stream of the same tile", () => {
      grid.watch(SCREEN);
      grid.addStream(SCREEN, "Otto (Screen)", null, screen);
      grid.removeStream(SCREEN);
      grid.addStream(SCREEN, "Otto (Screen)", null, screen);
      expect(cell(SCREEN).classList.contains("video-cell--stopped")).toBe(true);
    });

    it("clearStreams un-watches a roster watch that never got a tile", () => {
      grid.watch(SCREEN);
      setStreamWatched.mockClear();
      grid.clearStreams();
      expect(setStreamWatched).toHaveBeenCalledWith(SCREEN, false);
    });

    it("watch() on an offered tile watches it; a channel change drops a pending one", () => {
      grid.addStream(SCREEN, "Otto (Screen)", null, screen);
      grid.watch(SCREEN);
      expect(setStreamWatched).toHaveBeenCalledWith(SCREEN, true);
      expect(cell(SCREEN).classList.contains("video-cell--stopped")).toBe(false);

      grid.watch(3);
      grid.clearStreams();
      grid.addStream(3, "Sam", null, { isSelf: false, audioUserId: 3, isScreenshare: false });
      expect(cell(3).classList.contains("video-cell--stopped")).toBe(true);
    });
  });
});
