/**
 * Toast notification system — shows stacking notifications at bottom-centre.
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
  entry.remainingMs = Math.max(0, entry.remainingMs - (Date.now() - entry.startedAt));
}

export function createToastContainer(): ToastContainer {
  let root: HTMLDivElement | null = null;
  const toasts: ToastEntry[] = [];

  function removeToast(entry: ToastEntry): void {
    const idx = toasts.indexOf(entry);
    if (idx === -1) return;

    if (entry.timer !== null) clearTimeout(entry.timer);
    toasts.splice(idx, 1);

    // Remove .show first and wait for the CSS opacity transition to finish
    entry.el.classList.remove("show");
    entry.el.addEventListener(
      "transitionend",
      () => {
        if (entry.el.parentNode !== null) {
          entry.el.remove();
        }
      },
      { once: true },
    );

    // Fallback removal in case transitionend never fires
    setTimeout(() => {
      if (entry.el.parentNode !== null) {
        entry.el.remove();
      }
    }, 400);
  }

  function armTimer(entry: ToastEntry, durationMs: number): void {
    if (entry.type === "error") return; // errors persist until dismissed
    entry.remainingMs = durationMs;
    entry.startedAt = Date.now();
    entry.timer = setTimeout(() => {
      const current = toasts.find((t) => t.el === entry.el);
      if (current !== undefined) removeToast(current);
    }, durationMs);
  }

  /** Resume a paused auto-dismissing toast with its held time. */
  function resume(entry: ToastEntry): void {
    if (entry.type === "error" || entry.timer !== null) return;
    entry.startedAt = Date.now();
    entry.timer = setTimeout(() => {
      const current = toasts.find((t) => t.el === entry.el);
      if (current !== undefined) removeToast(current);
    }, entry.remainingMs);
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
      existing.count++;
      setText(existing.countEl, String(existing.count));
      existing.countEl.hidden = false;
      // Restart the window so the repeat gets its full read time.
      if (existing.timer !== null) clearTimeout(existing.timer);
      existing.timer = null;
      armTimer(existing, durationMs);
      return;
    }

    // Evict oldest toasts when at capacity
    while (toasts.length >= MAX_TOASTS) {
      const oldest = toasts[0];
      if (oldest !== undefined) {
        removeToast(oldest);
      }
    }

    const el = createElement("div", {
      class: `toast toast-${type}`,
      "data-testid": "toast",
    });

    const text = createElement("span", { class: "toast-text" });
    setText(text, message);
    el.appendChild(text);

    // A coalesced duplicate bumps this; hidden until then.
    const countEl = createElement("span", {
      class: "toast-count",
      "data-testid": "toast-count",
    });
    countEl.hidden = true;
    el.appendChild(countEl);

    // Errors get a close button so they can be dismissed by hand. Other types
    // clear themselves, so a button there would only add noise.
    if (type === "error") {
      const close = createElement("button", {
        class: "toast-close",
        type: "button",
        "aria-label": shellText("toast.dismiss"),
      });
      close.appendChild(createElement("span", { "aria-hidden": "true" }, "\u00d7"));
      el.appendChild(close);
    }

    const entry: ToastEntry = {
      el,
      message,
      type,
      timer: null,
      remainingMs: durationMs,
      startedAt: 0,
      count: 1,
      countEl,
    };

    // Pause the countdown while the user reads or reaches for the close
    // button. focusin/focusout bubble, so the toast hears them from the button.
    el.addEventListener("mouseenter", () => pauseEntry(entry));
    el.addEventListener("mouseleave", () => resume(entry));
    el.addEventListener("focusin", () => pauseEntry(entry));
    el.addEventListener("focusout", () => resume(entry));
    if (type === "error") {
      el.querySelector(".toast-close")!.addEventListener("click", () => removeToast(entry));
    }

    toasts.push(entry);
    root.appendChild(el);
    armTimer(entry, durationMs);

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
