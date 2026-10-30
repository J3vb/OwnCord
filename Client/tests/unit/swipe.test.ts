import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SWIPE_DOMINANCE,
  SWIPE_START_PX,
  isHorizontalSwipe,
  swipeMayStartOn,
  watchSwipes,
  type SwipeHandlers,
} from "../../src/lib/ui/swipe";
import { closeBottomSheet, openBottomSheet } from "../../src/lib/ui/bottomSheet";
import { pointer, swipe } from "../helpers/touch";

const owners: AbortController[] = [];

interface Recorded {
  readonly begin: ReturnType<typeof vi.fn>;
  readonly start: ReturnType<typeof vi.fn>;
  readonly move: ReturnType<typeof vi.fn>;
  readonly end: ReturnType<typeof vi.fn>;
}

function surface(html = '<p data-testid="text">hello</p>'): {
  root: HTMLElement;
  rec: Recorded;
  ac: AbortController;
} {
  const root = document.createElement("div");
  root.innerHTML = html;
  document.body.appendChild(root);
  const ac = new AbortController();
  owners.push(ac);
  const rec: Recorded = {
    begin: vi.fn(() => ({})),
    start: vi.fn(() => true),
    move: vi.fn(),
    end: vi.fn(),
  };
  const handlers: SwipeHandlers<object> = {
    begin: rec.begin as unknown as SwipeHandlers<object>["begin"],
    start: rec.start as unknown as NonNullable<SwipeHandlers<object>["start"]>,
    move: rec.move as unknown as NonNullable<SwipeHandlers<object>["move"]>,
    end: rec.end as unknown as SwipeHandlers<object>["end"],
  };
  watchSwipes(root, ac.signal, handlers);
  return { root, rec, ac };
}

afterEach(() => {
  for (const ac of owners.splice(0)) ac.abort();
  closeBottomSheet();
  document.body.replaceChildren();
  window.getSelection()?.removeAllRanges();
  vi.restoreAllMocks();
});

describe("isHorizontalSwipe", () => {
  it("needs more than 10 px sideways and 1.5 times the vertical move", () => {
    expect(SWIPE_START_PX).toBe(10);
    expect(SWIPE_DOMINANCE).toBe(1.5);
    expect(isHorizontalSwipe(10, 0)).toBe(false);
    expect(isHorizontalSwipe(11, 0)).toBe(true);
    expect(isHorizontalSwipe(-11, 0)).toBe(true);
    // Exactly 1.5 times is not "clearly" dominant; just past it is.
    expect(isHorizontalSwipe(30, 20)).toBe(false);
    expect(isHorizontalSwipe(31, 20)).toBe(true);
    expect(isHorizontalSwipe(-31, -20)).toBe(true);
    expect(isHorizontalSwipe(0, 40)).toBe(false);
    expect(isHorizontalSwipe(20, 40)).toBe(false);
  });
});

