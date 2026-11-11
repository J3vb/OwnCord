import { describe, it, expect, vi, afterEach } from "vitest";
import { attachPressWarm } from "../../src/lib/nav/pressWarm";
import { setChannelWarmHandler } from "../../src/lib/nav/channelNavigation";

function press(el: HTMLElement, init: Partial<PointerEventInit> = {}): void {
  const e = new Event("pointerdown", { bubbles: true }) as Event & Record<string, unknown>;
  Object.assign(e, {
    pointerType: "mouse",
    button: 0,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ...init,
  });
  el.dispatchEvent(e);
}

describe("attachPressWarm", () => {
  const owner = new AbortController();
  const warm = vi.fn();
  const cancel = vi.fn();
  const off = setChannelWarmHandler({ warm, cancel });
  const el = document.createElement("div");
  attachPressWarm(el, 5, owner.signal);
  afterEach(() => {
    warm.mockClear();
    cancel.mockClear();
  });

  it("starts on a plain primary mouse press", () => {
    press(el);
    expect(warm).toHaveBeenCalledWith(5);
  });

  it.each([
    ["touch", { pointerType: "touch" }],
    ["pen", { pointerType: "pen" }],
    ["right button", { button: 2 }],
    ["ctrl", { ctrlKey: true }],
    ["shift", { shiftKey: true }],
    ["alt", { altKey: true }],
    ["meta", { metaKey: true }],
  ])("ignores %s", (_n, init) => {
    press(el, init);
    expect(warm).not.toHaveBeenCalled();
  });

  it("ignores a press on a button inside the row", () => {
    const button = document.createElement("button");
    el.appendChild(button);
    button.dispatchEvent(
      Object.assign(new Event("pointerdown", { bubbles: true }), {
        pointerType: "mouse",
        button: 0,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        metaKey: false,
      }),
    );
    expect(warm).not.toHaveBeenCalled();
    button.remove();
  });

  it.each(["dragstart", "pointercancel", "pointerleave"])("cancels on %s", (type) => {
    el.dispatchEvent(new Event(type));
    expect(cancel).toHaveBeenCalledWith(5);
  });

  it("stops when its owner aborts and when the handler is unregistered", () => {
    off();
    press(el);
    expect(warm).not.toHaveBeenCalled();
    owner.abort();
  });
});
