/**
 * Pop out (Discord-style): a tile's stream in a desktop window of its own,
 * which the system can maximise and which can go full screen. A
 * picture-in-picture window can do neither, by spec.
 *
 * `window.open` with a pop-out URL reaches the desktop backend's new-window
 * handler (`src-tauri/src/popout.rs`), which builds a real window in the main
 * webview's own process. So the tile's own <video> moves across with its
 * MediaStream: no second subscription, no new transport. Nothing runs in the
 * window but the DOM drawn here; it has no IPC of its own.
 *
 * Capability and CSP decision: no capability names `owncord-popout-*` on
 * purpose. A window needs none to exist; capabilities only grant IPC, and the
 * pop-out gets none (the main window drives its full screen through its own
 * `core:window:allow-set-fullscreen`, by label). The about:blank popup inherits
 * the opener's CSP (HTML policy-container inheritance), so it runs under the
 * app's policy; tests/e2e/stream-popout.spec.ts checks that.
 */
import { isImeCommit } from "@lib/text/ime";
import { createElement } from "../../lib/dom";
import { Disposable } from "../../lib/disposable";
import { createIcon } from "../../lib/icons";
import { syncVideoSurface } from "../../lib/voice/videoSurface";
import { bindVideoZoom } from "../../lib/zoomPan";
import { voiceText } from "../../i18n/voice";

/** How often to check whether the window was closed (the system's close
 *  button sends the opener no event). */
const CLOSED_POLL_MS = 300;

export interface PopoutOptions {
  readonly title: string;
  readonly video: HTMLVideoElement;
  /** Controls shown over the video in the window (the stream's volume): the
   *  caller's to put back, with the video. */
  readonly controls?: HTMLElement;
  /** The window is gone, closed by the user (`byUser`) or by close(): the
   *  video is the caller's to put back. Called once. */
  readonly onClosed: (byUser: boolean) => void;
  /** Keep the window's own full-screen state with its page's: HTML full
   *  screen fills only the webview in WebView2. */
  readonly setWindowFullscreen?: (on: boolean, label: string) => Promise<void>;
}

export interface Popout {
  close(): void;
}

/** Numbers each window: a label is never reused, since a closing window can
 *  stay registered with the desktop for a moment after close(). */
let openings = 0;

/** F without a modifier: the tiles' full-screen key. */
function isFullscreenKey(e: KeyboardEvent): boolean {
  return (e.key === "f" || e.key === "F") && !e.ctrlKey && !e.metaKey && !e.altKey;
}

export interface PopoutWindowOptions {
  readonly title: string;
  /** What fills the window: moved into its document, the caller's to put
   *  back once `onClosed` runs. */
  readonly content: HTMLElement;
  /** Each time `content` lands in the window's document (again on load):
   *  listeners for that document, owned by `signal`. */
  readonly onDraw?: (doc: Document, signal: AbortSignal) => void;
  /** The window is gone, closed by the user (`byUser`) or by close(). Called
   *  once. */
  readonly onClosed: (byUser: boolean) => void;
}

export interface PopoutWindow extends Popout {
  /** The desktop window's label, for its full-screen state. */
  readonly label: string;
  /** Bring the window to the front. */
  focus(): void;
}

/** Open a pop-out window with the app's theme and styles and move `content`
 *  into it, or null when no window could open. */