describe("watchSwipes", () => {
  it("runs begin, start, move and end for a horizontal swipe", () => {
    const { root, rec } = surface();
    const text = root.querySelector("p")!;
    swipe(text, [100, 100], [200, 104]);
    expect(rec.begin).toHaveBeenCalledTimes(1);
    expect(rec.start).toHaveBeenCalledTimes(1);
    expect(rec.move).toHaveBeenCalled();
    expect(rec.end).toHaveBeenCalledTimes(1);
    expect(rec.end).toHaveBeenCalledWith({}, 100, true);
  });

  it("leaves a vertical scroll alone", () => {
    const { root, rec } = surface();
    swipe(root.querySelector("p")!, [100, 100], [104, 300]);
    expect(rec.start).not.toHaveBeenCalled();
    expect(rec.end).not.toHaveBeenCalled();
  });

  it("stays out of a gesture that turned vertical before it was sideways enough", () => {
    const { root, rec } = surface();
    const text = root.querySelector("p")!;
    pointer("pointerdown", text, 100, 100);
    pointer("pointermove", text, 105, 125);
    // Later sideways travel does not revive it.
    pointer("pointermove", text, 200, 130);
    pointer("pointerup", text, 200, 130);
    expect(rec.start).not.toHaveBeenCalled();
    expect(rec.end).not.toHaveBeenCalled();
  });

  it("waits through a short diagonal start until sideways clearly wins", () => {
    const { root, rec } = surface();
    const text = root.querySelector("p")!;
    pointer("pointerdown", text, 100, 100);
    pointer("pointermove", text, 112, 108);
    expect(rec.start).not.toHaveBeenCalled();
    pointer("pointermove", text, 160, 110);
    expect(rec.start).toHaveBeenCalledTimes(1);
    pointer("pointerup", text, 160, 110);
    expect(rec.end).toHaveBeenCalledWith({}, 60, true);
  });

  it("only follows touch pointers", () => {
    const { root, rec } = surface();
    swipe(root.querySelector("p")!, [100, 100], [200, 100], { pointerType: "mouse" });
    swipe(root.querySelector("p")!, [100, 100], [200, 100], { pointerType: "pen" });
    expect(rec.begin).not.toHaveBeenCalled();
  });

  it("drops the gesture when begin or start say no", () => {
    const { root, rec } = surface();
    rec.begin.mockReturnValueOnce(null);
    swipe(root.querySelector("p")!, [100, 100], [200, 100]);
    expect(rec.start).not.toHaveBeenCalled();
    rec.start.mockReturnValueOnce(false);
    swipe(root.querySelector("p")!, [100, 100], [200, 100]);
    expect(rec.move).not.toHaveBeenCalled();
    expect(rec.end).not.toHaveBeenCalled();
  });

  it("ends a live swipe as not released on pointercancel", () => {
    const { root, rec } = surface();
    const text = root.querySelector("p")!;
    pointer("pointerdown", text, 100, 100);
    pointer("pointermove", text, 150, 100);
    pointer("pointercancel", text, 150, 100);
    expect(rec.end).toHaveBeenCalledWith({}, 50, false);
  });

  it("a second finger cancels the swipe", () => {
    const { root, rec } = surface();
    const text = root.querySelector("p")!;
    pointer("pointerdown", text, 100, 100);
    pointer("pointermove", text, 150, 100);
    pointer("pointerdown", text, 300, 300, { pointerId: 2, isPrimary: false });
    expect(rec.end).toHaveBeenCalledWith({}, 50, false);
    pointer("pointerup", text, 150, 100);
    expect(rec.end).toHaveBeenCalledTimes(1);
  });

  it("ignores moves from another pointer", () => {
    const { root, rec } = surface();
    const text = root.querySelector("p")!;
    pointer("pointerdown", text, 100, 100);
    pointer("pointermove", text, 200, 100, { pointerId: 9 });
    expect(rec.start).not.toHaveBeenCalled();
  });

  it("ends a live swipe when its owner goes away", () => {
    const { root, rec, ac } = surface();
    const text = root.querySelector("p")!;
    pointer("pointerdown", text, 100, 100);
    pointer("pointermove", text, 150, 100);
    ac.abort();
    expect(rec.end).toHaveBeenCalledWith({}, 50, false);
    pointer("pointerup", text, 150, 100);
    expect(rec.end).toHaveBeenCalledTimes(1);
  });
});

