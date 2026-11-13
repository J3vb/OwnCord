/**
 * Toast notification system — stacking notifications just above the composer.
 * Supports info, error, success and warning types with auto-dismiss.
 *
 * Errors are the exception: they stay until dismissed, because a message
 * that vanishes before it can be read or acted on is worse than none at all.
 * Any other type can opt in to the same by passing `durationMs: Infinity`.
 * Every toast pauses its auto-dismiss countdown while hovered or focused, and
 * an identical repeat coalesces into the existing toast with a count instead
 * of stacking a duplicate.
 */

import { createElement, setText } from "@lib/dom";
import { Disposable } from "@lib/disposable";
import type { MountableComponent } from "@lib/text/safeRender";
import { shellText } from "../../i18n/shell";

export type ToastType = "info" | "error" | "success" | "warning";

/** A button on the toast that does something about the message. Clicking it
 *  runs `run` and dismisses the toast. */
export interface ToastAction {
  readonly label: string;
  readonly run: () => void;
}

/** Optional parts of a richer toast. */
export interface ToastExtras {
  /** A second, quieter line under the message. */
  readonly detail?: string;
  /** A decorative leading icon. */
  readonly icon?: SVGElement;
  /** A dismiss button even on a toast that clears itself. */
  readonly closable?: boolean;
}

const MAX_TOASTS = 5;
const DEFAULT_DURATION_MS = 5000;

interface ToastEntry {
  readonly el: HTMLDivElement;
  /** The text an identical repeat matches: the message and any detail line. */
  readonly message: string;
  readonly type: ToastType;
  /** Stays until dismissed: an error, or a toast shown with an infinite duration. */
  readonly sticky: boolean;
  /** Auto-dismiss timer; null for a sticky or a paused toast. */
  timer: ReturnType<typeof setTimeout> | null;
  /** Countdown left when the timer was last cleared (ms). */
  remainingMs: number;
  /** When the current timer run started, for the pause arithmetic. */
  startedAt: number;
  /** Pointer over the toast / focus within it; either holds the countdown. */
  hovered: boolean;
  focused: boolean;
  /** Duplicates of this toast coalesced into it. Starts at 1. */
  count: number;
  readonly countEl: HTMLSpanElement;
}

export interface ToastContainer extends MountableComponent {
  /** Returns a function that removes the toast. */
  show(
    message: string,
    type?: ToastType,
    durationMs?: number,
    action?: ToastAction,
    extras?: ToastExtras,
  ): () => void;
  clear(): void;
  /** Keep the stack just above `anchor` (the composer slot) and centred on
   *  it. While the anchor has no box, the CSS fallback places the stack. */
  anchorTo(anchor: HTMLElement): void;
}

/** Freeze an auto-dismissing toast, holding the time it has left. A module
 *  function so it is not re-created per container. */
function pauseEntry(entry: ToastEntry): void {
  if (entry.timer === null) return;
  clearTimeout(entry.timer);
  entry.timer = null;
  entry.remainingMs -= Date.now() - entry.startedAt;
}

/** What an identical repeat must match: the message and any detail line. */
function toastKey(message: string, extras: ToastExtras): string {
  return extras.detail === undefined ? message : `${message}\n${extras.detail}`;
}

/** The optional icon, then the message and any detail line under it. */
function appendToastBody(el: HTMLElement, message: string, extras: ToastExtras): void {
  const { detail, icon } = extras;
  if (icon !== undefined) {
    icon.classList.add("toast-icon");
    icon.setAttribute("aria-hidden", "true");
    el.appendChild(icon);
  }
  const text = createElement("span", { class: "toast-text" });
  if (detail === undefined) setText(text, message);
  else {
    el.classList.add("toast--detailed");
    text.append(
      createElement("span", { class: "toast-title" }, message),
      createElement("span", { class: "toast-detail" }, detail),
    );
  }
  el.appendChild(text);
}

