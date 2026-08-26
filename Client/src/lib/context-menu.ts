/**
 * Shared context menu utility.
 * Creates a positioned context menu with items, handles click-outside
 * dismissal, and cleans up via AbortSignal.
 */

import { createElement } from "./dom";

export interface ContextMenuItem {
  readonly label: string;
  readonly onClick: () => void;
  readonly danger?: boolean;
  readonly testId?: string;
}

export interface ContextMenuOptions {
  readonly x: number;
  readonly y: number;
  readonly items: readonly ContextMenuItem[];
  /** AbortSignal for automatic cleanup when parent component is destroyed. */
  readonly signal: AbortSignal;
  /** CSS class added to the menu root (for styling/selection). */
  readonly className?: string;
}

// Tracks each open menu's per-invocation dismiss controller, so a menu swept
// away by a same-class reopen (see below) can release its own teardown
// listener on the caller's signal instead of leaving it pinned until the
// caller's signal eventually aborts.
const dismissControllers = new WeakMap<Element, AbortController>();

/**
 * Show a context menu at the given coordinates.
 * Automatically removes any existing menu with the same className.
 * Closes on click outside or when signal is aborted.
 */
export function showContextMenu(opts: ContextMenuOptions): void {
  const { x, y, items, signal, className } = opts;
  const menuClass = className ?? "context-menu";

  // Remove any existing context menu with same class, releasing its dismiss
  // controller so its teardown listener on the caller's signal is dropped
  // now rather than lingering until the caller itself is destroyed.
  document.querySelectorAll(`.${menuClass}`).forEach((el) => {
    dismissControllers.get(el)?.abort();
    el.remove();
  });

  const menu = createElement("div", { class: `context-menu ${menuClass}` });
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;

  const dismissAc = new AbortController();
  dismissControllers.set(menu, dismissAc);

  let hasSeparator = false;
  for (const item of items) {
    if (hasSeparator && item.danger) {
      menu.appendChild(createElement("div", { class: "context-menu-sep" }));
    }

    const attrs: Record<string, string> = {
      class: item.danger ? "context-menu-item danger" : "context-menu-item",
    };
    if (item.testId !== undefined) {
      attrs["data-testid"] = item.testId;
    }

    const el = createElement("div", attrs, item.label);
    el.addEventListener(
      "click",
      () => {
        menu.remove();
        dismissAc.abort();
        item.onClick();
      },
      { signal },
    );
    menu.appendChild(el);
    hasSeparator = !item.danger;
  }

  document.body.appendChild(menu);

  // Close on click outside (deferred so the opening click doesn't immediately close)
  setTimeout(() => {
    if (dismissAc.signal.aborted) return;
    document.addEventListener(
      "mousedown",
      (e: MouseEvent) => {
        if (!menu.contains(e.target as Node)) {
          menu.remove();
          dismissAc.abort();
        }
      },
      { signal: dismissAc.signal },
    );
  }, 0);

  // Clean up if parent component is destroyed. If the caller's signal is
  // already aborted, "abort" already fired and would never reach a listener
  // added now, so tear down immediately instead of registering one. When it
  // isn't, tie the listener's own lifetime to dismissAc: once the menu is
  // dismissed some other way (item click, outside click), dismissAc aborts
  // and this listener is dropped from the caller's signal instead of
  // lingering — with its closure over `menu` — for the rest of the caller's
  // lifetime.
  if (signal.aborted) {
    menu.remove();
    dismissAc.abort();
  } else {
    signal.addEventListener(
      "abort",
      () => {
        menu.remove();
        dismissAc.abort();
      },
      { once: true, signal: dismissAc.signal },
    );
  }
}
