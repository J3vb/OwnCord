/**
 * The right-click menu of a followed thread's sidebar row (WP 6.9c): Mark as
 * Read and Unfollow. Opened by right-click or Shift+F10 / the Menu key, like the
 * channel menu; `lifetimeSignal` owns the menu itself so an unrelated re-render
 * does not close it (OC-0282).
 */

import { Disposable } from "@lib/disposable";
import { createElement, setOwnedTimeout } from "@lib/dom";
import {
  createMenuItem,
  enableMenuKeyboard,
  openMenuOnKeyboard,
  clampMenuToViewport,
  registerSidebarMenu,
} from "@lib/context-menu";
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
    const menu = createElement("div", {
      class: "context-menu channel-ctx-menu",
      "data-testid": "thread-context-menu",
    });
    menu.style.left = `${anchorX}px`;
    menu.style.top = `${anchorY}px`;

    const menuOwner = new Disposable();
    const closeMenu = (): void => {
      unregister();
      menu.remove();
      menuOwner.destroy();
    };
    const unregister = registerSidebarMenu(closeMenu);

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

    document.body.appendChild(menu);
    clampMenuToViewport(menu, anchorX, anchorY);
    const restoreFocus = enableMenuKeyboard(menu, { signal: menuOwner.signal, onClose: closeMenu });
    menuOwner.addCleanup(restoreFocus);
    lifetimeSignal.addEventListener("abort", closeMenu, { signal: menuOwner.signal });
    setOwnedTimeout(
      menuOwner.signal,
      () => {
        document.addEventListener("click", closeMenu, { signal: menuOwner.signal });
      },
      0,
    );
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
