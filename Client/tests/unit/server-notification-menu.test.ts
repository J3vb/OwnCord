/**
 * U1(b): a per-server notification-level override, offered from the server
 * header's context menu. "Follow global setting" clears the override.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { attachServerNotificationMenu } from "@components/server-notification-menu";
import {
  getServerNotificationLevel,
  getGlobalNotificationLevel,
  setNotificationLevelHost,
  setGlobalNotificationLevel,
  setServerNotificationLevel,
} from "@lib/notificationLevel";

let container: HTMLDivElement;
let ac: AbortController;

beforeEach(() => {
  localStorage.clear();
  setNotificationLevelHost("a.example");
  container = document.createElement("div");
  document.body.appendChild(container);
  ac = new AbortController();
});

afterEach(() => {
  ac.abort();
  container.remove();
  document.querySelectorAll(".server-notif-menu").forEach((el) => el.remove());
});

function openMenu(): HTMLElement {
  const el = document.createElement("div");
  container.appendChild(el);
  attachServerNotificationMenu(el, ac.signal, ac.signal);
  el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 4, clientY: 4 }));
  return el;
}

function item(testId: string): HTMLElement {
  return document.querySelector<HTMLElement>(`[data-testid='${testId}']`)!;
}

describe("server notification-level menu", () => {
  it("offers a per-server override with All, Mentions only and Nothing", () => {
    openMenu();
    expect(item("server-notif-all")).not.toBeNull();
    expect(item("server-notif-mentions")).not.toBeNull();
    expect(item("server-notif-nothing")).not.toBeNull();
    expect(item("server-notif-default")).not.toBeNull();
  });

  it("sets the server override on click", () => {
    openMenu();
    item("server-notif-nothing").click();
    expect(getServerNotificationLevel()).toBe("nothing");
  });

  it("clears the override with Follow global", () => {
    setServerNotificationLevel("all");
    setGlobalNotificationLevel("mentions");
    openMenu();
    item("server-notif-default").click();
    expect(getServerNotificationLevel()).toBeNull();
    expect(getGlobalNotificationLevel()).toBe("mentions");
  });

  it("checks Follow global when no override is set", () => {
    setGlobalNotificationLevel("mentions");
    openMenu();
    expect(item("server-notif-default").getAttribute("aria-checked")).toBe("true");
    expect(item("server-notif-mentions").getAttribute("aria-checked")).toBe("false");
    expect(item("server-notif-all").getAttribute("aria-checked")).toBe("false");
    expect(item("server-notif-nothing").getAttribute("aria-checked")).toBe("false");
  });

  it("marks only the override when one is set", () => {
    setGlobalNotificationLevel("mentions");
    setServerNotificationLevel("nothing");
    openMenu();
    expect(item("server-notif-nothing").getAttribute("aria-checked")).toBe("true");
    expect(item("server-notif-default").getAttribute("aria-checked")).toBe("false");
    expect(item("server-notif-mentions").getAttribute("aria-checked")).toBe("false");
  });
});
