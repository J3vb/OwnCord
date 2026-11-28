// The voice widget's anchored popovers under Deck on a desktop
// (widget/deckPopover.ts): placement, and closing on Esc, an outside click or
// the button again. Classic and the phone layout keep the panel inline.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Disposable } from "../../src/lib/disposable";
import {
  createDeckPopover,
  isDeckPopoverMode,
  placePopover,
} from "../../src/features/voice/widget/deckPopover";
import { usePhone } from "../helpers/phoneMedia";

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return { left, top, width, height, right: left + width, bottom: top + height } as DOMRect;
}

describe("placePopover", () => {
  const viewport = { width: 1333, height: 934 };

  it("centres the panel over its button, the arrow on the button", () => {
    const spot = placePopover(rect(600, 900, 32, 32), 360, viewport);
    expect(spot.left).toBe(436);
    expect(spot.arrow).toBe(180);
    // Above the button with a gap for the arrow.
    expect(spot.bottom).toBe(934 - 900 + 10);
    expect(spot.maxHeight).toBe(900 - 10 - 8);
  });

  it("keeps the panel inside the right edge, the arrow still over the button", () => {
    const spot = placePopover(rect(1290, 900, 32, 32), 360, viewport);
    expect(spot.left).toBe(1333 - 360 - 8);
    expect(spot.arrow).toBe(1306 - spot.left);
  });

  it("keeps the panel inside the left edge", () => {
    const spot = placePopover(rect(4, 900, 32, 32), 360, viewport);
    expect(spot.left).toBe(8);
    // The arrow stays clear of the rounded corner.
    expect(spot.arrow).toBe(18);
  });

  it("never sets the arrow past the far corner", () => {
    const spot = placePopover(rect(1320, 900, 20, 32), 360, viewport);
    expect(spot.arrow).toBe(360 - 18);
  });

  it("keeps a panel wider than the window at the left edge", () => {
    expect(placePopover(rect(100, 300, 32, 32), 400, { width: 300, height: 400 }).left).toBe(8);
  });

  it("leaves no room rather than a negative one under a button at the top", () => {
    expect(placePopover(rect(100, 4, 32, 32), 360, viewport).maxHeight).toBe(0);
  });
});

