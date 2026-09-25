import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createSidebarDrawer } from "../../src/pages/main-page/SidebarDrawer";
import type { SidebarDrawer } from "../../src/pages/main-page/SidebarDrawer";
import { setActiveChannel } from "@stores/channels.store";
import { openSettings, closeSettings } from "@stores/ui.store";

function setup(): { sidebar: HTMLElement; toggle: HTMLButtonElement; drawer: SidebarDrawer } {
  const app = document.createElement("div");
  document.body.appendChild(app);
  const sidebar = document.createElement("div");
  sidebar.id = "unified-sidebar";
  sidebar.className = "unified-sidebar";
  const button = document.createElement("button");
  app.append(sidebar, button);
  const toggle = button as HTMLButtonElement;
  const drawer = createSidebarDrawer({ sidebar, toggle });
  return { sidebar, toggle, drawer };
}

describe("SidebarDrawer", () => {
  let drawer: SidebarDrawer | null = null;

  beforeEach(() => {
    closeSettings();
    setActiveChannel(null);
  });

  afterEach(() => {
    drawer?.destroy();
    drawer = null;
    document.body.replaceChildren();
  });

  it("starts closed", () => {
    const s = setup();
    drawer = s.drawer;
    expect(s.sidebar.classList.contains("drawer-open")).toBe(false);
    expect(s.toggle.getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector(".sidebar-drawer-backdrop")?.classList.contains("open")).toBe(
      false,
    );
  });

  it("the toggle opens and exposes the open state", () => {
    const s = setup();
    drawer = s.drawer;
    s.toggle.click();
    expect(s.sidebar.classList.contains("drawer-open")).toBe(true);
    expect(s.toggle.getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelector(".sidebar-drawer-backdrop")?.classList.contains("open")).toBe(
      true,
    );
    // The button's accessible name now says what it does.
    expect(s.toggle.getAttribute("aria-label")).toBe("Close navigation");
  });

  it("moves focus into the drawer on open and back to the toggle on close", () => {
    const s = setup();
    drawer = s.drawer;
    const inside = document.createElement("button");
    s.sidebar.appendChild(inside);
    s.toggle.focus();
    s.toggle.click();
    expect(document.activeElement).toBe(inside);
    s.toggle.click();
    expect(document.activeElement).toBe(s.toggle);
  });

  it("closes on Escape", () => {
    const s = setup();
    drawer = s.drawer;
    s.toggle.click();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(s.sidebar.classList.contains("drawer-open")).toBe(false);
    expect(s.toggle.getAttribute("aria-expanded")).toBe("false");
  });

  it("closes on a pointer press outside", () => {
    const s = setup();
    drawer = s.drawer;
    s.toggle.click();
    document.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(s.sidebar.classList.contains("drawer-open")).toBe(false);
  });

  it("does not close on a pointer press inside", () => {
    const s = setup();
    drawer = s.drawer;
    s.toggle.click();
    s.sidebar.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(s.sidebar.classList.contains("drawer-open")).toBe(true);
  });

  it("closes when a destination is chosen and restores focus when it stayed inside", async () => {
    const s = setup();
    drawer = s.drawer;
    const inside = document.createElement("button");
    s.sidebar.appendChild(inside);
    s.toggle.focus();
    s.toggle.click();
    expect(document.activeElement).toBe(inside);
    // A channel row changes the active channel but moves no focus, so the
    // drawer sends focus to the toggle as the sidebar goes inert.
    setActiveChannel(42);
    await Promise.resolve();
    await Promise.resolve();
    expect(s.sidebar.classList.contains("drawer-open")).toBe(false);
    expect(document.activeElement).toBe(s.toggle);
  });

  it("leaves focus where a destination put it", async () => {
    const s = setup();
    drawer = s.drawer;
    const inside = document.createElement("button");
    s.sidebar.appendChild(inside);
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    s.toggle.click();
    // The destination moves focus itself before the store notification lands.
    outside.focus();
    setActiveChannel(42);
    await Promise.resolve();
    await Promise.resolve();
    expect(s.sidebar.classList.contains("drawer-open")).toBe(false);
    expect(document.activeElement).toBe(outside);
  });

  it("makes the closed drawer inert only while the window is narrow", () => {
    const width = Object.getOwnPropertyDescriptor(window, "innerWidth");
    const original = window.innerWidth;
    const setWidth = (value: number): void => {
      Object.defineProperty(window, "innerWidth", { configurable: true, value });
    };

    const s = setup();
    drawer = s.drawer;
    try {
      setWidth(640);
      window.dispatchEvent(new Event("resize"));
      expect(s.sidebar.inert).toBe(true);
      s.toggle.click();
      expect(s.sidebar.inert).toBe(false);
      setWidth(1000);
      window.dispatchEvent(new Event("resize"));
      expect(s.sidebar.inert).toBe(false);
    } finally {
      if (width !== undefined) Object.defineProperty(window, "innerWidth", width);
      else setWidth(original);
    }
  });

  it("closes when Settings opens (where My reports lives)", async () => {
    const s = setup();
    drawer = s.drawer;
    s.toggle.click();
    openSettings();
    await Promise.resolve();
    await Promise.resolve();
    expect(s.sidebar.classList.contains("drawer-open")).toBe(false);
  });

  it("closes on a click of a navigation row, even when it changes no store", () => {
    const s = setup();
    drawer = s.drawer;
    s.toggle.click();
    const row = document.createElement("div");
    row.className = "channel-item";
    row.dataset.channelId = "7";
    s.sidebar.appendChild(row);
    row.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(s.sidebar.classList.contains("drawer-open")).toBe(false);
  });

  it("destroy releases the document listeners and removes the backdrop", () => {
    const s = setup();
    s.drawer.destroy();
    const onKey = vi.fn();
    document.addEventListener("keydown", onKey);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    document.removeEventListener("keydown", onKey);
    expect(onKey).toHaveBeenCalledTimes(1);
    expect(document.querySelector(".sidebar-drawer-backdrop")).toBeNull();
  });
});
