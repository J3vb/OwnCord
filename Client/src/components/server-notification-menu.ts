/**
 * Per-server notification-level menu — right-click (or Shift+F10) the server
 * header to set what this one server may interrupt with, overriding the global
 * level in Settings › Notifications.
 *
 * "Follow global setting" is the default and clears the override; the other
 * three set an explicit per-server value so one noisy community can be muted
 * without quieting every other server. The override is stored against the
 * connected host (see @lib/notificationLevel), so leaving the server and
 * switching back restores the same choice.
 */

import { Disposable } from "@lib/disposable";
import { createElement, setOwnedTimeout } from "@lib/dom";
import { createMenuItem, enableMenuKeyboard, openMenuOnKeyboard } from "@lib/context-menu";
import {
  clearServerNotificationLevel,
  getServerNotificationLevel,
  setServerNotificationLevel,
  type NotificationLevel,
} from "@lib/notificationLevel";
import { shellText as t } from "../i18n/shell";

/**
 * Attach the context menu to `el` (the server header). `signal` owns the
 * row-level listener; `lifetimeSignal` owns everything inside the opened menu,
 * which is mounted on document.body and must outlive an unrelated re-render
 * (the same split the channel context menu uses, OC-0282).
 */
export function attachServerNotificationMenu(
  el: HTMLElement,
  signal: AbortSignal,
  lifetimeSignal: AbortSignal,
): void {
  function openMenu(anchorX: number, anchorY: number): void {
    document.querySelectorAll(".server-notif-menu").forEach((prev) => prev.remove());

    const menu = createElement("div", {
      class: "context-menu server-notif-menu",
      "data-testid": "server-notification-menu",
    });
    menu.style.left = `${anchorX}px`;
    menu.style.top = `${anchorY}px`;

    const menuOwner = new Disposable();
    const closeMenu = (): void => {
      menu.remove();
      menuOwner.destroy();
    };

    const header = createElement(
      "div",
      { class: "context-menu-label", "data-testid": "server-notif-heading" },
      t("server.notifications"),
    );
    menu.appendChild(header);
    menu.appendChild(createElement("div", { class: "context-menu-sep" }));

    const override = getServerNotificationLevel();

    const addLevel = (
      label: string,
      testId: string,
      checked: boolean,
      onClick: () => void,
    ): void => {
      const item = createMenuItem(label, "context-menu-item", { testId });
      item.setAttribute("role", "menuitemradio");
      item.setAttribute("aria-checked", String(checked));
      item.addEventListener(
        "click",
        () => {
          closeMenu();
          onClick();
        },
        { signal: lifetimeSignal },
      );
      menu.appendChild(item);
    };

    addLevel(
      t("server.notifications.followGlobal"),
      "server-notif-default",
      override === null,
      () => clearServerNotificationLevel(),
    );

    const levels: ReadonlyArray<{ level: NotificationLevel; label: string; testId: string }> = [
      { level: "all", label: t("server.notifications.all"), testId: "server-notif-all" },
      {
        level: "mentions",
        label: t("server.notifications.mentions"),
        testId: "server-notif-mentions",
      },
      {
        level: "nothing",
        label: t("server.notifications.nothing"),
        testId: "server-notif-nothing",
      },
    ];
    for (const { level, label, testId } of levels) {
      addLevel(label, testId, override === level, () => setServerNotificationLevel(level));
    }

    document.body.appendChild(menu);

    const restoreFocus = enableMenuKeyboard(menu, {
      signal: menuOwner.signal,
      onClose: closeMenu,
    });
    menuOwner.addCleanup(restoreFocus);

    // The menu is anchored to the header, not a row; keep it mounted across
    // unrelated sidebar re-renders and close it only with the sidebar itself.
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
