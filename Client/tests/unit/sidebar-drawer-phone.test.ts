import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSidebarDrawer } from "../../src/pages/main-page/SidebarDrawer";
import type { SidebarDrawer } from "../../src/pages/main-page/SidebarDrawer";
import { setActiveChannel } from "@stores/channels.store";
import { closeSettings } from "@stores/ui.store";
import { closeBottomSheet, openBottomSheet } from "@lib/ui/bottomSheet";

const ANDROID_UA = "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 Chrome/140.0";

class FakeMediaQueryList extends EventTarget {
  matches = false;
  set(matches: boolean): void {
    this.matches = matches;
    this.dispatchEvent(new Event("change"));
  }
}

let narrow: FakeMediaQueryList;
let phone: { matches: boolean };

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}
async function pressBack(): Promise<void> {
  history.back();
  await settle();
}
const guarded = (): boolean => {
  const state: unknown = history.state;
  return typeof state === "object" && state !== null && "owncordBack" in state;
};

function setAndroid(on: boolean): void {
  if (on) {
    vi.stubGlobal("__TAURI_INTERNALS__", {});
    Object.defineProperty(navigator, "userAgent", { value: ANDROID_UA, configurable: true });
  }
}

interface Setup {
  readonly sidebar: HTMLElement;
  readonly toggle: HTMLButtonElement;
  readonly rail: HTMLElement;
  readonly drawer: SidebarDrawer;
  readonly onSearch: ReturnType<typeof vi.fn>;
}

function setup(withRail = true, withSearch = true): Setup {
  const app = document.createElement("div");
  document.body.appendChild(app);
  const rail = document.createElement("div");
  rail.className = "server-rail-slot";
  rail.innerHTML = '<button id="rail-btn">S</button>';
  const sidebar = document.createElement("div");
  sidebar.id = "unified-sidebar";
  sidebar.className = "unified-sidebar";
  sidebar.innerHTML =
    '<div class="unified-sidebar-header"><button class="server-name">Server</button></div><div id="list"></div>';
  const toggle = document.createElement("button");
  app.append(rail, sidebar, toggle);
  const onSearch = vi.fn();
  const drawer = createSidebarDrawer({
    sidebar,
    toggle,
    ...(withRail ? { rail } : {}),
    ...(withSearch ? { onSearch } : {}),
  });
  return { sidebar, toggle, rail, drawer, onSearch };
}

/** Narrow, coarse-pointer viewport with a clean settings and channel state. */
function stubPhoneViewport(): void {
  closeSettings();
  setActiveChannel(null);
  narrow = new FakeMediaQueryList();
  narrow.matches = true;
  phone = { matches: true };
  vi.stubGlobal(
    "matchMedia",
    vi.fn((q: string) => (q.includes("pointer: coarse") ? phone : narrow)),
  );
}

function openOneButtonSheet() {
  const content = document.createElement("div");
  content.innerHTML = "<button>One</button>";
  return openBottomSheet({ label: "Sheet", content });
}