describe("createDeckPopover", () => {
  let scope: Disposable;
  let panel: HTMLDivElement;
  let anchor: HTMLButtonElement;
  let outside: HTMLButtonElement;

  beforeEach(() => {
    scope = new Disposable();
    panel = document.createElement("div");
    panel.setAttribute("role", "group");
    anchor = document.createElement("button");
    outside = document.createElement("button");
    document.body.append(panel, anchor, outside);
  });

  afterEach(() => {
    scope.destroy();
    document.documentElement.classList.remove("layout-deck");
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
  });

  function popover(onChange = vi.fn(), inlineToggle = true) {
    return createDeckPopover({
      panel,
      anchor,
      openClass: "open",
      inlineToggle,
      signal: scope.signal,
      onChange,
    });
  }

  function useDeck(): void {
    document.documentElement.classList.add("layout-deck");
  }

  it("applies under Deck on a desktop only", () => {
    expect(isDeckPopoverMode()).toBe(false);
    useDeck();
    expect(isDeckPopoverMode()).toBe(true);
    usePhone();
    expect(isDeckPopoverMode()).toBe(false);
  });

  it("lifts the panel into a dialog its button opens, under Deck", () => {
    useDeck();
    popover();
    expect(panel.classList.contains("vw-pop")).toBe(true);
    expect(panel.getAttribute("role")).toBe("dialog");
    expect(anchor.getAttribute("aria-haspopup")).toBe("dialog");
    expect(anchor.getAttribute("aria-expanded")).toBe("false");
  });

  it("opens and closes on its button, telling the owner each time", () => {
    useDeck();
    const onChange = vi.fn();
    const pop = popover(onChange);
    pop.toggle();
    expect(panel.classList.contains("open")).toBe(true);
    expect(anchor.getAttribute("aria-expanded")).toBe("true");
    expect(panel.style.getPropertyValue("--deck-pop-arrow")).not.toBe("");
    pop.toggle();
    expect(panel.classList.contains("open")).toBe(false);
    expect(anchor.getAttribute("aria-expanded")).toBe("false");
    expect(panel.style.getPropertyValue("--deck-pop-arrow")).toBe("");
    expect(onChange.mock.calls).toEqual([[true], [false]]);
  });

  it("closes on Esc and gives the focus back to its button", () => {
    useDeck();
    const pop = popover();
    pop.open();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(pop.isOpen()).toBe(true);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(pop.isOpen()).toBe(false);
    expect(document.activeElement).toBe(anchor);
  });

  it("closes on a click outside it, never on one inside it or on its button", () => {
    useDeck();
    const pop = popover();
    pop.open();
    const inner = document.createElement("span");
    panel.appendChild(inner);
    inner.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    anchor.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(pop.isOpen()).toBe(true);
    outside.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(pop.isOpen()).toBe(false);
  });

  it("stops listening once closed: a later Esc or click does nothing", () => {
    useDeck();
    const onChange = vi.fn();
    const pop = popover(onChange);
    pop.open();
    pop.close();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    outside.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(document.activeElement).not.toBe(anchor);
  });

  it("only toggles inline in Classic: no dialog, no Esc or outside click", () => {
    const pop = popover();
    expect(panel.classList.contains("vw-pop")).toBe(false);
    expect(panel.getAttribute("role")).toBe("group");
    expect(anchor.hasAttribute("aria-haspopup")).toBe(false);
    pop.open();
    expect(anchor.getAttribute("aria-expanded")).toBe("true");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    outside.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(pop.isOpen()).toBe(true);
    expect(panel.style.left).toBe("");
  });

  it("keeps a button that does not open the panel inline free of aria-expanded", () => {
    popover(vi.fn(), false);
    expect(anchor.hasAttribute("aria-expanded")).toBe(false);
  });

  it("goes inline again when the window turns into the phone layout", () => {
    useDeck();
    const pop = popover();
    pop.open();
    usePhone();
    pop.sync();
    expect(panel.classList.contains("vw-pop")).toBe(false);
    expect(panel.getAttribute("role")).toBe("group");
    expect(panel.style.left).toBe("");
    // Inline now: Esc no longer closes it.
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(pop.isOpen()).toBe(true);
  });

  it("scrolls without its arrow where the window is too short for it", () => {
    useDeck();
    Object.defineProperty(panel, "scrollHeight", { configurable: true, value: 500 });
    anchor.getBoundingClientRect = () => rect(600, 300, 32, 32);
    const pop = popover();
    pop.open();
    expect(panel.classList.contains("vw-pop--tight")).toBe(true);
    expect(panel.style.maxHeight).toBe("282px");
    pop.close();
    expect(panel.classList.contains("vw-pop--tight")).toBe(false);
    expect(panel.style.maxHeight).toBe("");
  });

  it("re-places an open panel when the window resizes", () => {
    useDeck();
    let left = 600;
    anchor.getBoundingClientRect = () => rect(left, 900, 32, 32);
    Object.defineProperty(panel, "offsetWidth", { configurable: true, value: 360 });
    const pop = popover();
    pop.open();
    expect(panel.style.left).toBe("436px");
    left = 700;
    window.dispatchEvent(new Event("resize"));
    expect(panel.style.left).toBe("536px");
  });

  it("ends with its owner: listeners gone, the button plain again", () => {
    useDeck();
    const pop = popover();
    pop.open();
    scope.destroy();
    expect(anchor.hasAttribute("aria-haspopup")).toBe(false);
    expect(anchor.hasAttribute("aria-expanded")).toBe(false);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(pop.isOpen()).toBe(true);
    pop.open();
    expect(pop.isOpen()).toBe(true);
  });
});
