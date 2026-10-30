import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installTouchInput } from "../../src/lib/ui/touchInput";

type VV = EventTarget & { height: number; scale: number };

let ctrl: AbortController;
let vv: VV;
let hoverNone: boolean;
let scrollTo: ReturnType<typeof vi.fn>;
let menus: MouseEvent[];

function touch(type: string, target: Element, x = 20, y = 20, isPrimary = true): void {
  target.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerType: "touch",
      isPrimary,
      clientX: x,
      clientY: y,
    }),
  );
}

function el(html: string): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = html;
  document.body.appendChild(host);
  return host;
}

beforeEach(() => {
  vi.useFakeTimers();
  ctrl = new AbortController();
  hoverNone = true;
  vi.stubGlobal(
    "matchMedia",
    vi.fn((q: string) => ({ matches: q === "(hover: none)" && hoverNone })),
  );
  vv = Object.assign(new EventTarget(), { height: 500, scale: 1 });
  Object.defineProperty(window, "visualViewport", { value: vv, configurable: true });
  scrollTo = vi.fn();
  vi.stubGlobal("scrollTo", scrollTo);
  menus = [];
  document.addEventListener("contextmenu", (e) => menus.push(e), { signal: ctrl.signal });
  installTouchInput(ctrl.signal);
});

afterEach(() => {
  ctrl.abort();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
  document.documentElement.style.removeProperty("--app-height");
});

describe("long-press", () => {
  it("dispatches one contextmenu at the finger on the original target after 500 ms", () => {
    const host = el('<div class="message"><span id="t">hi</span></div>');
    const t = host.querySelector("#t")!;
    touch("pointerdown", t, 33, 44);
    vi.advanceTimersByTime(499);
    expect(menus).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(menus).toHaveLength(1);
    expect(menus[0]!.target).toBe(t);
    expect(menus[0]!.clientX).toBe(33);
    expect(menus[0]!.clientY).toBe(44);
    expect(menus[0]!.bubbles).toBe(true);
    expect(menus[0]!.cancelable).toBe(true);
  });

  it("ignores mouse pointers", () => {
    const host = el('<div class="message"></div>');
    host.firstElementChild!.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse" }),
    );
    vi.advanceTimersByTime(600);
    expect(menus).toHaveLength(0);
  });

  it("does not fire on text fields", () => {
    const host = el("<textarea></textarea>");
    touch("pointerdown", host.firstElementChild!);
    vi.advanceTimersByTime(600);
    expect(menus).toHaveLength(0);
  });

  it("is cancelled by a move over 10 px but not by a smaller one", () => {
    const t = el('<div class="message"></div>').firstElementChild!;
    touch("pointerdown", t, 0, 0);
    touch("pointermove", t, 6, 6);
    vi.advanceTimersByTime(500);
    expect(menus).toHaveLength(1);
    touch("pointerup", t);
    touch("pointerdown", t, 0, 0);
    touch("pointermove", t, 11, 0);
    vi.advanceTimersByTime(600);
    expect(menus).toHaveLength(1);
  });

  it("is cancelled by pointerup", () => {
    const t = el('<div class="message"></div>').firstElementChild!;
    touch("pointerdown", t);
    vi.advanceTimersByTime(300);
    touch("pointerup", t);
    vi.advanceTimersByTime(600);
    expect(menus).toHaveLength(0);
  });

  it("is cancelled by pointercancel", () => {
    const t = el('<div class="message"></div>').firstElementChild!;
    touch("pointerdown", t);
    touch("pointercancel", t);
    vi.advanceTimersByTime(600);
    expect(menus).toHaveLength(0);
  });

  it("is cancelled by a scroll", () => {
    const t = el('<div class="message"></div>').firstElementChild!;
    touch("pointerdown", t);
    t.dispatchEvent(new Event("scroll"));
    vi.advanceTimersByTime(600);
    expect(menus).toHaveLength(0);
  });
});

