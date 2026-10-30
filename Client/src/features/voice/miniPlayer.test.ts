import { describe, it, expect, vi, afterEach } from "vitest";
import {
  clampToWindow,
  openMiniPlayer,
  resetMiniPlayerPosition,
  type MiniPlayer,
} from "./miniPlayer";
import { registerVideoSurface } from "../../lib/voice/videoSurface";

/** jsdom lays nothing out: give the player a size. */
function sized(player: MiniPlayer, width: number, height: number): void {
  Object.defineProperty(player.element, "offsetWidth", { value: width, configurable: true });
  Object.defineProperty(player.element, "offsetHeight", { value: height, configurable: true });
}

function open(overrides: Partial<Parameters<typeof openMiniPlayer>[0]> = {}) {
  const opts = {
    name: "otto",
    video: document.createElement("video"),
    onReturn: vi.fn(),
    onPopout: vi.fn(),
    onStopWatching: vi.fn(),
    onClosed: vi.fn(),
    ...overrides,
  };
  return { opts, player: openMiniPlayer(opts) };
}

describe("mini-player", () => {
  let player: MiniPlayer | null = null;
  afterEach(() => {
    player?.close();
    player = null;
    resetMiniPlayerPosition();
  });

  it("takes a canvas-drawn stream's canvas along with its video (Linux)", () => {
    const track = { kind: "video" } as MediaStreamTrack;
    const canvas = document.createElement("canvas");
    registerVideoSurface(track, canvas);
    const video = document.createElement("video");
    video.srcObject = { getVideoTracks: () => [track] } as unknown as MediaStream;
    player = open({ video }).player;
    expect(video.nextSibling).toBe(canvas);
    expect(player.element.contains(canvas)).toBe(true);
  });

  it("keeps a position inside the window", () => {
    expect(clampToWindow(-50, -50, 320, 180)).toEqual({ left: 0, top: 0 });
    expect(clampToWindow(99_999, 99_999, 320, 180)).toEqual({
      left: window.innerWidth - 320,
      top: window.innerHeight - 180,
    });
    expect(clampToWindow(10, 20, 320, 180)).toEqual({ left: 10, top: 20 });
  });

  it("shows the streamer's name and its controls, and takes the video along", () => {
    const opened = open();
    player = opened.player;
    expect(player.element.isConnected).toBe(true);
    expect(player.element.textContent).toContain("otto");
    expect(player.element.contains(opened.opts.video)).toBe(true);
    expect(player.element.getAttribute("aria-label")).toBe("otto's stream, mini player");

    player.element.querySelector<HTMLButtonElement>("[data-testid='stream-mini-return']")!.click();
    player.element.querySelector<HTMLButtonElement>("[data-testid='stream-mini-popout']")!.click();
    player.element.querySelector<HTMLButtonElement>("[data-testid='stream-mini-stop']")!.click();
    expect(opened.opts.onReturn).toHaveBeenCalledTimes(1);
    expect(opened.opts.onPopout).toHaveBeenCalledTimes(1);
    expect(opened.opts.onStopWatching).toHaveBeenCalledTimes(1);
  });

  it("moves with the arrow keys, stops at the edge, and Enter returns", () => {
    const opened = open();
    player = opened.player;
    sized(player, 320, 180);
    const el = player.element;
    // Re-place at the corner through the keys: clamped at 0.
    for (let i = 0; i < 200; i++) {
      el.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    }
    expect(el.style.left).toBe("0px");
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(opened.opts.onReturn).toHaveBeenCalledTimes(1);
  });

  it("opens where the last one was left, for the session", () => {
    const first = open();
    sized(first.player, 320, 180);
    first.player.element.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }),
    );
    const left = first.player.element.style.left;
    const top = first.player.element.style.top;
    first.player.close();

    const second = open();
    player = second.player;
    expect(player.element.style.left).toBe(left);
    expect(player.element.style.top).toBe(top);
  });

  it("close removes it and reports once", () => {
    const opened = open();
    opened.player.close();
    opened.player.close();
    expect(opened.player.element.isConnected).toBe(false);
    expect(opened.opts.onClosed).toHaveBeenCalledTimes(1);
  });
});
