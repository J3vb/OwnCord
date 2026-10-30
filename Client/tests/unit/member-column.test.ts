import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMemberColumn, type MemberColumn } from "../../src/pages/main-page/MemberColumn";
import type { MemberPanel } from "../../src/features/members/memberPanel";
import { channelsStore, type Channel } from "../../src/stores/channels.store";
import { uiStore } from "../../src/stores/ui.store";
import { savePref } from "../../src/lib/prefs/preferences";
import {
  MEMBER_LAYOUT_PREF,
  MEMBER_OPEN_PREF,
  MEMBER_WIDTH_PREF,
} from "../../src/features/members/memberLayout";

/** A controllable `(max-width: 899px)` media query: jsdom has no matchMedia. */
class FakeMediaQueryList extends EventTarget {
  matches = false;
  readonly media = "(max-width: 899px)";
  set(matches: boolean): void {
    this.matches = matches;
    this.dispatchEvent(new Event("change"));
  }
}

function channel(id: number, type: "text" | "voice" | "dm" | "announcement"): Channel {
  return {
    isPrivate: false,
    voiceMaxUsers: 0,
    voiceMaxVideo: 0,
    id,
    name: `c${id}`,
    type,
    category: null,
    position: 0,
    unreadCount: 0,
    mentionCount: 0,
    lastMessageId: null,
    canSend: true,
    topic: "",
    slowMode: 0,
    nsfw: false,
  };
}

function setActive(id: number | null): void {
  channelsStore.setState((prev) => ({
    ...prev,
    channels: new Map([
      [1, channel(1, "text")],
      [2, channel(2, "dm")],
      [3, channel(3, "announcement")],
    ]),
    activeChannelId: id,
  }));
  channelsStore.flush();
}