export function createToastContainer(): ToastContainer {
  let root: HTMLDivElement | null = null;
  const toasts: ToastEntry[] = [];
  let anchor: HTMLElement | null = null;
  let anchorWatch: Disposable | null = null;

  /** Copy the anchor's box into the container's custom properties. A
   *  zero-height anchor (no composer in this view) leaves the vertical
   *  fallback, a zero-width one (hidden) both fallbacks. */
  function place(): void {
    if (root === null) return;
    const box = anchor?.getBoundingClientRect();
    const wide = box !== undefined && box.width > 0;
    const tall = wide && box.height > 0;
    const style = root.style;
    if (wide) {
      style.setProperty("--toast-center", `${box.left + box.width / 2}px`);
      style.setProperty("--toast-room", `${box.width}px`);
    } else {
      style.removeProperty("--toast-center");
      style.removeProperty("--toast-room");
    }
    // Clamped so a composer scrolled off the top still leaves the stack on screen.
    const above = Math.min(window.innerHeight - 64, window.innerHeight - (box?.top ?? 0));
    if (tall) style.setProperty("--toast-bottom", `${Math.max(0, above)}px`);
    else style.removeProperty("--toast-bottom");
  }

  /** Lift the stack clear of a dialog, settings overlay or sheet. Two classes
   *  the stylesheet keys on, set from code so no rule has to ask the whole page
   *  whether such an overlay exists. */
  function syncCover(): void {
    if (root === null) return;
    root.classList.toggle(
      "toast-container--under-dialog",
      document.querySelector(".modal-overlay, .settings-overlay.open") !== null,
    );
    root.classList.toggle(
      "toast-container--over-sheet",
      document.querySelector(".bottom-sheet-overlay, .modal-overlay") !== null,
    );
  }

  let coverWatch: MutationObserver | null = null;

  function stopCoverWatch(): void {
    coverWatch?.disconnect();
    coverWatch = null;
  }

  /** Follow overlays opening and closing for as long as the stack holds a toast. */
  function startCoverWatch(): void {
    if (coverWatch !== null || typeof MutationObserver === "undefined") return;
    coverWatch = new MutationObserver(() => {
      if (root === null || root.childElementCount === 0) {
        stopCoverWatch();
        return;
      }
      syncCover();
    });
    coverWatch.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class"],
    });
  }

  function removeToast(entry: ToastEntry): void {
    const idx = toasts.indexOf(entry);
    if (idx === -1) return;

    pauseEntry(entry);
    toasts.splice(idx, 1);

    // Remove .show first and let the 0.3 s CSS opacity transition finish.
    // A timer rather than transitionend: a toast removed before it was
    // shown never transitions.
    entry.el.classList.remove("show");
    setTimeout(() => entry.el.remove(), 400);
  }

  /** Run an auto-dismissing toast's countdown for its remaining time, unless
   *  it is sticky (persists until dismissed) or held by hover or focus. */
  function resume(entry: ToastEntry): void {
    if (entry.sticky || entry.timer !== null) return;
    if (entry.hovered || entry.focused) return;
    entry.startedAt = Date.now();
    entry.timer = setTimeout(() => removeToast(entry), entry.remainingMs);
  }

  function show(
    message: string,
    type: ToastType = "info",
    durationMs: number = DEFAULT_DURATION_MS,
    action?: ToastAction,
    extras: ToastExtras = {},
  ): () => void {
    if (root === null) return () => {};
    const sticky = type === "error" || durationMs === Infinity;
    const key = toastKey(message, extras);

    // Coalesce an identical repeat (same type and text) into the toast
    // already on screen instead of stacking a duplicate — five copies of the
    // same error show as one with a count.
    const existing = toasts.find((t) => t.type === type && t.message === key);
    if (existing !== undefined) {
      setText(existing.countEl, String(++existing.count));
      // Restart the window so the repeat gets its full read time; a toast
      // held by hover or focus only has its held time topped up.
      pauseEntry(existing);
      existing.remainingMs = durationMs;
      resume(existing);
      return () => removeToast(existing);
    }

    // Evict the oldest toast when at capacity, sparing sticky ones (they
    // persist until dismissed): with every slot sticky, a new auto-dismissing
    // toast is the one that gives way, and only a new sticky one displaces
    // the oldest sticky one.
    while (toasts.length >= MAX_TOASTS) {
      const victim = toasts.find((t) => !t.sticky) ?? (sticky ? toasts[0] : undefined);
      if (victim === undefined) return () => {};
      removeToast(victim);
    }

    // An auto-dismissing toast takes focus itself so the keyboard can hold it
    // too; a sticky toast's close button is its focus stop.
    const el = createElement("div", {
      class: `toast toast-${type}`,
      "data-testid": "toast",
      ...(sticky ? {} : { tabindex: "0" }),
    });

    appendToastBody(el, message, extras);

    // A coalesced duplicate fills this in; CSS hides it while empty.
    const countEl = createElement("span", { class: "toast-count" });
    el.appendChild(countEl);

    if (action !== undefined) {
      const btn = createElement("button", { class: "toast-action", type: "button" }, action.label);
      btn.addEventListener("click", () => {
        removeToast(entry);
        action.run();
      });
      el.appendChild(btn);
    }

    // Sticky toasts get a close button so they can be dismissed by hand.
    // Others clear themselves, so a button there would only add noise,
    // unless the caller asks for one.
    if (sticky || extras.closable === true) {
      // The aria-label names the button, so the glyph is never announced.
      const close = createElement(
        "button",
        { class: "toast-close", type: "button", "aria-label": shellText("toast.dismiss") },
        "\u00d7",
      );
      close.addEventListener("click", () => removeToast(entry));
      el.appendChild(close);
    }

    const entry: ToastEntry = {
      el,
      message: key,
      type,
      sticky,
      timer: null,
      remainingMs: durationMs,
      startedAt: 0,
      hovered: false,
      focused: false,
      count: 1,
      countEl,
    };

    // Pause the countdown while the user reads or reaches for the close
    // button. focusin/focusout bubble, so the toast hears them from the button.
    el.addEventListener("mouseenter", () => {
      entry.hovered = true;
      pauseEntry(entry);
    });
    el.addEventListener("mouseleave", () => {
      entry.hovered = false;
      resume(entry);
    });
    el.addEventListener("focusin", () => {
      entry.focused = true;
      pauseEntry(entry);
    });
    el.addEventListener("focusout", () => {
      entry.focused = false;
      resume(entry);
    });
    toasts.push(entry);
    place();
    syncCover();
    root.appendChild(el);
    startCoverWatch();
    resume(entry);

    // Trigger .show on the next frame so the CSS opacity transition plays
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        el.classList.add("show");
      });
    });
    return () => removeToast(entry);
  }

  function clear(): void {
    // oxlint-disable-next-line no-useless-spread -- snapshot needed: removeToast splices the array during iteration
    for (const entry of [...toasts]) {
      removeToast(entry);
    }
  }

  function mount(container: Element): void {
    // One polite live region for all toasts: screen readers announce
    // each toast as it is appended without interrupting current speech.
    // aria-atomic="false" so only the newly added toast is read, not the stack.
    root = createElement("div", {
      class: "toast-container",
      "data-testid": "toast-container",
      role: "status",
      "aria-live": "polite",
      "aria-atomic": "false",
    });
    container.appendChild(root);
  }

  function anchorTo(next: HTMLElement): void {
    anchorWatch?.destroy();
    anchor = next;
    const watch = new Disposable();
    anchorWatch = watch;
    // The composer grows with a reply bar, attachments or more lines; the
    // window and the on-screen keyboard move it.
    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(place);
      observer.observe(next);
      watch.addCleanup(() => observer.disconnect());
    }
    window.addEventListener("resize", place, { signal: watch.signal });
    window.visualViewport?.addEventListener("resize", place, { signal: watch.signal });
    place();
  }

  function destroy(): void {
    stopCoverWatch();
    anchorWatch?.destroy();
    anchorWatch = null;
    anchor = null;
    clear();
    if (root !== null) {
      root.remove();
      root = null;
    }
  }

  return { mount, destroy, show, clear, anchorTo };
}
