/**
 * Toast notification system — shows stacking notifications at top-centre.
 * Supports info, error, success and warning types with auto-dismiss.
 *
 * Errors are the exception: they stay until dismissed, because a message
 * that vanishes before it can be read or acted on is worse than none at all.
 * Every toast pauses its auto-dismiss countdown while hovered or focused, and
 * an identical repeat coalesces into the existing toast with a count instead
 * of stacking a duplicate.
 */

import { createElement, setText } from "@lib/dom";
import type { MountableComponent } from "@lib/safe-render";
import { shellText } from "../i18n/shell";

export type ToastType = "info" | "error" | "success" | "warning";

const MAX_TOASTS = 5;
const DEFAULT_DURATION_MS = 5000;

interface ToastEntry {
  readonly el: HTMLDivElement;
  readonly message: string;
  readonly type: ToastType;
  /** Auto-dismiss timer; null for an error (persists) or a paused toast. */
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
  show(message: string, type?: ToastType, durationMs?: number): void;
  clear(): void;
}

/** Freeze an auto-dismissing toast, holding the time it has left. A module
 *  function so it is not re-created per container. */
function pauseEntry(entry: ToastEntry): void {
  if (entry.timer === null) return;
  clearTimeout(entry.timer);
  entry.timer = null;
  entry.remainingMs -= Date.now() - entry.startedAt;
}

export function createToastContainer(): ToastContainer {
  let root: HTMLDivElement | null = null;
  const toasts: ToastEntry[] = [];

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
   *  it is an error (persists until dismissed) or held by hover or focus. */
  function resume(entry: ToastEntry): void {
    if (entry.type === "error" || entry.timer !== null) return;
    if (entry.hovered || entry.focused) return;
    entry.startedAt = Date.now();
    entry.timer = setTimeout(() => removeToast(entry), entry.remainingMs);
  }

  function show(
    message: string,
    type: ToastType = "info",
    durationMs: number = DEFAULT_DURATION_MS,
  ): void {
    if (root === null) return;

    // Coalesce an identical repeat (same type and text) into the toast
    // already on screen instead of stacking a duplicate — five copies of the
    // same error show as one with a count.
    const existing = toasts.find((t) => t.type === type && t.message === message);
    if (existing !== undefined) {
      setText(existing.countEl, String(++existing.count));
      // Restart the window so the repeat gets its full read time; a toast
      // held by hover or focus only has its held time topped up.
      pauseEntry(existing);
      existing.remainingMs = durationMs;
      resume(existing);
      return;
    }

    // Evict the oldest toast when at capacity, sparing errors (they persist
    // until dismissed): with every slot an error, a new non-error is the one
    // that gives way, and only a new error displaces the oldest error.
    while (toasts.length >= MAX_TOASTS) {
      const victim =
        toasts.find((t) => t.type !== "error") ?? (type === "error" ? toasts[0] : undefined);
      if (victim === undefined) return;
      removeToast(victim);
    }

    // An auto-dismissing toast takes focus itself so the keyboard can hold it
    // too; an error's close button is its focus stop.
    const el = createElement("div", {
      class: `toast toast-${type}`,
      "data-testid": "toast",
      ...(type === "error" ? {} : { tabindex: "0" }),
    });

    el.appendChild(createElement("span", { class: "toast-text" }, message));

    // A coalesced duplicate fills this in; CSS hides it while empty.
    const countEl = createElement("span", { class: "toast-count" });
    el.appendChild(countEl);

    // Errors get a close button so they can be dismissed by hand. Other types
    // clear themselves, so a button there would only add noise.
    if (type === "error") {
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
      message,
      type,
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
    root.appendChild(el);
    resume(entry);

    // Trigger .show on the next frame so the CSS opacity transition plays
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        el.classList.add("show");
      });
    });
  }

  function clear(): void {
    // oxlint-disable-next-line no-useless-spread -- snapshot needed: removeToast splices the array during iteration
    for (const entry of [...toasts]) {
      removeToast(entry);
    }
  }

  function mount(container: Element): void {
    // One polite live region for all toasts (DC-13): screen readers announce
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

  function destroy(): void {
    clear();
    if (root !== null) {
      root.remove();
      root = null;
    }
  }

  return { mount, destroy, show, clear };
}
