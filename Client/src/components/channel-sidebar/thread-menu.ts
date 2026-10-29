/**
 * The right-click menu of a followed thread's sidebar row: Mark as
 * Read and Unfollow. Opened by right-click or Shift+F10 / the Menu key, like the
 * channel menu; `lifetimeSignal` owns the menu itself so an unrelated re-render
 * does not close it.
 */

import { createMenuItem, openMenuOnKeyboard, openMenuShell } from "@lib/context-menu";
import { shellText } from "../../i18n/shell";

export interface ThreadMenuActions {
  /** Whether the row has unread messages or mentions, read when the menu opens. */
  readonly hasUnread: () => boolean;
  readonly onMarkRead: () => void;
  readonly onUnfollow: () => void;
}

export function attachThreadContextMenu(
  el: HTMLElement,
  actions: ThreadMenuActions,
  signal: AbortSignal,
  lifetimeSignal: AbortSignal,
): void {
  function openMenu(anchorX: number, anchorY: number): void {
    openMenuShell({
      x: anchorX,
      y: anchorY,
      className: "channel-ctx-menu",
      attrs: { "data-testid": "thread-context-menu" },
      signal: lifetimeSignal,
      dismiss: "any-click",
      build: (menu, closeMenu) => {
        const add = (label: string, testId: string, run: (() => void) | null): void => {
          const item = createMenuItem(
            label,
            run === null ? "context-menu-item disabled" : "context-menu-item",
            {
              testId,
            },
          );
          if (run === null) {
            item.setAttribute("aria-disabled", "true");
          } else {
            item.addEventListener(
              "click",
              () => {
                closeMenu();
                run();
              },
              { signal: lifetimeSignal },
            );
          }
          menu.appendChild(item);
        };
        add(
          shellText("channel.markRead"),
          "ctx-thread-mark-read",
          actions.hasUnread() ? actions.onMarkRead : null,
        );
        add(shellText("channel.threadUnfollow"), "ctx-thread-unfollow", actions.onUnfollow);
      },
    });
  }

  el.addEventListener(
    "contextmenu",
    (e) => {
      e.preventDefault();
      e.stopPropagation();
      openMenu(e.clientX, e.clientY);
    },
    { signal },
  );
  openMenuOnKeyboard(el, openMenu, signal);
}