describe("the drawer on a phone", () => {
  let drawer: SidebarDrawer | null = null;

  beforeEach(() => {
    stubPhoneViewport();
  });

  afterEach(async () => {
    closeBottomSheet();
    drawer?.destroy();
    drawer = null;
    await settle();
    document.body.replaceChildren();
    vi.unstubAllGlobals();
    delete (navigator as { userAgent?: string }).userAgent;
  });

  describe("server rail", () => {
    it("shows the rail's slot with the drawer and hides it again on close", () => {
      const s = setup();
      drawer = s.drawer;
      expect(s.rail.classList.contains("drawer-open")).toBe(false);
      s.toggle.click();
      expect(s.rail.classList.contains("drawer-open")).toBe(true);
      expect(s.sidebar.classList.contains("drawer-open")).toBe(true);
      s.toggle.click();
      expect(s.rail.classList.contains("drawer-open")).toBe(false);
    });

    it("puts the backdrop under the rail, so the rail is not dimmed", () => {
      const s = setup();
      drawer = s.drawer;
      const backdrop = document.querySelector(".sidebar-drawer-backdrop")!;
      expect(backdrop.nextElementSibling).toBe(s.rail);
      expect(s.rail.nextElementSibling).toBe(s.sidebar);
    });

    it("closes on Escape pressed in the rail", () => {
      const s = setup();
      drawer = s.drawer;
      s.toggle.click();
      s.rail
        .querySelector("button")!
        .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      expect(s.sidebar.classList.contains("drawer-open")).toBe(false);
      expect(s.rail.classList.contains("drawer-open")).toBe(false);
    });

    it("works without a rail (the web portal has none)", () => {
      const s = setup(false);
      drawer = s.drawer;
      s.toggle.click();
      expect(s.sidebar.classList.contains("drawer-open")).toBe(true);
      expect(s.rail.classList.contains("drawer-open")).toBe(false);
      const backdrop = document.querySelector(".sidebar-drawer-backdrop")!;
      expect(backdrop.nextElementSibling).toBe(s.sidebar);
    });

    it("destroy takes the slot out of the drawer's layer", () => {
      const s = setup();
      s.toggle.click();
      s.drawer.destroy();
      expect(s.rail.classList.contains("drawer-open")).toBe(false);
    });
  });

  describe("search", () => {
    it("adds a full-width button under the server name", () => {
      const s = setup();
      drawer = s.drawer;
      const button = s.sidebar.querySelector<HTMLButtonElement>(
        '[data-testid="sidebar-drawer-search"]',
      )!;
      expect(button.textContent).toBe("Find or start a conversation");
      expect(button.previousElementSibling?.classList.contains("unified-sidebar-header")).toBe(
        true,
      );
      expect(button.type).toBe("button");
    });

    it("opens the quick switcher, with the drawer already closed", () => {
      const s = setup();
      drawer = s.drawer;
      s.toggle.click();
      const closedWhenCalled: boolean[] = [];
      s.onSearch.mockImplementation(() => {
        closedWhenCalled.push(!s.sidebar.classList.contains("drawer-open"));
      });
      s.sidebar.querySelector<HTMLButtonElement>('[data-testid="sidebar-drawer-search"]')!.click();
      expect(s.onSearch).toHaveBeenCalledTimes(1);
      expect(closedWhenCalled).toEqual([true]);
      expect(s.toggle.getAttribute("aria-expanded")).toBe("false");
    });

    it("is not added without a switcher to open, and destroy removes it", () => {
      const without = setup(true, false);
      expect(without.sidebar.querySelector('[data-testid="sidebar-drawer-search"]')).toBeNull();
      without.drawer.destroy();
      document.body.replaceChildren();
      const s = setup();
      s.drawer.destroy();
      expect(s.sidebar.querySelector('[data-testid="sidebar-drawer-search"]')).toBeNull();
    });
  });

  describe("Back", () => {
    it("closes a drawer opened with the menu button", async () => {
      const s = setup();
      drawer = s.drawer;
      s.toggle.click();
      expect(guarded()).toBe(true);
      await pressBack();
      expect(s.sidebar.classList.contains("drawer-open")).toBe(false);
      expect(guarded()).toBe(false);
    });

    it("closes the sheet on top first, then the drawer, one Back each", async () => {
      const s = setup();
      drawer = s.drawer;
      s.toggle.click();
      const sheet = openOneButtonSheet();
      await pressBack();
      expect(sheet.signal.aborted).toBe(true);
      expect(s.sidebar.classList.contains("drawer-open")).toBe(true);
      await pressBack();
      expect(s.sidebar.classList.contains("drawer-open")).toBe(false);
      expect(guarded()).toBe(false);
    });

    it("does not pop twice when the drawer closes another way", async () => {
      const s = setup();
      drawer = s.drawer;
      const back = vi.spyOn(history, "back");
      s.toggle.click();
      s.toggle.click();
      await settle();
      expect(back).toHaveBeenCalledTimes(1);
      expect(guarded()).toBe(false);
    });

    it("a phone browser keeps no entry while the drawer is closed", async () => {
      const s = setup();
      drawer = s.drawer;
      expect(guarded()).toBe(false);
      s.toggle.click();
      s.toggle.click();
      await settle();
      expect(guarded()).toBe(false);
    });

    it("a narrow window that is not a phone has no Back handling", async () => {
      phone.matches = false;
      const s = setup();
      drawer = s.drawer;
      s.toggle.click();
      expect(s.sidebar.classList.contains("drawer-open")).toBe(true);
      expect(guarded()).toBe(false);
    });

    describe("turned sideways, where the width is past the narrow breakpoint", () => {
      beforeEach(() => {
        // 915 x 412: not under 800 px wide, but a phone all the same.
        narrow.matches = false;
      });

      it("still collapses the sidebar into the drawer: inert while closed, a toggle that opens it", () => {
        const s = setup();
        drawer = s.drawer;
        expect(s.sidebar.inert).toBe(true);
        expect(s.toggle.getAttribute("aria-expanded")).toBe("false");
        s.toggle.click();
        expect(s.sidebar.classList.contains("drawer-open")).toBe(true);
        expect(s.sidebar.inert).toBe(false);
        expect(s.rail.classList.contains("drawer-open")).toBe(true);
        s.toggle.click();
        expect(s.sidebar.inert).toBe(true);
      });

      it("puts the sidebar back in flow when the phone is turned upright to a wide window, and drops the drawer", () => {
        const s = setup();
        drawer = s.drawer;
        s.toggle.click();
        expect(s.drawer.isOpen()).toBe(true);
        phone.matches = false;
        window.dispatchEvent(new Event("resize"));
        expect(s.drawer.isOpen()).toBe(false);
        expect(s.sidebar.inert).toBe(false);
        expect(s.sidebar.classList.contains("drawer-open")).toBe(false);
      });

      it("collapses when a wide window turns into the sideways phone", () => {
        phone.matches = false;
        const s = setup();
        drawer = s.drawer;
        expect(s.sidebar.inert).toBe(false);
        phone.matches = true;
        window.dispatchEvent(new Event("resize"));
        expect(s.sidebar.inert).toBe(true);
      });
    });

    it("opens through open() and closes through close() like the menu does", async () => {
      const s = setup();
      drawer = s.drawer;
      s.drawer.open();
      expect(s.drawer.isOpen()).toBe(true);
      expect(guarded()).toBe(true);
      await pressBack();
      expect(s.drawer.isOpen()).toBe(false);
      s.drawer.open();
      s.drawer.close();
      expect(s.drawer.isOpen()).toBe(false);
    });
  });
});

