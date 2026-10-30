import { describe, expect, it } from "vitest";
import { registerVideoSurface, syncVideoSurface, videoSurfaceOf } from "./videoSurface";

/** A stream as a <video> holds it: only its video tracks are read. */
function streamOf(track: MediaStreamTrack): MediaStream {
  return { getVideoTracks: () => [track] } as unknown as MediaStream;
}

function drawnTrack(): { track: MediaStreamTrack; canvas: HTMLCanvasElement } {
  const track = { kind: "video" } as MediaStreamTrack;
  const canvas = document.createElement("canvas");
  registerVideoSurface(track, canvas);
  return { track, canvas };
}

function videoIn(parent: HTMLElement, stream: MediaStream | null): HTMLVideoElement {
  const video = document.createElement("video");
  video.srcObject = stream;
  parent.appendChild(video);
  return video;
}

describe("videoSurface", () => {
  it("shows a drawn track's canvas right after its <video> and hides the <video>", () => {
    const { track, canvas } = drawnTrack();
    const tile = document.createElement("div");
    const video = videoIn(tile, streamOf(track));
    tile.appendChild(document.createElement("button"));
    syncVideoSurface(video);
    expect(video.nextSibling).toBe(canvas);
    expect(video.dataset.surface).toBe("");
    expect(videoSurfaceOf(video)).toBe(canvas);
    // Syncing again leaves it where it is.
    syncVideoSurface(video);
    expect([...tile.children].map((c) => c.tagName)).toEqual(["VIDEO", "CANVAS", "BUTTON"]);
  });

  it("follows the <video> when it moves (pop-out window, mini-player, back)", () => {
    const { track, canvas } = drawnTrack();
    const tile = document.createElement("div");
    const popout = document.createElement("div");
    const video = videoIn(tile, streamOf(track));
    syncVideoSurface(video);
    popout.appendChild(video);
    syncVideoSurface(video);
    expect(canvas.parentNode).toBe(popout);
    expect(tile.childElementCount).toBe(0);
    tile.insertBefore(video, tile.firstChild);
    syncVideoSurface(video);
    expect(video.nextSibling).toBe(canvas);
  });

  it("takes the canvas down when the <video> loses its stream", () => {
    const { track, canvas } = drawnTrack();
    const tile = document.createElement("div");
    const video = videoIn(tile, streamOf(track));
    syncVideoSurface(video);
    video.srcObject = null;
    syncVideoSurface(video);
    expect(canvas.isConnected || canvas.parentNode !== null).toBe(false);
    expect(video.dataset.surface).toBeUndefined();
  });

  it("leaves a canvas another <video> shows by now", () => {
    const { track, canvas } = drawnTrack();
    const first = videoIn(document.createElement("div"), streamOf(track));
    const second = videoIn(document.createElement("div"), streamOf(track));
    syncVideoSurface(first);
    syncVideoSurface(second);
    first.srcObject = null;
    syncVideoSurface(first);
    expect(second.nextSibling).toBe(canvas);
  });

  it("does nothing for a track the <video> plays itself", () => {
    const tile = document.createElement("div");
    const video = videoIn(tile, streamOf({ kind: "video" } as MediaStreamTrack));
    syncVideoSurface(video);
    expect(videoSurfaceOf(video)).toBeNull();
    expect(video.dataset.surface).toBeUndefined();
    expect(tile.childElementCount).toBe(1);
    video.srcObject = null;
    expect(videoSurfaceOf(video)).toBeNull();
  });

  it("puts the canvas in place once a detached <video> is attached", () => {
    const { track, canvas } = drawnTrack();
    const video = document.createElement("video");
    video.srcObject = streamOf(track);
    syncVideoSurface(video);
    expect(canvas.parentNode).toBeNull();
    const tile = document.createElement("div");
    tile.appendChild(video);
    syncVideoSurface(video);
    expect(video.nextSibling).toBe(canvas);
  });
});