describe("native contextmenu dedupe", () => {
  function native(target: Element): MouseEvent {
    const e = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    target.dispatchEvent(e);
    return e;
  }

  it("a native event during the pending timer means no synthetic one", () => {
    const t = el('<div class="message"></div>').firstElementChild!;
    touch("pointerdown", t);
    vi.advanceTimersByTime(400);
    native(t);
    vi.advanceTimersByTime(600);
    expect(menus).toHaveLength(1);
    expect(menus[0]!.clientX).toBe(0);
  });

  it("a late native event after a synthetic one is cancelled and stopped", () => {
    const t = el('<div class="message"></div>').firstElementChild!;
    const bubbled = vi.fn();
    document.body.addEventListener("contextmenu", bubbled);
    touch("pointerdown", t);
    vi.advanceTimersByTime(500);
    expect(bubbled).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(100);
    const late = native(t);
    expect(late.defaultPrevented).toBe(true);
    expect(bubbled).toHaveBeenCalledTimes(1);
    document.body.removeEventListener("contextmenu", bubbled);
  });

  it("a native event well after the synthetic one and the lift passes through", () => {
    const t = el('<div class="message"></div>').firstElementChild!;
    touch("pointerdown", t);
    vi.advanceTimersByTime(500);
    touch("pointerup", t);
    vi.advanceTimersByTime(1000);
    const later = native(t);
    expect(later.defaultPrevented).toBe(false);
  });
});

