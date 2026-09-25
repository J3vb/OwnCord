import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createSidebarDrawer } from "../../src/pages/main-page/SidebarDrawer";
import type { SidebarDrawer } from "../../src/pages/main-page/SidebarDrawer";
import { setActiveChannel } from "@stores/channels.store";
import { openSettings, closeSettings } from "@stores/ui.store";
import { createModal } from "@lib/modalFactory";

/** A controllable `(max-width: 800px)` media query: jsdom has no matchMedia. */
class FakeMediaQueryList extends EventTarget {
  matches = false;
  readonly media = "(max-width: 800px)";
  set(matches: boolean): void {
    this.matches = matches;
    this.dispatchEvent(new Event("change"));
  }
}
let narrow: FakeMediaQueryList;

function setup(onOpen?: () => void): {
  sidebar: HTMLElement;
  toggle: HTMLButtonElement;
  drawer: SidebarDrawer;
} {
  const app = document.createElement("div");
  document.body.appendChild(app);
  const sidebar = document.createElement("div");
  sidebar.id = "unified-sidebar";
  sidebar.className = "unified-sidebar";
  const button = document.createElement("button");
  app.append(sidebar, button);
  const toggle = button as HTMLButtonElement;
  const drawer = createSidebarDrawer({ sidebar, toggle, ...(onOpen ? { onOpen } : {}) });
  return { sidebar, toggle, drawer };
}

describe("SidebarDrawer", () => {
  let drawer: SidebarDrawer | null = null;

  beforeEach(() => {
    closeSettings();
    setActiveChannel(null);
    narrow = new FakeMediaQueryList();
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => narrow),
    );
  });

  afterEach(() => {
    drawer?.destroy();
    drawer = null;
    document.body.replaceChildren();
    vi.unstubAllGlobals();
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

  it("closes on Escape pressed in the drawer", () => {
    const s = setup();
    drawer = s.drawer;
    const inside = document.createElement("button");
    s.sidebar.appendChild(inside);
    s.toggle.click();
    inside.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(s.sidebar.classList.contains("drawer-open")).toBe(false);
    expect(s.toggle.getAttribute("aria-expanded")).toBe("false");
  });

  it("closes on Escape pressed on the toggle", () => {
    const s = setup();
    drawer = s.drawer;
    s.toggle.click();
    s.toggle.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(s.sidebar.classList.contains("drawer-open")).toBe(false);
  });

  it("leaves Escape in a dialog opened from it to the dialog", () => {
    const s = setup();
    drawer = s.drawer;
    s.toggle.click();
    const field = document.createElement("input");
    const onClose = vi.fn();
    const modal = createModal({ content: field, onClose });
    field.focus();
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(s.sidebar.classList.contains("drawer-open")).toBe(true);
    expect(s.toggle.getAttribute("aria-expanded")).toBe("true");
    modal.destroy();
  });

  it("runs the open hook on open only", () => {
    const onOpen = vi.fn();
    const s = setup(onOpen);
    drawer = s.drawer;
    expect(onOpen).not.toHaveBeenCalled();
    s.toggle.click();
    expect(onOpen).toHaveBeenCalledTimes(1);
    s.toggle.click();
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("closes on a pointer press outside, on the backdrop", () => {
    const s = setup();
    drawer = s.drawer;
    s.toggle.focus();
    s.toggle.click();
    document
      .querySelector(".sidebar-drawer-backdrop")!
      .dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(s.sidebar.classList.contains("drawer-open")).toBe(false);
    expect(document.activeElement).toBe(s.toggle);
  });

  it("stays open, and leaves focus alone, for a press in a dialog opened from it", () => {
    const s = setup();
    drawer = s.drawer;
    s.toggle.click();
    // A dialog or menu the drawer opens is mounted on <body>, above the drawer.
    const dialog = document.createElement("div");
    const field = document.createElement("input");
    dialog.appendChild(field);
    document.body.appendChild(dialog);
    field.focus();
    dialog.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(s.sidebar.classList.contains("drawer-open")).toBe(true);
    expect(document.activeElement).toBe(field);
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

  it("makes the closed drawer inert only while the breakpoint query matches", () => {
    const s = setup();
    drawer = s.drawer;
    expect(s.sidebar.inert).toBe(false);
    narrow.set(true);
    expect(s.sidebar.inert).toBe(true);
    s.toggle.click();
    expect(s.sidebar.inert).toBe(false);
    narrow.set(false);
    expect(s.sidebar.inert).toBe(false);
    // Widening closed the drawer, so narrowing again leaves it shut and inert.
    expect(s.sidebar.classList.contains("drawer-open")).toBe(false);
    narrow.set(true);
    expect(s.sidebar.inert).toBe(true);
  });

  it("reads the breakpoint from the stylesheet's media query, not the window width", () => {
    // A zoomed 1601px window is 800.5 CSS px wide: innerWidth may report 800
    // while `(max-width: 800px)` does not match and the sidebar stays in flow.
    const width = Object.getOwnPropertyDescriptor(window, "innerWidth");
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 800 });
    try {
      const s = setup();
      drawer = s.drawer;
      expect(window.matchMedia).toHaveBeenCalledWith("(max-width: 800px)");
      expect(s.sidebar.inert).toBe(false);
    } finally {
      if (width !== undefined) Object.defineProperty(window, "innerWidth", width);
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