export function openPopoutWindow(opts: PopoutWindowOptions): PopoutWindow | null {
  const label = `owncord-popout-${++openings}`;
  const win = window.open(`about:blank#${label}`, label, "popup,width=960,height=540");
  if (win === null) return null;

  const listeners = new Disposable();
  const { signal } = listeners;
  const { content } = opts;

  /** Draw the page into the window's document. Again on load: a window that
   *  loads its URL after open() returned replaces the document drawn into
   *  (the Window, and its listeners, carry over). */
  function draw(): void {
    const doc = win!.document;
    if (content.ownerDocument === doc && content.isConnected) return;
    doc.title = opts.title;
    // The app's theme and styles, so the window looks like the app.
    for (const attr of document.documentElement.attributes) {
      doc.documentElement.setAttribute(attr.name, attr.value);
    }
    for (const sheet of document.head.querySelectorAll("link[rel='stylesheet'], style")) {
      const copy = doc.importNode(sheet, true);
      if (sheet instanceof HTMLLinkElement) copy.setAttribute("href", sheet.href);
      doc.head.appendChild(copy);
    }
    doc.body.appendChild(content);
    opts.onDraw?.(doc, signal);
  }

  const poll = setInterval(() => {
    if (win.closed) finish(true);
  }, CLOSED_POLL_MS);

  function finish(byUser: boolean): void {
    if (signal.aborted) return;
    clearInterval(poll);
    listeners.destroy();
    opts.onClosed(byUser);
  }

  win.addEventListener("load", draw, { signal });
  // No orphan windows: the app page going away takes them along.
  window.addEventListener("pagehide", () => win.close(), { signal });
  draw();

  return {
    label,
    focus(): void {
      win.focus();
    },
    close(): void {
      if (!win.closed) win.close();
      finish(false);
    },
  };
}

/** Open the pop-out window and move the video into it, or null when no
 *  window could open. */
export function openPopout(opts: PopoutOptions): Popout | null {
  const root = createElement("div", { class: "video-popout" });
  const button = createElement("button", {
    type: "button",
    class: "video-tile-btn video-popout__fullscreen",
    "data-popout-control": "fullscreen",
  });
  let fullscreen = false;
  let label = "";

  function setFullscreen(on: boolean): void {
    const text = on ? voiceText("tile.exitFullscreen") : voiceText("tile.fullscreen");
    button.setAttribute("aria-label", text);
    button.title = text;
    button.replaceChildren(createIcon(on ? "minimize" : "maximize", 18));
    if (on === fullscreen) return;
    fullscreen = on;
    void opts.setWindowFullscreen?.(on, label).catch(() => {});
  }

  /** As a tile does: HTML full screen, the window following it; the window
   *  alone where the page cannot. */
  function toggleFullscreen(): void {
    const doc = root.ownerDocument;
    if (doc.fullscreenElement !== null && doc.fullscreenElement !== undefined) {
      void doc.exitFullscreen().catch(() => {});
      return;
    }
    if (fullscreen) {
      setFullscreen(false);
      return;
    }
    const request = root.requestFullscreen as (() => Promise<void>) | undefined;
    if (typeof request !== "function") {
      setFullscreen(true);
      return;
    }
    request.call(root).catch(() => setFullscreen(true));
  }

  function onKey(e: KeyboardEvent): void {
    if (isFullscreenKey(e) || (e.key === "Escape" && !isImeCommit(e) && fullscreen)) {
      e.preventDefault();
      toggleFullscreen();
    }
  }

  setFullscreen(false);
  // Ctrl + wheel and drag zoom the stream here as on its tile; the window
  // opens unzoomed.
  const zoom = new Disposable();
  bindVideoZoom(root, zoom.signal);
  const popout = openPopoutWindow({
    title: opts.title,
    content: root,
    onDraw: (doc, signal) => {
      root.replaceChildren(
        opts.video,
        ...(opts.controls === undefined ? [] : [opts.controls]),
        button,
      );
      syncVideoSurface(opts.video);
      doc.addEventListener("fullscreenchange", () => setFullscreen(doc.fullscreenElement != null), {
        signal,
      });
      doc.addEventListener("keydown", onKey, { signal });
      void opts.video.play()?.catch(() => {});
    },
    onClosed: (byUser) => {
      zoom.destroy();
      opts.onClosed(byUser);
    },
  });
  if (popout === null) {
    zoom.destroy();
    return null;
  }
  label = popout.label;
  button.addEventListener("click", toggleFullscreen);
  root.addEventListener("dblclick", toggleFullscreen);
  return popout;
}
