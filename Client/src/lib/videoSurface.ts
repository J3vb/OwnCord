// A video track whose frames our own code draws into a canvas: the Linux
// native renderer (`features/voice/native/videoRenderer.ts`). Wherever a
// <video> is given such a track, the canvas itself is shown right after it and
// the <video> is hidden (`video[data-surface]` in video.css). WebKitGTK's
// `canvas.captureStream()` delivers only the first frames into a <video> on
// some GPU stacks, so the track cannot carry the picture.
//
// The canvas follows its <video>: callers sync after giving a <video> its
// stream or taking it away, and after moving the <video> (into a pop-out
// window or the mini-player, back into its tile). A canvas sits beside one
// <video> at a time: a second consumer of the same track needs a renderer of
// its own (the settings camera preview has one).

const surfaces = new WeakMap<MediaStreamTrack, HTMLCanvasElement>();
/** The surface each <video> last showed, to take down when its stream goes. */
const shown = new WeakMap<HTMLVideoElement, HTMLCanvasElement>();

/** `canvas` is the picture of `track`, for every <video> given it. */
export function registerVideoSurface(track: MediaStreamTrack, canvas: HTMLCanvasElement): void {
  surfaces.set(track, canvas);
}

/** The canvas drawing `video`'s stream, or null when the <video> plays it. */
export function videoSurfaceOf(video: HTMLVideoElement): HTMLCanvasElement | null {
  // Duck-typed: a <video> in a pop-out window holds the opener's MediaStream,
  // which fails an `instanceof` against the window's own.
  const stream = video.srcObject as MediaStream | null;
  if (typeof stream?.getVideoTracks !== "function") return null;
  const track = stream.getVideoTracks()[0];
  return track === undefined ? null : (surfaces.get(track) ?? null);
}

/** Show `video`'s surface right after it, or take down the one it showed. */
export function syncVideoSurface(video: HTMLVideoElement): void {
  const surface = videoSurfaceOf(video);
  const previous = shown.get(video);
  if (previous !== undefined && previous !== surface) {
    shown.delete(video);
    // Only from beside this <video>: another may show it by now.
    if (previous.previousSibling === video) previous.remove();
  }
  if (surface === null) {
    delete video.dataset.surface;
    return;
  }
  video.dataset.surface = "";
  shown.set(video, surface);
  if (video.parentNode !== null && video.nextSibling !== surface) video.after(surface);
}
