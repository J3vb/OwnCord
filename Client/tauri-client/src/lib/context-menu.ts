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

/**
 * Show a context menu at the given coordinates.
 * Automatically removes any existing menu with the same className.
 * Closes on click outside or when signal is aborted.
 */
export function showContextMenu(opts: ContextMenuOptions): void {
  const { x, y, items, signal, className } = opts;
  const menuClass = className ?? "context-menu";

  // Remove any existing context menu with same class
  document.querySelectorAll(`.${menuClass}`).forEach((el) => el.remove());

  const menu = createElement("div", { class: `context-menu ${menuClass}` });
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;

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
        item.onClick();
      },
      { signal },
    );
    menu.appendChild(el);
    hasSeparator = !item.danger;
  }

  document.body.appendChild(menu);

  // Close on click outside (deferred so the opening click doesn't immediately close)
  const dismissAc = new AbortController();
  setTimeout(() => {
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

  // Clean up if parent component is destroyed
  signal.addEventListener("abort", () => {
    menu.remove();
    dismissAc.abort();
  });
}
