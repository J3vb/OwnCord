import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { clampPaneWidth, createPaneResize, type PaneResize } from "./paneResize";

const PREF = "testPaneWidth";
const storedPref = (): string | null => localStorage.getItem(`owncord:settings:${PREF}`);

describe("clampPaneWidth", () => {
  it("keeps the width within the limits and rounds it", () => {
    expect(clampPaneWidth(100, 200, 500, 0, 300)).toBe(200);
    expect(clampPaneWidth(900, 200, 500, 0, 300)).toBe(500);
    expect(clampPaneWidth(300.6, 200, 500, 0, 300)).toBe(301);
  });
  it("narrows to the room, never under the minimum", () => {
    expect(clampPaneWidth(450, 200, 500, 400, 300)).toBe(400);
    expect(clampPaneWidth(450, 200, 500, 600, 300)).toBe(450);
    expect(clampPaneWidth(450, 200, 500, 100, 300)).toBe(200);
  });
  it("uses the fallback for a width that is not a number", () => {
    expect(clampPaneWidth(Number.NaN, 200, 500, 0, 320)).toBe(320);
    expect(clampPaneWidth(Number.POSITIVE_INFINITY, 200, 500, 0, 320)).toBe(320);
  });
});

describe("createPaneResize", () => {
  let host: HTMLElement;
  let room: number;
  let pane: PaneResize;
  let onDragStart: ReturnType<typeof vi.fn<() => void>>;
  const width = (): string => host.style.getPropertyValue("--test-width");

  function make(): PaneResize {
    pane = createPaneResize({
      host,
      property: "--test-width",
      pref: PREF,
      min: 200,
      max: 500,
      initial: 300,
      room: () => room,
      label: "Resize test pane",
      className: "test-resize",
      testId: "test-resize",
      onDragStart,
    });
    document.body.appendChild(pane.handle);
    return pane;
  }

  function fire(type: string, init: { x?: number; id?: number; button?: number } = {}): MouseEvent {
    const e = new MouseEvent(type, {
      clientX: init.x ?? 0,
      button: init.button ?? 0,
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(e, "pointerId", { value: init.id ?? 1 });
    pane.handle.dispatchEvent(e);
    return e;
  }

  function key(k: string): KeyboardEvent {
    const e = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true });
    pane.handle.dispatchEvent(e);
    return e;
  }

  function capture(): { set: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> } {
    const set = vi.fn();
    const release = vi.fn();
    pane.handle.setPointerCapture = set;
    pane.handle.releasePointerCapture = release;
    return { set, release };
  }

  beforeEach(() => {
    localStorage.clear();
    host = document.createElement("div");
    document.body.appendChild(host);
    room = 0;
    onDragStart = vi.fn<() => void>();
  });

  afterEach(() => {
    pane?.destroy();
    host.remove();
  });

  it("builds a labelled vertical separator with the limits", () => {
    make();
    const h = pane.handle;
    expect(h.className).toBe("test-resize");
    expect(h.getAttribute("role")).toBe("separator");
    expect(h.getAttribute("aria-orientation")).toBe("vertical");
    expect(h.getAttribute("aria-label")).toBe("Resize test pane");
    expect(h.getAttribute("aria-valuemin")).toBe("200");
    expect(h.getAttribute("aria-valuemax")).toBe("500");
    expect(h.getAttribute("data-testid")).toBe("test-resize");
    expect(h.tabIndex).toBe(0);
  });

  it("starts from the saved width and shows it once applied", () => {
    localStorage.setItem(`owncord:settings:${PREF}`, "420");
    make();
    expect(width()).toBe("");
    pane.apply();
    expect(width()).toBe("420px");
    expect(pane.handle.getAttribute("aria-valuenow")).toBe("420");
  });

  it("falls back to the initial width when nothing usable is saved", () => {
    make();
    pane.apply();
    expect(width()).toBe("300px");
  });

  it("apply narrows the shown width to the room without losing the choice", () => {
    localStorage.setItem(`owncord:settings:${PREF}`, "450");
    make();
    room = 350;
    pane.apply();
    expect(width()).toBe("350px");
    room = 0;
    pane.apply();
    expect(width()).toBe("450px");
  });

  describe("dragging", () => {
    it("widens when dragged left, claims the pointer and saves once on release", () => {
      make();
      pane.apply();
      const { set, release } = capture();
      const down = fire("pointerdown", { x: 700, id: 4 });
      expect(down.defaultPrevented).toBe(true);
      expect(set).toHaveBeenCalledWith(4);
      expect(onDragStart).toHaveBeenCalledTimes(1);

      fire("pointermove", { x: 650, id: 4 });
      expect(width()).toBe("350px");
      fire("pointermove", { x: 800, id: 4 });
      expect(width()).toBe("200px");
      expect(storedPref()).toBeNull();

      fire("pointerup", { x: 800, id: 4 });
      expect(release).toHaveBeenCalledWith(4);
      expect(storedPref()).toBe("200");
      fire("pointermove", { x: 0, id: 4 });
      expect(width()).toBe("200px");
    });

    it("clamps a drag to the room reported when it starts", () => {
      make();
      pane.apply();
      capture();
      room = 380;
      fire("pointerdown", { x: 700 });
      fire("pointermove", { x: 0 });
      expect(width()).toBe("380px");
    });

    it("ignores a press of another button", () => {
      make();
      pane.apply();
      const { set } = capture();
      const down = fire("pointerdown", { x: 700, button: 2 });
      expect(down.defaultPrevented).toBe(false);
      expect(set).not.toHaveBeenCalled();
      expect(onDragStart).not.toHaveBeenCalled();
      fire("pointermove", { x: 600 });
      expect(width()).toBe("300px");
    });

    it("keeps the first pointer when a second one goes down mid-drag", () => {
      make();
      pane.apply();
      const { set } = capture();
      fire("pointerdown", { x: 700, id: 1 });
      const second = fire("pointerdown", { x: 100, id: 2 });
      expect(second.defaultPrevented).toBe(false);
      expect(set).toHaveBeenCalledTimes(1);
      expect(onDragStart).toHaveBeenCalledTimes(1);
      fire("pointermove", { x: 650, id: 1 });
      expect(width()).toBe("350px");
    });

    it("only follows and ends on the pointer that started the drag", () => {
      make();
      pane.apply();
      const { release } = capture();
      fire("pointerdown", { x: 700, id: 1 });
      fire("pointermove", { x: 600, id: 2 });
      expect(width()).toBe("300px");
      fire("pointerup", { x: 600, id: 2 });
      fire("pointercancel", { x: 600, id: 2 });
      fire("lostpointercapture", { x: 600, id: 2 });
      expect(release).not.toHaveBeenCalled();
      expect(storedPref()).toBeNull();
      fire("pointermove", { x: 650, id: 1 });
      expect(width()).toBe("350px");
    });

    it("ignores moves when no drag is in progress", () => {
      make();
      pane.apply();
      fire("pointermove", { x: -500 });
      expect(width()).toBe("300px");
    });

    it.each(["pointercancel", "lostpointercapture"])("%s ends the drag and saves", (type) => {
      make();
      pane.apply();
      const { release } = capture();
      fire("pointerdown", { x: 700 });
      fire("pointermove", { x: 640 });
      fire(type, { x: 640 });
      expect(release).toHaveBeenCalledWith(1);
      expect(storedPref()).toBe("360");
    });

    it("keeps dragging when the pointer cannot be captured", () => {
      make();
      pane.apply();
      pane.handle.setPointerCapture = () => {
        throw new Error("no such pointer");
      };
      fire("pointerdown", { x: 700 });
      fire("pointermove", { x: 650 });
      expect(width()).toBe("350px");
    });

    it("saves the width even when releasing capture throws", () => {
      make();
      pane.apply();
      capture();
      pane.handle.releasePointerCapture = () => {
        throw new Error("capture already gone");
      };
      fire("pointerdown", { x: 700 });
      fire("pointermove", { x: 650 });
      fire("pointerup", { x: 650 });
      expect(storedPref()).toBe("350");
    });

    it("release ends a drag in progress and saves where it stopped", () => {
      make();
      pane.apply();
      const { release } = capture();
      fire("pointerdown", { x: 700 });
      fire("pointermove", { x: 660 });
      pane.release();
      expect(release).toHaveBeenCalledWith(1);
      expect(storedPref()).toBe("340");
      // A new press starts a fresh drag from the width now shown.
      fire("pointerdown", { x: 500 });
      fire("pointermove", { x: 480 });
      expect(width()).toBe("360px");
    });

    it("release without a drag saves nothing", () => {
      make();
      pane.apply();
      pane.release();
      expect(storedPref()).toBeNull();
    });
  });

  describe("keyboard", () => {
    it("steps by 16 with the arrows, jumps with Home and End, and saves each", () => {
      make();
      pane.apply();
      expect(key("ArrowLeft").defaultPrevented).toBe(true);
      expect(width()).toBe("316px");
      expect(storedPref()).toBe("316");
      key("ArrowRight");
      key("ArrowRight");
      expect(width()).toBe("284px");
      expect(key("Home").defaultPrevented).toBe(true);
      expect(width()).toBe("200px");
      expect(storedPref()).toBe("200");
      expect(key("End").defaultPrevented).toBe(true);
      expect(width()).toBe("500px");
      expect(storedPref()).toBe("500");
    });

    it("leaves other keys alone", () => {
      make();
      pane.apply();
      const e = key("a");
      expect(e.defaultPrevented).toBe(false);
      expect(width()).toBe("300px");
      expect(storedPref()).toBeNull();
    });

    it("steps from the width shown, not the saved choice", () => {
      localStorage.setItem(`owncord:settings:${PREF}`, "450");
      make();
      room = 350;
      pane.apply();
      key("ArrowLeft");
      expect(width()).toBe("350px");
      key("ArrowRight");
      expect(width()).toBe("334px");
    });
  });

  describe("clear and destroy", () => {
    it("clear ends a drag, saves and takes the width off the host", () => {
      make();
      pane.apply();
      capture();
      fire("pointerdown", { x: 700 });
      fire("pointermove", { x: 650 });
      pane.clear();
      expect(storedPref()).toBe("350");
      expect(width()).toBe("");
      expect(pane.handle.isConnected).toBe(true);
    });

    it("destroy saves a drag in progress, removes the handle and the width", () => {
      make();
      pane.apply();
      const { release } = capture();
      fire("pointerdown", { x: 700 });
      fire("pointermove", { x: 650 });
      pane.destroy();
      expect(release).toHaveBeenCalledWith(1);
      expect(storedPref()).toBe("350");
      expect(width()).toBe("");
      expect(pane.handle.isConnected).toBe(false);
    });

    it("destroy detaches the handle's listeners", () => {
      make();
      pane.apply();
      pane.destroy();
      const e = key("End");
      expect(e.defaultPrevented).toBe(false);
      expect(storedPref()).toBeNull();
      fire("pointerdown", { x: 700 });
      expect(onDragStart).not.toHaveBeenCalled();
    });
  });
});