describe("MemberColumn", () => {
  let column: HTMLElement;
  let body: HTMLElement;
  let button: HTMLButtonElement;
  let buildPanel: ReturnType<typeof vi.fn<() => MemberPanel>>;
  let panels: Array<{ element: HTMLDivElement; destroy: ReturnType<typeof vi.fn> }>;
  let fallbackFocus: ReturnType<typeof vi.fn<() => HTMLElement | null>>;
  let ctrl: MemberColumn;

  function make(): MemberColumn {
    return createMemberColumn({ column, body, button, buildPanel, fallbackFocus });
  }

  beforeEach(() => {
    localStorage.clear();
    uiStore.setState((prev) => ({ ...prev, sidebarMode: "channels", activeView: null }));
    uiStore.flush();
    setActive(1);
    column = document.createElement("aside");
    column.hidden = true;
    body = document.createElement("div");
    column.appendChild(body);
    button = document.createElement("button");
    button.hidden = true;
    document.body.append(column, button);
    panels = [];
    buildPanel = vi.fn(() => {
      const element = document.createElement("div");
      element.dataset["testid"] = "member-list";
      const panel = { element, destroy: vi.fn() };
      panels.push(panel);
      return panel;
    });
    fallbackFocus = vi.fn(() => null);
    savePref(MEMBER_LAYOUT_PREF, "right");
  });

  afterEach(() => {
    ctrl?.destroy();
    column.remove();
    button.remove();
  });

  describe("shown only for right layout + guild channel + open + no content view", () => {
    const cases: Array<{
      name: string;
      arrange: () => void;
      shown: boolean;
      button: boolean;
    }> = [
      { name: "right layout, guild text channel", arrange: () => {}, shown: true, button: true },
      {
        name: "announcement channel",
        arrange: () => setActive(3),
        shown: true,
        button: true,
      },
      {
        name: "left layout",
        arrange: () => savePref(MEMBER_LAYOUT_PREF, "left"),
        shown: false,
        button: false,
      },
      {
        name: "stored open=false",
        arrange: () => savePref(MEMBER_OPEN_PREF, false),
        shown: false,
        button: true,
      },
      { name: "a DM", arrange: () => setActive(2), shown: false, button: false },
      {
        name: "DM sidebar mode",
        arrange: () => {
          uiStore.setState((prev) => ({ ...prev, sidebarMode: "dms" }));
          uiStore.flush();
        },
        shown: false,
        button: false,
      },
      {
        name: "a content view open",
        arrange: () => {
          uiStore.setState((prev) => ({ ...prev, activeView: "moderation" }));
          uiStore.flush();
        },
        shown: false,
        button: true,
      },
      { name: "no active channel", arrange: () => setActive(null), shown: false, button: false },
    ];
    for (const c of cases) {
      it(c.name, () => {
        c.arrange();
        ctrl = make();
        ctrl.sync();
        expect(column.hidden).toBe(!c.shown);
        expect(body.querySelectorAll('[data-testid="member-list"]').length).toBe(c.shown ? 1 : 0);
        expect(buildPanel).toHaveBeenCalledTimes(c.shown ? 1 : 0);
        expect(button.hidden).toBe(!c.button);
        expect(button.getAttribute("aria-pressed")).toBe(String(c.shown));
      });
    }
  });

  it("a repeated sync keeps the one panel", () => {
    ctrl = make();
    ctrl.sync();
    ctrl.sync();
    expect(buildPanel).toHaveBeenCalledTimes(1);
  });

  it("follows channel, mode and view changes through the stores", () => {
    ctrl = make();
    ctrl.sync();
    expect(column.hidden).toBe(false);

    setActive(2);
    expect(column.hidden).toBe(true);
    expect(panels[0]!.destroy).toHaveBeenCalledTimes(1);
    expect(button.hidden).toBe(true);

    setActive(1);
    expect(column.hidden).toBe(false);
    expect(buildPanel).toHaveBeenCalledTimes(2);

    uiStore.setState((prev) => ({ ...prev, activeView: "moderation" }));
    uiStore.flush();
    expect(column.hidden).toBe(true);
    uiStore.setState((prev) => ({ ...prev, activeView: null }));
    uiStore.flush();
    expect(column.hidden).toBe(false);

    uiStore.setState((prev) => ({ ...prev, sidebarMode: "dms" }));
    uiStore.flush();
    expect(column.hidden).toBe(true);
  });

  it("toggle flips aria-pressed and saves memberListOpen; focus stays on the button", () => {
    ctrl = make();
    ctrl.sync();
    button.focus();
    expect(button.getAttribute("aria-pressed")).toBe("true");

    ctrl.toggle();
    expect(localStorage.getItem("owncord:settings:memberListOpen")).toBe("false");
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(column.hidden).toBe(true);
    expect(document.activeElement).toBe(button);
    expect(fallbackFocus).not.toHaveBeenCalled();

    ctrl.toggle();
    expect(localStorage.getItem("owncord:settings:memberListOpen")).toBe("true");
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(column.hidden).toBe(false);
    expect(document.activeElement).toBe(button);
  });

  describe("call view", () => {
    it("hides the column while the call view is up and puts the saved choice back after", () => {
      ctrl = make();
      ctrl.sync();
      expect(column.hidden).toBe(false);

      ctrl.setCallView(true);
      expect(column.hidden).toBe(true);
      expect(button.hidden).toBe(false);
      expect(button.getAttribute("aria-pressed")).toBe("false");

      ctrl.setCallView(false);
      expect(column.hidden).toBe(false);
      expect(button.getAttribute("aria-pressed")).toBe("true");
    });

    it("toggle opens it for the moment without saving; leaving the call view forgets it", () => {
      savePref(MEMBER_OPEN_PREF, false);
      ctrl = make();
      ctrl.setCallView(true);
      const before = localStorage.getItem("owncord:settings:memberListOpen");

      ctrl.toggle();
      expect(column.hidden).toBe(false);
      expect(localStorage.getItem("owncord:settings:memberListOpen")).toBe(before);

      ctrl.setCallView(false);
      expect(column.hidden).toBe(true);
      ctrl.setCallView(true);
      expect(column.hidden).toBe(true);
    });

    it("a memberListOpen change during the call view leaves the column hidden", () => {
      ctrl = make();
      ctrl.setCallView(true);
      savePref(MEMBER_OPEN_PREF, true);
      expect(column.hidden).toBe(true);
    });
  });

  it("a memberListOpen change from elsewhere re-syncs", () => {
    ctrl = make();
    ctrl.sync();
    savePref(MEMBER_OPEN_PREF, false);
    expect(column.hidden).toBe(true);
  });

  it("ignores the layout key: MainPage's layout handler orders destroy before create", () => {
    ctrl = make();
    ctrl.sync();
    savePref(MEMBER_LAYOUT_PREF, "left");
    expect(column.hidden).toBe(false);
    expect(panels[0]!.destroy).not.toHaveBeenCalled();
    ctrl.sync();
    expect(column.hidden).toBe(true);
    expect(panels[0]!.destroy).toHaveBeenCalledTimes(1);
  });

  it("hiding destroys the panel and builds a new one on show", () => {
    ctrl = make();
    ctrl.sync();
    expect(buildPanel).toHaveBeenCalledTimes(1);

    ctrl.toggle();
    expect(panels[0]!.destroy).toHaveBeenCalledTimes(1);
    expect(body.children.length).toBe(0);

    ctrl.toggle();
    expect(buildPanel).toHaveBeenCalledTimes(2);
    expect(body.children.length).toBe(1);
    expect(body.firstElementChild).toBe(panels[1]!.element);
  });

  it("focus inside the column at hide moves to fallbackFocus", () => {
    ctrl = make();
    ctrl.sync();
    const input = document.createElement("input");
    panels[0]!.element.appendChild(input);
    input.focus();
    expect(column.contains(document.activeElement)).toBe(true);

    ctrl.toggle();
    expect(fallbackFocus).toHaveBeenCalledTimes(1);
  });

  it("focus outside the column at hide leaves focus alone", () => {
    ctrl = make();
    ctrl.sync();
    button.focus();
    setActive(2);
    expect(fallbackFocus).not.toHaveBeenCalled();
  });

  it("destroy tears down the panel and the subscriptions", () => {
    ctrl = make();
    ctrl.sync();
    ctrl.destroy();
    expect(panels[0]!.destroy).toHaveBeenCalledTimes(1);
    expect(body.children.length).toBe(0);

    setActive(2);
    setActive(1);
    savePref(MEMBER_OPEN_PREF, true);
    ctrl.sync();
    ctrl.toggle();
    expect(buildPanel).toHaveBeenCalledTimes(1);
  });

  describe("width handle (3C-6c)", () => {
    function handle(): HTMLElement {
      return column.querySelector<HTMLElement>(".member-column-resize")!;
    }
    function pointer(type: string, init: { x: number; id?: number }): void {
      const e = new MouseEvent(type, { clientX: init.x, button: 0, bubbles: true });
      Object.defineProperty(e, "pointerId", { value: init.id ?? 1 });
      handle().dispatchEvent(e);
    }

    it("is the column's first child, a vertical separator with 200-360 bounds", () => {
      ctrl = make();
      const h = column.firstElementChild as HTMLElement;
      expect(h).toBe(handle());
      expect(h.getAttribute("role")).toBe("separator");
      expect(h.getAttribute("aria-orientation")).toBe("vertical");
      expect(h.getAttribute("aria-label")).toBe("Resize member list");
      expect(h.getAttribute("aria-valuemin")).toBe("200");
      expect(h.getAttribute("aria-valuemax")).toBe("360");
      expect(h.getAttribute("aria-valuenow")).toBe("240");
      expect(h.tabIndex).toBe(0);
      expect(column.style.width).toBe("240px");
    });

    it("drag resizes within 200-360 and saves once on pointerup", () => {
      ctrl = make();
      const setCapture = vi.fn();
      handle().setPointerCapture = setCapture;
      handle().releasePointerCapture = vi.fn();
      const spy = vi.spyOn(Storage.prototype, "setItem");

      pointer("pointerdown", { x: 500 });
      expect(setCapture).toHaveBeenCalledWith(1);
      pointer("pointermove", { x: 460 });
      expect(column.style.width).toBe("280px");
      expect(handle().getAttribute("aria-valuenow")).toBe("280");
      pointer("pointermove", { x: 100 });
      expect(column.style.width).toBe("360px");
      pointer("pointermove", { x: 900 });
      expect(column.style.width).toBe("200px");
      pointer("pointermove", { x: 450 });
      expect(spy).not.toHaveBeenCalled();

      pointer("pointerup", { x: 450 });
      const saves = spy.mock.calls.filter(([k]) => String(k).endsWith(MEMBER_WIDTH_PREF));
      expect(saves.length).toBe(1);
      expect(localStorage.getItem("owncord:settings:memberListWidth")).toBe("290");

      pointer("pointermove", { x: 300 });
      expect(column.style.width).toBe("290px");
      spy.mockRestore();
    });

    it("a drag whose capture is lost ends, saves, and the next drag works", () => {
      ctrl = make();
      handle().setPointerCapture = vi.fn();
      handle().releasePointerCapture = vi.fn();
      pointer("pointerdown", { x: 500 });
      pointer("pointermove", { x: 460 });
      pointer("lostpointercapture", { x: 460 });
      expect(localStorage.getItem("owncord:settings:memberListWidth")).toBe("280");
      pointer("pointerdown", { x: 500, id: 2 });
      pointer("pointermove", { x: 480, id: 2 });
      expect(column.style.width).toBe("300px");
    });

    it("the handle controls the column", () => {
      ctrl = make();
      expect(handle().getAttribute("aria-controls")).toBe("member-column");
    });

    it("pointercancel also ends the drag with one save", () => {
      ctrl = make();
      const spy = vi.spyOn(Storage.prototype, "setItem");
      pointer("pointerdown", { x: 500 });
      pointer("pointermove", { x: 480 });
      pointer("pointercancel", { x: 480 });
      pointer("pointerup", { x: 480 });
      expect(spy.mock.calls.filter(([k]) => String(k).endsWith(MEMBER_WIDTH_PREF)).length).toBe(1);
      spy.mockRestore();
    });

    it("arrow keys resize by 16 and update aria-valuenow; Home and End jump", () => {
      ctrl = make();
      const key = (k: string): KeyboardEvent => {
        const e = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true });
        handle().dispatchEvent(e);
        return e;
      };
      expect(key("ArrowLeft").defaultPrevented).toBe(true);
      expect(handle().getAttribute("aria-valuenow")).toBe("256");
      expect(column.style.width).toBe("256px");
      expect(localStorage.getItem("owncord:settings:memberListWidth")).toBe("256");
      key("ArrowRight");
      key("ArrowRight");
      expect(handle().getAttribute("aria-valuenow")).toBe("224");
      key("End");
      expect(handle().getAttribute("aria-valuenow")).toBe("360");
      key("ArrowLeft");
      expect(handle().getAttribute("aria-valuenow")).toBe("360");
      key("Home");
      expect(handle().getAttribute("aria-valuenow")).toBe("200");
      expect(localStorage.getItem("owncord:settings:memberListWidth")).toBe("200");
      expect(key("a").defaultPrevented).toBe(false);
    });

    it("stored 999 width loads as 360", () => {
      savePref(MEMBER_WIDTH_PREF, 999);
      ctrl = make();
      expect(column.style.width).toBe("360px");
      expect(handle().getAttribute("aria-valuenow")).toBe("360");
    });

    it("destroy removes the handle", () => {
      ctrl = make();
      ctrl.destroy();
      expect(column.querySelector(".member-column-resize")).toBeNull();
    });
  });

  describe("narrow overlay (3C-6c)", () => {
    let mq: FakeMediaQueryList;

    beforeEach(() => {
      mq = new FakeMediaQueryList();
      mq.matches = true;
      vi.stubGlobal(
        "matchMedia",
        vi.fn(() => mq),
      );
    });
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    function search(): HTMLInputElement {
      return body.querySelector<HTMLInputElement>('[data-testid="member-search"]')!;
    }
    // The fake panel needs a search box like the real one.
    beforeEach(() => {
      buildPanel.mockImplementation(() => {
        const element = document.createElement("div");
        element.dataset["testid"] = "member-list";
        const input = document.createElement("input");
        input.dataset["testid"] = "member-search";
        element.appendChild(input);
        const panel = { element, destroy: vi.fn() };
        panels.push(panel);
        return panel;
      });
    });

    it("starts closed whatever the open pref says", () => {
      ctrl = make();
      ctrl.sync();
      expect(column.hidden).toBe(true);
      expect(button.hidden).toBe(false);
      expect(button.getAttribute("aria-pressed")).toBe("false");
      expect(buildPanel).not.toHaveBeenCalled();
    });

    it("toggle opens the overlay without saving; Escape closes, refocuses the toggle and does not propagate", () => {
      ctrl = make();
      ctrl.sync();
      const spy = vi.spyOn(Storage.prototype, "setItem");
      ctrl.toggle();
      expect(column.hidden).toBe(false);
      expect(button.getAttribute("aria-pressed")).toBe("true");
      expect(document.activeElement).toBe(search());
      expect(localStorage.getItem("owncord:settings:memberListOpen")).toBeNull();

      const leaked = vi.fn();
      document.addEventListener("keydown", leaked);
      const esc = new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      });
      search().dispatchEvent(esc);
      document.removeEventListener("keydown", leaked);
      expect(esc.defaultPrevented).toBe(true);
      expect(leaked).not.toHaveBeenCalled();
      expect(column.hidden).toBe(true);
      expect(document.activeElement).toBe(button);
      expect(fallbackFocus).not.toHaveBeenCalled();
      expect(spy).not.toHaveBeenCalled();

      ctrl.toggle();
      ctrl.toggle();
      expect(column.hidden).toBe(true);
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it("Escape with text in the search leaves the overlay open", () => {
      ctrl = make();
      ctrl.toggle();
      search().value = "al";
      const esc = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
      search().dispatchEvent(esc);
      expect(esc.defaultPrevented).toBe(false);
      expect(column.hidden).toBe(false);
    });

    it("clicking outside does not close it", () => {
      ctrl = make();
      ctrl.toggle();
      document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(column.hidden).toBe(false);
    });

    it("closes on channel switch and on widening", () => {
      ctrl = make();
      ctrl.toggle();
      expect(column.hidden).toBe(false);
      setActive(3);
      expect(column.hidden).toBe(true);
      expect(button.getAttribute("aria-pressed")).toBe("false");

      ctrl.toggle();
      expect(column.hidden).toBe(false);
      setActive(2);
      expect(column.hidden).toBe(true);
      setActive(1);
      expect(column.hidden).toBe(true);

      ctrl.toggle();
      expect(column.hidden).toBe(false);
      mq.set(false);
      // Widened: the stored open pref (default true) now governs.
      expect(column.hidden).toBe(false);
      savePref(MEMBER_OPEN_PREF, false);
      mq.set(true);
      expect(column.hidden).toBe(true);
      ctrl.toggle();
      mq.set(false);
      expect(column.hidden).toBe(true);
    });

    it("drawer open closes the overlay", () => {
      ctrl = make();
      ctrl.toggle();
      expect(column.hidden).toBe(false);
      ctrl.closeOverlay();
      expect(column.hidden).toBe(true);
      expect(button.getAttribute("aria-pressed")).toBe("false");
      ctrl.closeOverlay();
      expect(column.hidden).toBe(true);
    });

    it("destroy stops listening to the media query", () => {
      const add = vi.spyOn(mq, "addEventListener");
      ctrl = make();
      ctrl.toggle();
      const opts = add.mock.calls.find(([type]) => type === "change")?.[2];
      const signal = typeof opts === "object" ? opts.signal : undefined;
      expect(signal?.aborted).toBe(false);
      ctrl.destroy();
      expect(signal?.aborted).toBe(true);
      mq.set(false);
      expect(buildPanel).toHaveBeenCalledTimes(1);
    });
  });
});
