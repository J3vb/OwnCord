/**
 * Mini-player (Discord-style): the stream you are watching, kept playing in a
 * small floating player over the app while you read a text channel. It can be
 * dragged anywhere inside the window (or moved with the arrow keys) and stays
 * there for the rest of the session.
 *
 * Like the pop-out window, the tile's own <video> moves in with its
 * MediaStream: no second subscription. The caller puts it back on close.
 */
import { createElement } from "../../lib/dom";
import { Disposable } from "../../lib/disposable";
import { createIcon, type IconName } from "../../lib/icons";
import { syncVideoSurface } from "../../lib/videoSurface";
import { voiceText } from "../../i18n/voice";

/** How far one arrow key press moves the player. */
const KEY_STEP_PX = 24;
/** The first placement: bottom right, clear of the composer's buttons. */
const EDGE_GAP_PX = 16;
const BOTTOM_GAP_PX = 96;

export interface MiniPlayerOptions {
  /** The streamer's name. */
  readonly name: string;
  readonly video: HTMLVideoElement;
  /** Back to the full stream view (its control, or a double-click). */
  readonly onReturn: () => void;
  /** Into the pop-out window instead. */
  readonly onPopout: () => void;
  readonly onStopWatching: () => void;
  /** The player is gone: the video is the caller's to put back. Called once.
   *  `hadFocus`: focus was inside it, so it is the caller's to move. */
  readonly onClosed: (hadFocus: boolean) => void;
}

export interface MiniPlayer {
  readonly element: HTMLElement;
  close(): void;
}

/** Where the player sits, kept for the session (not across restarts). */
let position: { left: number; top: number } | null = null;

/** Forget the session's position (tests). */
export function resetMiniPlayerPosition(): void {
  position = null;
}

/** Keep `left`/`top` inside the window for an element of `width`×`height`. */
export function clampToWindow(
  left: number,
  top: number,
  width: number,
  height: number,
): { left: number; top: number } {
  return {
    left: Math.max(0, Math.min(left, window.innerWidth - width)),
    top: Math.max(0, Math.min(top, window.innerHeight - height)),
  };
}

export function openMiniPlayer(opts: MiniPlayerOptions): MiniPlayer {
  const listeners = new Disposable();
  const { signal } = listeners;
  const root = createElement("div", {
    class: "stream-mini",
    role: "region",
    "aria-label": voiceText("mini.label", { name: opts.name }),
    "aria-describedby": "stream-mini-hint",
    tabindex: "0",
    "data-testid": "stream-mini-player",
  });
  const hint = createElement(
    "span",
    { id: "stream-mini-hint", class: "sr-only" },
    voiceText("mini.hint"),
  );
  const name = createElement("div", { class: "stream-mini__name" }, opts.name);
  const controls = createElement("div", { class: "stream-mini__controls" });

  function control(label: string, icon: IconName, id: string, onClick: () => void): void {
    const btn = createElement("button", {
      type: "button",
      class: "video-tile-btn",
      "aria-label": label,
      title: label,
      "data-testid": `stream-mini-${id}`,
    });
    btn.appendChild(createIcon(icon, 16));
    btn.addEventListener("click", onClick, { signal });
    controls.appendChild(btn);
  }
  control(voiceText("mini.return"), "maximize", "return", opts.onReturn);
  control(voiceText("tile.popOut"), "picture-in-picture-2", "popout", opts.onPopout);
  control(voiceText("tile.stopWatching"), "eye-off", "stop", opts.onStopWatching);

  root.append(opts.video, name, controls, hint);
  syncVideoSurface(opts.video);
  document.body.appendChild(root);
  void opts.video.play()?.catch(() => {});

  function place(left: number, top: number): void {
    const next = clampToWindow(left, top, root.offsetWidth, root.offsetHeight);
    root.style.left = `${next.left}px`;
    root.style.top = `${next.top}px`;
    position = next;
  }
  if (position !== null) place(position.left, position.top);
  else
    place(
      window.innerWidth - root.offsetWidth - EDGE_GAP_PX,
      window.innerHeight - root.offsetHeight - BOTTOM_GAP_PX,
    );

  // Drag from anywhere but a control. Pointer capture keeps the drag when
  // the pointer outruns the player.
  let drag: { dx: number; dy: number; id: number } | null = null;
  root.addEventListener(
    "pointerdown",
    (e) => {
      if (e.button !== 0 || (e.target as Element).closest("button") !== null) return;
      e.preventDefault();
      root.focus();
      drag = { dx: e.clientX - root.offsetLeft, dy: e.clientY - root.offsetTop, id: e.pointerId };
      root.setPointerCapture?.(e.pointerId);
      root.classList.add("stream-mini--dragging");
    },
    { signal },
  );
  root.addEventListener(
    "pointermove",
    (e) => {
      if (drag === null || e.pointerId !== drag.id) return;
      place(e.clientX - drag.dx, e.clientY - drag.dy);
    },
    { signal },
  );
  const endDrag = (e: PointerEvent): void => {
    if (drag === null || e.pointerId !== drag.id) return;
    drag = null;
    root.classList.remove("stream-mini--dragging");
  };
  root.addEventListener("pointerup", endDrag, { signal });
  root.addEventListener("pointercancel", endDrag, { signal });
  root.addEventListener(
    "dblclick",
    (e) => {
      if ((e.target as Element).closest("button") === null) opts.onReturn();
    },
    { signal },
  );
  // The keyboard way to move it (dragging is never the only way), and Enter
  // back to the full view.
  root.addEventListener(
    "keydown",
    (e) => {
      if (e.target !== root) return;
      const move: Record<string, [number, number]> = {
        ArrowLeft: [-KEY_STEP_PX, 0],
        ArrowRight: [KEY_STEP_PX, 0],
        ArrowUp: [0, -KEY_STEP_PX],
        ArrowDown: [0, KEY_STEP_PX],
      };
      const step = move[e.key];
      if (step !== undefined) {
        e.preventDefault();
        place(root.offsetLeft + step[0], root.offsetTop + step[1]);
      } else if (e.key === "Enter") {
        e.preventDefault();
        opts.onReturn();
      }
    },
    { signal },
  );
  // A smaller window keeps it in view.
  window.addEventListener("resize", () => place(root.offsetLeft, root.offsetTop), { signal });

  return {
    element: root,
    close(): void {
      if (signal.aborted) return;
      const hadFocus = root.contains(document.activeElement);
      listeners.destroy();
      root.remove();
      opts.onClosed(hadFocus);
    },
  };
}
