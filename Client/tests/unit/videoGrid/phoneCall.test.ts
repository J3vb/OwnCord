import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as mocks from "../../helpers/videoGridMocks";
import { type VideoGridComponent, type TileConfig } from "../../../src/components/VideoGrid";
import {
  fakeStream,
  installFullscreenApi,
  useVideoGridHarness,
  type FullscreenApi,
} from "../../helpers/videoGridHarness";
import { clearHost, hostAndroidApp, hostDesktopApp } from "../../helpers/androidHost";

vi.mock("@lib/ui/toast", () => mocks.uiToastMock());
vi.mock("@lib/voice/livekitSession", () => mocks.voiceLivekitSessionMock());

// The shared Back history, replaced by a stub that records the claims.
const backClaims = vi.hoisted(() => ({
  onBack: [] as Array<() => void>,
  released: 0,
}));
vi.mock("../../../src/lib/ui/backHistory", () => ({
  claimBack: (onBack: () => void) => {
    backClaims.onBack.push(onBack);
    return {
      release: () => {
        backClaims.released += 1;
      },
    };
  },
}));

function usePhone(on: boolean): void {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((q: string) => ({ matches: on && q.includes("pointer: coarse") })),
  );
}

const SHARE = 2 + 1_000_000;
const shareCfg: TileConfig = { isSelf: false, audioUserId: 2, isScreenshare: true, name: "Otto" };
const camCfg: TileConfig = { isSelf: false, audioUserId: 3, isScreenshare: false, name: "Sam" };