describe("click after a long-press", () => {
  it("cancels the first click within 600 ms, once", () => {
    const t = el('<button class="row">x</button>').firstElementChild as HTMLElement;
    const onClick = vi.fn();
    t.addEventListener("click", onClick);
    touch("pointerdown", t);
    vi.advanceTimersByTime(500);
    touch("pointerup", t);
    vi.advanceTimersByTime(100);
    const first = new MouseEvent("click", { bubbles: true, cancelable: true });
    t.dispatchEvent(first);
    expect(first.defaultPrevented).toBe(true);
    expect(onClick).not.toHaveBeenCalled();
    t.click();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("lets a click through after the 600 ms window", () => {
    const t = el('<button class="row">x</button>').firstElementChild as HTMLElement;
    const onClick = vi.fn();
    t.addEventListener("click", onClick);
    touch("pointerdown", t);
    vi.advanceTimersByTime(500);
    touch("pointerup", t);
    vi.advanceTimersByTime(601);
    t.click();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("does not touch clicks when no long-press fired", () => {
    const t = el('<button class="row">x</button>').firstElementChild as HTMLElement;
    const onClick = vi.fn();
    t.addEventListener("click", onClick);
    touch("pointerdown", t);
    touch("pointerup", t);
    t.click();
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe("tap shows message actions", () => {
  function tap(target: Element): void {
    touch("pointerdown", target);
    touch("pointerup", target);
  }
  const rows =
    '<div class="message" id="a"><span class="body">a</span><button class="b">b</button></div>' +
    '<div class="message" id="b2"><span class="body">b</span></div><div id="outside">o</div>';

  it("marks at most one message and moves the mark", () => {
    const host = el(rows);
    tap(host.querySelector("#a .body")!);
    expect(host.querySelector("#a")!.classList.contains("msg-touch-active")).toBe(true);
    tap(host.querySelector("#b2 .body")!);
    expect(host.querySelectorAll(".msg-touch-active")).toHaveLength(1);
    expect(host.querySelector("#b2")!.classList.contains("msg-touch-active")).toBe(true);
  });

  it("leaves interactive targets alone", () => {
    const host = el(rows);
    tap(host.querySelector("#a .b")!);
    expect(host.querySelectorAll(".msg-touch-active")).toHaveLength(0);
  });

  it("still marks a message row that is itself focusable", () => {
    const host = el('<div class="message" tabindex="0"><span class="body">a</span></div>');
    tap(host.querySelector(".body")!);
    expect(host.querySelectorAll(".msg-touch-active")).toHaveLength(1);
  });

  it("clears on a tap outside any message", () => {
    const host = el(rows);
    tap(host.querySelector("#a .body")!);
    tap(host.querySelector("#outside")!);
    expect(host.querySelectorAll(".msg-touch-active")).toHaveLength(0);
  });

  it("does nothing when the device can hover", () => {
    hoverNone = false;
    const host = el(rows);
    tap(host.querySelector("#a .body")!);
    expect(host.querySelectorAll(".msg-touch-active")).toHaveLength(0);
  });

  it("does not mark after a long-press", () => {
    const host = el(rows);
    const t = host.querySelector("#a .body")!;
    touch("pointerdown", t);
    vi.advanceTimersByTime(500);
    touch("pointerup", t);
    expect(host.querySelectorAll(".msg-touch-active")).toHaveLength(0);
  });
});

describe("review fixes", () => {
  it("lets the first tap on a menu item through when the lift sent no click", () => {
    const host = el(
      '<div class="message"><span id="t">hi</span></div><button id="item">x</button>',
    );
    const t = host.querySelector("#t")!;
    const item = host.querySelector("#item")!;
    touch("pointerdown", t);
    vi.advanceTimersByTime(500);
    touch("pointerup", t);
    touch("pointerdown", item);
    touch("pointerup", item);
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    item.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(false);
  });

  it("swallows the lift's compatibility mousedown after a long-press, not a later one", () => {
    const host = el('<div class="message"><span id="t">hi</span></div>');
    const t = host.querySelector("#t")!;
    const seen: string[] = [];
    document.addEventListener("mousedown", () => seen.push("down"), { signal: ctrl.signal });
    touch("pointerdown", t);
    vi.advanceTimersByTime(500);
    touch("pointerup", t);
    t.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    expect(seen).toEqual([]);
    touch("pointerdown", t);
    t.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    expect(seen).toEqual(["down"]);
  });

  it("cancels a pending long-press when a second finger lands", () => {
    const host = el('<div class="message"><span id="t">hi</span></div>');
    const t = host.querySelector("#t")!;
    touch("pointerdown", t);
    touch("pointerdown", t, 80, 80, false);
    vi.advanceTimersByTime(600);
    expect(menus).toHaveLength(0);
  });

  it("does not mark the message when the webview's own menu opened during the hold", () => {
    const host = el('<div class="message" id="a"><span class="body">a</span></div>');
    const t = host.querySelector(".body")!;
    touch("pointerdown", t);
    t.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    touch("pointerup", t);
    expect(host.querySelector(".msg-touch-active")).toBeNull();
  });

  it("leaves #app its own height while pinch-zoomed", () => {
    vv.height = 300;
    vv.dispatchEvent(new Event("resize"));
    expect(document.documentElement.style.getPropertyValue("--app-height")).toBe("300px");
    vv.scale = 2;
    vv.dispatchEvent(new Event("resize"));
    expect(document.documentElement.style.getPropertyValue("--app-height")).toBe("");
  });
});

describe("keyboard height", () => {
  it("writes --app-height and scrolls to the top on visualViewport resize and scroll", () => {
    vv.height = 312;
    vv.dispatchEvent(new Event("resize"));
    expect(document.documentElement.style.getPropertyValue("--app-height")).toBe("312px");
    expect(scrollTo).toHaveBeenCalledWith(0, 0);
    vv.height = 400;
    scrollTo.mockClear();
    vv.dispatchEvent(new Event("scroll"));
    expect(document.documentElement.style.getPropertyValue("--app-height")).toBe("400px");
    expect(scrollTo).toHaveBeenCalledTimes(1);
  });
});

describe("abort", () => {
  it("removes the property, the mark, the pending timer and every listener", () => {
    const host = el('<div class="message" id="a"><span class="body">a</span></div>');
    const t = host.querySelector(".body")!;
    vv.dispatchEvent(new Event("resize"));
    touch("pointerdown", t);
    touch("pointerup", t);
    expect(host.querySelector("#a")!.classList.contains("msg-touch-active")).toBe(true);
    touch("pointerdown", t);
    ctrl.abort();
    expect(document.documentElement.style.getPropertyValue("--app-height")).toBe("");
    expect(host.querySelector(".msg-touch-active")).toBeNull();
    vi.advanceTimersByTime(600);
    expect(menus).toHaveLength(0);
    vv.height = 99;
    vv.dispatchEvent(new Event("resize"));
    expect(document.documentElement.style.getPropertyValue("--app-height")).toBe("");
    touch("pointerdown", t);
    touch("pointerup", t);
    expect(host.querySelector(".msg-touch-active")).toBeNull();
  });
});
