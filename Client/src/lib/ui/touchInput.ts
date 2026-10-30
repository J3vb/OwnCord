// Touch input for phones and touchscreens. Loaded lazily by
// app/globalGuards.ts, only when a coarse pointer exists. Everything is
// closure state, so nothing is module-level and nothing needs a session reset.
//
// - Long-press (500 ms) sends the existing `contextmenu` event at the finger,
//   so every menu handler opens without new wiring. iOS fires no native one.
// - A native `contextmenu` (Chrome on Android, WebView2) wins: no
//   synthetic event while it is pending or within 300 ms, and a late native one
//   after a synthetic one is swallowed. One menu, never two.
// - The click that follows the lift is cancelled once, so the menu does not
//   open and close, and the row under the finger is not activated.
// - A tap on a message does nothing: like Discord, the hold is the only way
//   to a message's actions on a touch screen.
// - visualViewport drives --app-height so the keyboard does not hide the composer.

import { setOwnedTimeout, wantsNativeMenu } from "../dom";

const LONG_PRESS_MS = 500;
const MOVE_TOLERANCE_PX = 10;
const NATIVE_DEDUPE_MS = 300;
const CLICK_SUPPRESS_MS = 600;

export function installTouchInput(signal: AbortSignal): void {
  if (signal.aborted) return;

  let cancelTimer: (() => void) | null = null;
  let startX = 0;
  let startY = 0;
  let fired = false;
  let touching = false;
  let nativeAt = Number.NEGATIVE_INFINITY;
  let syntheticAt = Number.NEGATIVE_INFINITY;
  let suppressClickUntil = Number.NEGATIVE_INFINITY;
  // The events this module sent. Any other contextmenu is "native" to it: the
  // webview's own, or one the app dispatched for the Menu key. Keyed by identity
  // rather than isTrusted, which is unforgeable and so cannot be tested.
  const ours = new WeakSet<Event>();

  const clearTimer = (): void => {
    cancelTimer?.();
    cancelTimer = null;
  };

  const on = <K extends keyof DocumentEventMap>(
    type: K,
    handler: (e: DocumentEventMap[K]) => void,
    capture = false,
  ): void => {
    document.addEventListener(type, handler, { capture, passive: false, signal });
  };

  on("pointerdown", (e) => {
    // A new press owns its own click: a menu item tapped right after the menu
    // opened (iOS often sends no click for the long hold) must go through.
    suppressClickUntil = Number.NEGATIVE_INFINITY;
    if (e.pointerType !== "touch") return;
    if (!e.isPrimary) {
      // A second finger is a pinch or a scroll, never a long-press.
      clearTimer();
      return;
    }
    clearTimer();
    touching = true;
    fired = false;
    startX = e.clientX;
    startY = e.clientY;
    const target = e.target instanceof Element ? e.target : null;
    if (target === null || wantsNativeMenu(target)) return;
    cancelTimer = setOwnedTimeout(
      signal,
      () => {
        cancelTimer = null;
        const now = Date.now();
        if (now - nativeAt < NATIVE_DEDUPE_MS || !target.isConnected) return;
        fired = true;
        syntheticAt = now;
        suppressClickUntil = now + CLICK_SUPPRESS_MS;
        const menu = new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: startX,
          clientY: startY,
        });
        ours.add(menu);
        target.dispatchEvent(menu);
      },
      LONG_PRESS_MS,
    );
  });

  on("pointermove", (e) => {
    if (e.pointerType !== "touch" || !e.isPrimary || !touching) return;
    if (Math.hypot(e.clientX - startX, e.clientY - startY) > MOVE_TOLERANCE_PX) clearTimer();
  });

  on("pointercancel", (e) => {
    if (e.pointerType !== "touch" || !e.isPrimary) return;
    touching = false;
    clearTimer();
  });

  on("pointerup", (e) => {
    if (e.pointerType !== "touch" || !e.isPrimary) return;
    touching = false;
    clearTimer();
    // The click comes after the lift, which can be long after the timer fired.
    if (fired) suppressClickUntil = Date.now() + CLICK_SUPPRESS_MS;
  });

  // A scroll (the capture phase sees scrolls of any inner list) cancels a pending press.
  document.addEventListener("scroll", clearTimer, { capture: true, passive: true, signal });

  on(
    "contextmenu",
    (e) => {
      if (ours.has(e)) return;
      const now = Date.now();
      if (now - syntheticAt < NATIVE_DEDUPE_MS || (touching && fired)) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      nativeAt = now;
      clearTimer();
      // The webview's own long-press: its lift is not a tap either.
      if (touching) fired = true;
    },
    true,
  );

  on(
    "click",
    (e) => {
      if (Date.now() > suppressClickUntil) return;
      suppressClickUntil = Number.NEGATIVE_INFINITY;
      e.preventDefault();
      e.stopPropagation();
    },
    true,
  );
  // The compatibility mouse events of the lift too: a menu that closes on a
  // document mousedown (the member menu) must survive the finger leaving.
  const swallowCompat = (e: MouseEvent): void => {
    if (Date.now() > suppressClickUntil) return;
    e.preventDefault();
    e.stopPropagation();
  };
  on("mousedown", swallowCompat, true);
  on("mouseup", swallowCompat, true);

  const vv = window.visualViewport;
  if (vv) {
    const root = document.documentElement;
    const sync = (): void => {
      // Pinch-zoomed, the visual viewport is a window onto the page, not the
      // room left by the keyboard: let #app keep its own height.
      if (vv.scale > 1.01) {
        root.style.removeProperty("--app-height");
        return;
      }
      root.style.setProperty("--app-height", `${vv.height}px`);
      window.scrollTo(0, 0);
    };
    sync();
    vv.addEventListener("resize", sync, { signal });
    vv.addEventListener("scroll", sync, { signal });
    signal.addEventListener("abort", () => root.style.removeProperty("--app-height"), {
      once: true,
    });
  }

  signal.addEventListener("abort", clearTimer, { once: true });
}
