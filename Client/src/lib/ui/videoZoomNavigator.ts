import { createElement, setOwnedTimeout } from "../dom";
import { Disposable } from "../disposable";
import { videoSurfaceOf } from "../voice/videoSurface";
import { voiceText } from "../../i18n/voice";
import type { ZoomPan } from "./zoomPan";

const clamp = (n: number): number => Math.max(0, Math.min(1, n));

/** The visible intersection of a contained picture and its viewer, in source fractions. */
export function videoZoomFrame(
  width: number,
  height: number,
  sourceWidth: number,
  sourceHeight: number,
  view: Pick<ZoomPan, "scale" | "x" | "y">,
) {
  const fit = Math.min(width / sourceWidth, height / sourceHeight);
  const pictureWidth = sourceWidth * fit;
  const pictureHeight = sourceHeight * fit;
  const left = clamp(0.5 - (width / 2 + view.x) / (pictureWidth * view.scale));
  const top = clamp(0.5 - (height / 2 + view.y) / (pictureHeight * view.scale));
  const right = clamp(0.5 + (width / 2 - view.x) / (pictureWidth * view.scale));
  const bottom = clamp(0.5 + (height / 2 - view.y) / (pictureHeight * view.scale));
  return { left, top, width: right - left, height: bottom - top, pictureWidth, pictureHeight };
}

