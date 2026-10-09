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
import { createElement } from "../../lib/dom";
import { Disposable } from "../../lib/disposable";
import { createIcon } from "../../lib/icons";
import { voiceText } from "../../i18n/voice";

/** How often to check whether the window was closed (the system's close
 *  button sends the opener no event). */
const CLOSED_POLL_MS = 300;

export interface PopoutOptions {
  readonly title: string;
  readonly video: HTMLVideoElement;
  /** The window is gone, closed by the user or by close(): the video is the
   *  caller's to put back. Called once. */
  readonly onClosed: () => void;
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

/** Open the pop-out window and move the video into it, or null when no
 *  window could open. */
export function openPopout(opts: PopoutOptions): Popout | null {
  const label = `owncord-popout-${++openings}`;
  const win = window.open(`about:blank#${label}`, label, "popup,width=960,height=540");
  if (win === null) return null;

  const listeners = new Disposable();
  const { signal } = listeners;
  const root = createElement("div", { class: "video-popout" });
  const button = createElement("button", {
    type: "button",
    class: "video-tile-btn video-popout__fullscreen",
    "data-popout-control": "fullscreen",
  });
  let fullscreen = false;

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
    const doc = win!.document;
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
    if (isFullscreenKey(e) || (e.key === "Escape" && fullscreen)) {
      e.preventDefault();
      toggleFullscreen();
    }
  }

  /** Draw the page into the window's document. Again on load: a window that
   *  loads its URL after open() returned replaces the document drawn into
   *  (the Window, and its listeners, carry over). */
  function draw(): void {
    const doc = win!.document;
    if (root.ownerDocument === doc && root.isConnected) return;
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
    root.replaceChildren(opts.video, button);
    doc.body.appendChild(root);
    doc.addEventListener("fullscreenchange", () => setFullscreen(doc.fullscreenElement != null), {
      signal,
    });
    doc.addEventListener("keydown", onKey, { signal });
    void opts.video.play()?.catch(() => {});
  }

  const poll = setInterval(() => {
    if (win.closed) finish();
  }, CLOSED_POLL_MS);

  function finish(): void {
    if (signal.aborted) return;
    clearInterval(poll);
    listeners.destroy();
    opts.onClosed();
  }

  button.addEventListener("click", toggleFullscreen, { signal });
  root.addEventListener("dblclick", toggleFullscreen, { signal });
  win.addEventListener("load", draw, { signal });
  // No orphan windows: the app page going away takes them along.
  window.addEventListener("pagehide", () => win.close(), { signal });
  setFullscreen(false);
  draw();

  return {
    close(): void {
      if (!win.closed) win.close();
      finish();
    },
  };
}
