/**
 * Toast notification system — shows stacking notifications at bottom-right.
 * Supports info, error, and success types with auto-dismiss.
 */

import { createElement, setText } from "@lib/dom";
import type { MountableComponent } from "@lib/safe-render";

export type ToastType = "info" | "error" | "success";

const MAX_TOASTS = 5;
const DEFAULT_DURATION_MS = 5000;

interface ToastEntry {
  readonly el: HTMLDivElement;
  readonly timer: ReturnType<typeof setTimeout>;
}

export interface ToastContainer extends MountableComponent {
  show(message: string, type?: ToastType, durationMs?: number): void;
  clear(): void;
}

export function createToastContainer(): ToastContainer {
  let root: HTMLDivElement | null = null;
  const toasts: ToastEntry[] = [];

  function removeToast(entry: ToastEntry): void {
    const idx = toasts.indexOf(entry);
    if (idx === -1) return;

    clearTimeout(entry.timer);
    toasts.splice(idx, 1);

    if (entry.el.parentNode !== null) {
      entry.el.remove();
    }
  }

  function show(
    message: string,
    type: ToastType = "info",
    durationMs: number = DEFAULT_DURATION_MS,
  ): void {
    if (root === null) return;

    // Evict oldest toasts when at capacity
    while (toasts.length >= MAX_TOASTS) {
      const oldest = toasts[0];
      if (oldest !== undefined) {
        removeToast(oldest);
      }
    }

    const el = createElement("div", {
      class: `toast toast-${type}`,
    });
    setText(el, message);

    const timer = setTimeout(() => {
      const entry = toasts.find((t) => t.el === el);
      if (entry !== undefined) {
        removeToast(entry);
      }
    }, durationMs);

    const entry: ToastEntry = { el, timer };
    toasts.push(entry);
    root.appendChild(el);
  }

  function clear(): void {
    for (const entry of [...toasts]) {
      removeToast(entry);
    }
  }

  function mount(container: Element): void {
    root = createElement("div", { class: "toast-container" });
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