describe("what a swipe never starts from", () => {
  function started(html: string, pick: (root: HTMLElement) => Element): boolean {
    const { root, rec } = surface(html);
    swipe(pick(root), [100, 100], [200, 100]);
    return rec.begin.mock.calls.length > 0;
  }

  it("starts from plain content", () => {
    expect(started("<p>text</p>", (r) => r.querySelector("p")!)).toBe(true);
  });

  it("not from an input, a textarea, a select or an editable", () => {
    expect(started("<input />", (r) => r.querySelector("input")!)).toBe(false);
    expect(started("<textarea></textarea>", (r) => r.querySelector("textarea")!)).toBe(false);
    expect(started("<select><option>a</option></select>", (r) => r.querySelector("select")!)).toBe(
      false,
    );
    expect(
      started('<div contenteditable="true"><span>x</span></div>', (r) => r.querySelector("span")!),
    ).toBe(false);
  });

  it("not from inside an element that scrolls sideways", () => {
    const html = '<pre style="overflow-x: auto"><code>wide</code></pre>';
    const { root, rec } = surface(html);
    const pre = root.querySelector("pre")!;
    Object.defineProperty(pre, "scrollWidth", { value: 500, configurable: true });
    Object.defineProperty(pre, "clientWidth", { value: 300, configurable: true });
    swipe(root.querySelector("code")!, [100, 100], [200, 100]);
    expect(rec.begin).not.toHaveBeenCalled();
  });

  it("but from one whose content fits, or whose overflow is clipped and cannot be scrolled", () => {
    const { root, rec } = surface(
      '<pre style="overflow-x: auto"><code>fits</code></pre><div style="overflow-x: hidden"><i>clipped</i></div>',
    );
    const pre = root.querySelector("pre")!;
    Object.defineProperty(pre, "scrollWidth", { value: 300, configurable: true });
    Object.defineProperty(pre, "clientWidth", { value: 300, configurable: true });
    const clipped = root.querySelector("div")!;
    Object.defineProperty(clipped, "scrollWidth", { value: 900, configurable: true });
    Object.defineProperty(clipped, "clientWidth", { value: 300, configurable: true });
    swipe(root.querySelector("code")!, [100, 100], [200, 100]);
    swipe(root.querySelector("i")!, [100, 100], [200, 100]);
    expect(rec.begin).toHaveBeenCalledTimes(2);
  });

  it("not from the image viewer", () => {
    const { root, rec } = surface('<div class="image-lightbox"><img alt="" /></div>');
    swipe(root.querySelector("img")!, [100, 100], [200, 100]);
    expect(rec.begin).not.toHaveBeenCalled();
  });

  it("not from inside a bottom sheet, nor anywhere while one is open", () => {
    const { root, rec } = surface("<p>text</p>");
    const content = document.createElement("div");
    content.innerHTML = "<button>One</button>";
    const sheet = openBottomSheet({ label: "Sheet", content });
    swipe(root.querySelector("p")!, [100, 100], [200, 100]);
    expect(rec.begin).not.toHaveBeenCalled();
    sheet.close();
    swipe(root.querySelector("p")!, [100, 100], [200, 100]);
    expect(rec.begin).toHaveBeenCalledTimes(1);
  });

  it("not while a dialog is open", () => {
    const { root, rec } = surface("<p>text</p>");
    const dialog = document.createElement("div");
    dialog.setAttribute("aria-modal", "true");
    document.body.appendChild(dialog);
    swipe(root.querySelector("p")!, [100, 100], [200, 100]);
    expect(rec.begin).not.toHaveBeenCalled();
  });

  it("not while text is selected, nor if a selection starts mid-gesture", () => {
    const { root, rec } = surface("<p>some selectable text</p>");
    const p = root.querySelector("p")!;
    const range = document.createRange();
    range.selectNodeContents(p);
    window.getSelection()?.addRange(range);
    swipe(p, [100, 100], [200, 100]);
    expect(rec.begin).not.toHaveBeenCalled();

    window.getSelection()?.removeAllRanges();
    pointer("pointerdown", p, 100, 100);
    window.getSelection()?.addRange(range);
    pointer("pointermove", p, 200, 100);
    pointer("pointerup", p, 200, 100);
    expect(rec.begin).toHaveBeenCalledTimes(1);
    expect(rec.start).not.toHaveBeenCalled();
    expect(rec.end).not.toHaveBeenCalled();
  });

  it("only looks up to the surface for a sideways scroller", () => {
    const outer = document.createElement("div");
    outer.style.overflowX = "auto";
    Object.defineProperty(outer, "scrollWidth", { value: 900, configurable: true });
    Object.defineProperty(outer, "clientWidth", { value: 300, configurable: true });
    const root = document.createElement("div");
    const leaf = document.createElement("span");
    root.appendChild(leaf);
    outer.appendChild(root);
    document.body.appendChild(outer);
    expect(swipeMayStartOn(leaf, root)).toBe(true);
  });
});