/** A tiny view of the already-decoded stream; it never subscribes to another track. */
export function createVideoZoomNavigator(
  host: HTMLElement,
  view: ZoomPan,
  signal: AbortSignal,
): () => void {
  if (signal.aborted) return () => {};
  const root = createElement("div", { class: "video-zoom-nav" });
  const header = createElement("div", { class: "video-zoom-nav__header" });
  const percent = createElement("strong", { class: "video-zoom-nav__percent" });
  const reset = createElement(
    "button",
    {
      type: "button",
      class: "video-tile-btn video-zoom-nav__reset",
      "aria-label": voiceText("zoom.resetLabel"),
    },
    voiceText("zoom.reset"),
  );
  const map = createElement("button", {
    type: "button",
    class: "video-zoom-nav__map",
    "aria-label": voiceText("zoom.navigate"),
    title: voiceText("zoom.navigate"),
  });
  const canvas = createElement("canvas", { "aria-hidden": "true" });
  const footer = createElement("div", { class: "video-zoom-nav__footer" });
  const resolution = createElement("span");
  footer.append(resolution, createElement("span", {}, voiceText("zoom.drag")));
  header.append(percent, reset);
  map.append(canvas);
  root.append(header, map, footer);
  root.hidden = true;
  host.appendChild(root);

  let cancelFrame: (() => void) | undefined;
  let drag: { id: number; x: number; y: number } | null = null;
  let dragListeners: Disposable | null = null;
  let sourceWidth = 16;
  let sourceHeight = 9;
  const doc = host.ownerDocument;

  function frame() {
    return videoZoomFrame(host.clientWidth, host.clientHeight, sourceWidth, sourceHeight, view);
  }

  function endDrag(): void {
    dragListeners?.destroy();
    dragListeners = null;
    drag = null;
    map.style.removeProperty("cursor");
  }

  function restoreFocus(): void {
    host
      .querySelector<HTMLElement>(
        ".video-cell-select:not([hidden]), [data-tile-control='fullscreen'], .video-popout__fullscreen",
      )
      ?.focus();
  }

  function navigate(x: number, y: number): void {
    const box = frame();
    const targetX = (0.5 - x) * box.pictureWidth * view.scale;
    const targetY = (0.5 - y) * box.pictureHeight * view.scale;
    view.panBy(targetX - view.x, targetY - view.y);
  }

  function point(e: PointerEvent): { x: number; y: number } {
    const box = map.getBoundingClientRect();
    return {
      x: (e.clientX - box.left - map.clientLeft) / map.clientWidth,
      y: (e.clientY - box.top - map.clientTop) / map.clientHeight,
    };
  }

  function move(e: PointerEvent): void {
    if (drag === null || drag.id !== e.pointerId) return;
    const p = point(e);
    const box = frame();
    navigate(p.x - drag.x + box.width / 2, p.y - drag.y + box.height / 2);
  }

  map.addEventListener(
    "pointerdown",
    (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      map.focus({ preventScroll: true });
      endDrag();
      view.cancelDrag();
      const p = point(e);
      const box = frame();
      const inside =
        p.x >= box.left &&
        p.x <= box.left + box.width &&
        p.y >= box.top &&
        p.y <= box.top + box.height;
      drag = {
        id: e.pointerId,
        x: inside ? p.x - box.left : box.width / 2,
        y: inside ? p.y - box.top : box.height / 2,
      };
      map.style.cursor = "grabbing";
      // A whole call can move to another window with this tile still alive.
      const owner = host.ownerDocument;
      dragListeners = new Disposable();
      const dragSignal = dragListeners.signal;
      owner.addEventListener("pointermove", move, { signal: dragSignal });
      owner.addEventListener("pointerup", lift, { signal: dragSignal });
      owner.addEventListener("pointercancel", lift, { signal: dragSignal });
      owner.defaultView?.addEventListener("blur", endDrag, { signal: dragSignal });
      move(e);
    },
    { signal },
  );
  const lift = (e: PointerEvent): void => {
    if (drag?.id === e.pointerId) endDrag();
  };
  map.addEventListener(
    "keydown",
    (e) => {
      const steps: Readonly<Record<string, readonly [number, number]>> = {
        ArrowLeft: [1, 0],
        ArrowRight: [-1, 0],
        ArrowUp: [0, 1],
        ArrowDown: [0, -1],
      };
      const step = steps[e.key];
      if (step === undefined) return;
      e.preventDefault();
      // Only the keys the map uses stop here: Escape and F still reach the
      // tile, theatre and pop-out handlers above it.
      e.stopPropagation();
      const amount = e.shiftKey ? 0.25 : 0.05;
      view.panBy(step[0] * host.clientWidth * amount, step[1] * host.clientHeight * amount);
    },
    { signal },
  );
  reset.addEventListener(
    "click",
    () => {
      view.reset();
      restoreFocus();
    },
    { signal },
  );
  for (const event of ["mousedown", "click", "dblclick"] as const) {
    root.addEventListener(event, (e) => e.stopPropagation(), { signal });
  }

  function draw(): void {
    const video = host.querySelector<HTMLVideoElement>(":scope > video");
    if (video === null || root.hidden || !host.isConnected || host.ownerDocument.hidden) return;
    const source = videoSurfaceOf(video) ?? video;
    if (source === video && video.readyState < 2) return;
    try {
      const ctx = canvas.getContext("2d");
      if (ctx === null) return;
      ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
      drawViewport(ctx);
    } catch {
      // A frame can become unavailable between the ready-state check and the copy.
      canvas.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
    }
  }

  function drawViewport(ctx: CanvasRenderingContext2D): void {
    const box = frame();
    const w = canvas.width;
    const h = canvas.height;
    const x = box.left * w;
    const y = box.top * h;
    const width = box.width * w;
    const height = box.height * h;
    const styles = getComputedStyle(root);
    ctx.fillStyle = styles.getPropertyValue("--scrim");
    ctx.fillRect(0, 0, x, h);
    ctx.fillRect(x + width, 0, w - x - width, h);
    ctx.fillRect(x, 0, width, y);
    ctx.fillRect(x, y + height, width, h - y - height);
    ctx.strokeStyle = styles.getPropertyValue("--accent-text");
    ctx.lineWidth = 2;
    ctx.strokeRect(x + 1, y + 1, Math.max(0, width - 2), Math.max(0, height - 2));
  }

  function tick(): void {
    cancelFrame = undefined;
    if (root.hidden || signal.aborted || host.ownerDocument.hidden || !host.isConnected) return;
    if (root.checkVisibility?.() === false) return;
    draw();
    cancelFrame = setOwnedTimeout(signal, tick, 150);
  }

  function readSource(): HTMLVideoElement | null {
    const video = host.querySelector<HTMLVideoElement>(":scope > video");
    const surface = video === null ? null : videoSurfaceOf(video);
    sourceWidth = surface?.width || video?.videoWidth || 16;
    sourceHeight = surface?.height || video?.videoHeight || 9;
    return video;
  }

  function update(): void {
    const video = readSource();
    const unavailable =
      video === null ||
      video.srcObject === null ||
      host.classList.contains("track-muted") ||
      host.classList.contains("video-cell--stopped");
    root.hidden =
      view.scale <= 1 || unavailable || host.clientWidth === 0 || host.clientHeight === 0;
    if (root.hidden) {
      cancelFrame?.();
      cancelFrame = undefined;
      endDrag();
      canvas.width = 0;
      canvas.height = 0;
      return;
    }
    percent.textContent = voiceText("tile.percent", { percent: Math.round(view.scale * 100) });
    resolution.textContent = voiceText("tile.resolutionValue", {
      width: String(sourceWidth),
      height: String(sourceHeight),
    });
    sizePreview();
    if (!host.contains(root)) host.appendChild(root);
    draw();
    if (cancelFrame === undefined) tick();
  }

  function sizePreview(): void {
    const width = Math.max(
      1,
      Math.floor(Math.min(192, host.clientWidth - 44, (180 * sourceWidth) / sourceHeight)),
    );
    const height = Math.max(1, Math.round((width * sourceHeight) / sourceWidth));
    root.style.width = `${Math.min(216, host.clientWidth - 24)}px`;
    map.style.width = `${width + 2}px`;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
  }

  const resize = new ResizeObserver(() => view.panBy(0, 0));
  resize.observe(host);
  const children = new MutationObserver(update);
  children.observe(host, {
    childList: true,
    attributes: true,
    attributeFilter: ["class"],
  });
  host.addEventListener("loadedmetadata", update, { signal, capture: true });
  host.addEventListener("resize", update, { signal, capture: true });
  host.addEventListener("emptied", update, { signal, capture: true });
  doc.addEventListener("visibilitychange", update, { signal });
  signal.addEventListener(
    "abort",
    () => {
      cancelFrame?.();
      endDrag();
      resize.disconnect();
      children.disconnect();
      root.remove();
      canvas.width = 0;
      canvas.height = 0;
    },
    { once: true },
  );
  return update;
}