describe("the drawer in the Android app", () => {
  let drawer: SidebarDrawer | null = null;

  beforeEach(() => {
    stubPhoneViewport();
    setAndroid(true);
  });

  afterEach(async () => {
    drawer?.destroy();
    drawer = null;
    await settle();
    document.body.replaceChildren();
    vi.unstubAllGlobals();
    delete (navigator as { userAgent?: string }).userAgent;
  });

  it("holds a guard entry while the drawer is closed", () => {
    const s = setup();
    drawer = s.drawer;
    expect(guarded()).toBe(true);
  });

  it("Back from a chat opens the drawer, and a further Back is left to the system", async () => {
    const s = setup();
    drawer = s.drawer;
    await pressBack();
    expect(s.sidebar.classList.contains("drawer-open")).toBe(true);
    expect(s.rail.classList.contains("drawer-open")).toBe(true);
    // No entry is left: the next Back is not ours (the app leaves).
    expect(guarded()).toBe(false);
    await pressBack();
    expect(s.sidebar.classList.contains("drawer-open")).toBe(true);
  });

  it("puts the guard back after a channel is reached from the drawer", async () => {
    const s = setup();
    drawer = s.drawer;
    await pressBack();
    expect(guarded()).toBe(false);
    setActiveChannel(5);
    await settle();
    expect(s.sidebar.classList.contains("drawer-open")).toBe(false);
    expect(guarded()).toBe(true);
    await pressBack();
    expect(s.sidebar.classList.contains("drawer-open")).toBe(true);
  });

  it("puts the guard back when the drawer Back opened is dismissed", async () => {
    const s = setup();
    drawer = s.drawer;
    await pressBack();
    s.sidebar.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await settle();
    expect(s.sidebar.classList.contains("drawer-open")).toBe(false);
    expect(guarded()).toBe(true);
  });

  it("a drawer opened with the menu button closes on Back and leaves the guard intact", async () => {
    const s = setup();
    drawer = s.drawer;
    s.toggle.click();
    expect(guarded()).toBe(true);
    await pressBack();
    expect(s.sidebar.classList.contains("drawer-open")).toBe(false);
    // Back to the chat, with its guard: the next Back opens the drawer again.
    expect(guarded()).toBe(true);
    await pressBack();
    expect(s.sidebar.classList.contains("drawer-open")).toBe(true);
  });

  it("does not push a second entry for the menu button over the guard", () => {
    const s = setup();
    drawer = s.drawer;
    const push = vi.spyOn(history, "pushState");
    s.toggle.click();
    s.toggle.click();
    expect(push).not.toHaveBeenCalled();
  });

  it("a sheet over the guarded chat closes on Back and the chat keeps its guard", async () => {
    const s = setup();
    drawer = s.drawer;
    const sheet = openOneButtonSheet();
    await pressBack();
    expect(sheet.signal.aborted).toBe(true);
    expect(s.sidebar.classList.contains("drawer-open")).toBe(false);
    expect(guarded()).toBe(true);
  });

  it("has no guard in a wide window", async () => {
    phone.matches = false;
    const s = setup();
    drawer = s.drawer;
    expect(guarded()).toBe(false);
  });

  it("drops the guard when the window stops being a phone, and raises it when it becomes one", async () => {
    const s = setup();
    drawer = s.drawer;
    expect(guarded()).toBe(true);
    phone.matches = false;
    narrow.set(false);
    await settle();
    expect(guarded()).toBe(false);
    phone.matches = true;
    narrow.set(true);
    await settle();
    expect(guarded()).toBe(true);
  });

  it("destroy lets the guard go", async () => {
    const s = setup();
    s.drawer.destroy();
    await settle();
    expect(guarded()).toBe(false);
  });
});