describe("VideoGrid on a phone", () => {
  let container: HTMLDivElement;
  let grid: VideoGridComponent;

  useVideoGridHarness((c, g) => {
    container = c;
    grid = g;
  });

  const cell = (id: number) =>
    container.querySelector<HTMLElement>(`.video-cell[data-user-id='${id}']`)!;
  const callBar = () => container.querySelector<HTMLElement>(":scope .video-grid__controls")!;
  const callControls = (el: ParentNode): (string | undefined)[] =>
    [...el.querySelectorAll<HTMLElement>("[data-call-control]")].map(
      (b) => b.dataset["callControl"],
    );

  beforeEach(() => {
    localStorage.clear();
    backClaims.onBack.length = 0;
    backClaims.released = 0;
    document.body.appendChild(container);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    container.remove();
  });

  describe("the call controls", () => {
    function setup(onExitGrid: (() => void) | undefined) {
      const callbacks = {
        onMuteToggle: vi.fn(),
        onDeafenToggle: vi.fn(),
        onLeave: vi.fn(),
        onCameraToggle: vi.fn(),
      };
      grid.setCallbacks({
        callControls: callbacks,
        ...(onExitGrid === undefined ? {} : { onExitGrid }),
      });
      grid.setExitVisible(true);
      return callbacks;
    }

    it("holds mic, deafen, camera, chat and a Leave, with no share button", () => {
      usePhone(true);
      setup(vi.fn());
      expect(callControls(callBar())).toEqual(["mute", "deafen", "camera", "chat", "leave"]);
      expect(callBar().querySelector("[data-call-control='share']")).toBeNull();
    });

    it("Chat goes back to the text channel and Leave ends the call", () => {
      usePhone(true);
      const onExitGrid = vi.fn();
      const callbacks = setup(onExitGrid);

      callBar().querySelector<HTMLButtonElement>("[data-call-control='chat']")!.click();
      expect(onExitGrid).toHaveBeenCalledTimes(1);
      expect(callbacks.onLeave).not.toHaveBeenCalled();

      callBar().querySelector<HTMLButtonElement>("[data-call-control='leave']")!.click();
      expect(callbacks.onLeave).toHaveBeenCalledTimes(1);
      expect(onExitGrid).toHaveBeenCalledTimes(1);
    });

    it("has no Chat control where the host cannot go back to the chat", () => {
      usePhone(true);
      setup(undefined);
      expect(callControls(callBar())).not.toContain("chat");
    });

    it("keeps Chat out of a full-screen tile's own controls", async () => {
      usePhone(true);
      setup(vi.fn());
      grid.addStream(SHARE, "Otto (Screen)", fakeStream(), shareCfg);
      // The theatre fallback: no full-screen API in jsdom.
      cell(SHARE).querySelector<HTMLButtonElement>("[data-tile-control='fullscreen']")!.click();
      await vi.waitFor(() => expect(cell(SHARE).querySelector(".video-fs-calls")).not.toBeNull());
      expect(callControls(cell(SHARE).querySelector(".video-fs-calls")!)).not.toContain("chat");
    });
  });

  describe("the talk button", () => {
    afterEach(() => clearHost());

    it("the Android app's call view and a full-screen tile's controls each hold one", async () => {
      hostAndroidApp();
      usePhone(true);
      grid.setCallbacks({
        callControls: { onMuteToggle: vi.fn(), onDeafenToggle: vi.fn(), onLeave: vi.fn() },
        onExitGrid: vi.fn(),
      });
      grid.setExitVisible(true);
      await vi.waitFor(() =>
        expect(callBar().querySelector("[data-testid='talk-button-call']")).not.toBeNull(),
      );
      expect(callBar().firstElementChild?.getAttribute("data-testid")).toBe("talk-button-call");

      grid.addStream(SHARE, "Otto (Screen)", fakeStream(), shareCfg);
      cell(SHARE).querySelector<HTMLButtonElement>("[data-tile-control='fullscreen']")!.click();
      await vi.waitFor(() =>
        expect(
          cell(SHARE).querySelector(".video-fs-calls [data-testid='talk-button-call']"),
        ).not.toBeNull(),
      );
    });

    it("is left out off the Android app", async () => {
      hostDesktopApp();
      usePhone(true);
      grid.setCallbacks({
        callControls: { onMuteToggle: vi.fn(), onDeafenToggle: vi.fn(), onLeave: vi.fn() },
      });
      grid.setExitVisible(true);
      await new Promise((r) => setTimeout(r, 0));
      expect(callBar().querySelector("[data-testid='talk-button-call']")).toBeNull();
    });
  });

  describe("tap to focus", () => {
    beforeEach(() => {
      grid.addStream(SHARE, "Otto (Screen)", fakeStream(), shareCfg);
      grid.addStream(3, "Sam", fakeStream(), camCfg);
    });

    const tap = (id: number): void => {
      cell(id).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    };

    it("a tap on a tile focuses it, and a second tap on it gives the focus back", () => {
      usePhone(true);
      cell(3).querySelector<HTMLButtonElement>(".video-cell-select")!.click();
      expect(grid.getFocusedTileId()).toBe(3);

      tap(3);
      expect(grid.getFocusedTileId()).toBeNull();
    });

    it("a tap on a strip tile moves the focus to it instead", () => {
      usePhone(true);
      grid.setFocusedTile(3);
      tap(SHARE);
      expect(grid.getFocusedTileId()).toBe(SHARE);
    });

    it("a tap on a tile's own button does not unfocus", () => {
      usePhone(true);
      grid.setFocusedTile(3);
      cell(3).querySelector<HTMLButtonElement>(".tile-mute-btn")!.click();
      expect(grid.getFocusedTileId()).toBe(3);
    });

    it("an open tile menu takes the tap", () => {
      usePhone(true);
      grid.setFocusedTile(3);
      const menu = document.createElement("div");
      menu.className = "video-tile-menu";
      document.body.appendChild(menu);
      tap(3);
      menu.remove();
      expect(grid.getFocusedTileId()).toBe(3);
    });

    it("a pinch-zoomed picture takes the tap", () => {
      usePhone(true);
      grid.setFocusedTile(3);
      cell(3).classList.add("video-zoomed");
      tap(3);
      expect(grid.getFocusedTileId()).toBe(3);
    });

    it("off a phone a click on the focused tile leaves the focus alone", () => {
      usePhone(false);
      grid.setFocusedTile(3);
      tap(3);
      expect(grid.getFocusedTileId()).toBe(3);
    });
  });

  describe("full screen", () => {
    let fsApi: FullscreenApi;
    let lock: ReturnType<typeof vi.fn>;
    let unlock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      fsApi = installFullscreenApi();
      lock = vi.fn().mockResolvedValue(undefined);
      unlock = vi.fn();
      vi.stubGlobal("screen", { orientation: { lock, unlock } });
      grid.addStream(SHARE, "Otto (Screen)", fakeStream(), shareCfg);
    });

    afterEach(() => {
      fsApi.restore();
    });

    const fsButton = (): HTMLButtonElement =>
      cell(SHARE).querySelector<HTMLButtonElement>("[data-tile-control='fullscreen']")!;

    it("the focused tile's button goes full screen in landscape, and Back leaves", async () => {
      usePhone(true);
      grid.setFocusedTile(SHARE);
      fsButton().click();
      await vi.waitFor(() => expect(lock).toHaveBeenCalledWith("landscape"));
      expect(fsApi.requestFullscreen).toHaveBeenCalledTimes(1);
      expect(backClaims.onBack).toHaveLength(1);

      // Back: the claim hands over to leave full screen, and the screen turns free.
      backClaims.onBack[0]!();
      await vi.waitFor(() => expect(fsApi.fullscreenElement).toBeNull());
      expect(unlock).toHaveBeenCalledTimes(1);
      expect(fsButton().getAttribute("aria-label")).toBe("Full screen");
    });

    it("the button leaves full screen too, and gives Back and the rotation up", async () => {
      usePhone(true);
      fsButton().click();
      await vi.waitFor(() => expect(lock).toHaveBeenCalled());
      fsButton().click();
      await vi.waitFor(() => expect(fsApi.fullscreenElement).toBeNull());
      expect(backClaims.released).toBe(1);
      expect(unlock).toHaveBeenCalledTimes(1);
    });

    it("stays put when the orientation lock is refused", async () => {
      usePhone(true);
      lock.mockRejectedValue(new DOMException("not allowed", "NotSupportedError"));
      fsButton().click();
      await vi.waitFor(() => expect(lock).toHaveBeenCalled());
      await Promise.resolve();
      expect(fsApi.fullscreenElement).toBe(cell(SHARE));
      fsButton().click();
      await vi.waitFor(() => expect(fsApi.fullscreenElement).toBeNull());
      // Nothing was locked, so nothing is unlocked.
      expect(unlock).not.toHaveBeenCalled();
    });

    it("falls back to the window-filling view when requestFullscreen is refused", async () => {
      usePhone(true);
      fsApi.requestFullscreen.mockImplementation(() => Promise.reject(new Error("denied")));
      fsButton().click();
      await vi.waitFor(() =>
        expect(cell(SHARE).classList.contains("video-cell--theatre")).toBe(true),
      );
      // Back leaves the fallback view too.
      expect(backClaims.onBack).toHaveLength(1);
      backClaims.onBack[0]!();
      expect(cell(SHARE).classList.contains("video-cell--theatre")).toBe(false);
    });

    it("needs no orientation API at all", async () => {
      usePhone(true);
      vi.stubGlobal("screen", {});
      fsButton().click();
      await vi.waitFor(() => expect(fsApi.fullscreenElement).toBe(cell(SHARE)));
      fsButton().click();
      await vi.waitFor(() => expect(fsApi.fullscreenElement).toBeNull());
    });

    it("off a phone it claims neither Back nor the orientation", async () => {
      usePhone(false);
      fsButton().click();
      await vi.waitFor(() => expect(fsApi.fullscreenElement).toBe(cell(SHARE)));
      expect(lock).not.toHaveBeenCalled();
      expect(backClaims.onBack).toHaveLength(0);
    });
  });
});
