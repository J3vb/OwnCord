import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import {
  clampToWindow,
  openMiniPlayer,
  resetMiniPlayerPosition,
  type MiniPlayer,
} from "./miniPlayer";
import { registerVideoSurface } from "../../lib/voice/videoSurface";
import { clearHost, hostAndroidApp } from "../../../tests/helpers/androidHost";

/** jsdom lays nothing out: give the player a size. */
function sized(player: MiniPlayer, width: number, height: number): void {
  Object.defineProperty(player.element, "offsetWidth", { value: width, configurable: true });
  Object.defineProperty(player.element, "offsetHeight", { value: height, configurable: true });
}

function open(overrides: Partial<Parameters<typeof openMiniPlayer>[0]> = {}) {
  const opts = {
    name: "otto",
    video: document.createElement("video"),
    onReturn: vi.fn(),
    onPopout: vi.fn(),
    onStopWatching: vi.fn(),
    onClosed: vi.fn(),
    ...overrides,
  };
  return { opts, player: openMiniPlayer(opts) };
}

describe("mini-player", () => {
  let player: MiniPlayer | null = null;
  afterEach(() => {
    player?.close();
    player = null;
    resetMiniPlayerPosition();
  });

  it("takes a canvas-drawn stream's canvas along with its video (Linux)", () => {
    const track = { kind: "video" } as MediaStreamTrack;
    const canvas = document.createElement("canvas");
    registerVideoSurface(track, canvas);
    const video = document.createElement("video");
    video.srcObject = { getVideoTracks: () => [track] } as unknown as MediaStream;
    player = open({ video }).player;
    expect(video.nextSibling).toBe(canvas);
    expect(player.element.contains(canvas)).toBe(true);
  });

  it("leaves out Pop out in the Android app, and keeps the other controls", () => {
    hostAndroidApp();
    try {
      player = open().player;
      const ids = [...player.element.querySelectorAll<HTMLElement>("button[data-testid]")].map(
        (b) => b.dataset["testid"],
      );
      expect(ids).toEqual(["stream-mini-return", "stream-mini-stop"]);
    } finally {
      clearHost();
    }
  });

  it("keeps a position inside the window", () => {
    expect(clampToWindow(-50, -50, 320, 180)).toEqual({ left: 0, top: 0 });
    expect(clampToWindow(99_999, 99_999, 320, 180)).toEqual({
      left: window.innerWidth - 320,
      top: window.innerHeight - 180,
    });
    expect(clampToWindow(10, 20, 320, 180)).toEqual({ left: 10, top: 20 });
  });

  it("shows the streamer's name and its controls, and takes the video along", () => {
    const opened = open();
    player = opened.player;
    expect(player.element.isConnected).toBe(true);
    expect(player.element.textContent).toContain("otto");
    expect(player.element.contains(opened.opts.video)).toBe(true);
    expect(player.element.getAttribute("aria-label")).toBe("otto's stream, mini player");

    player.element.querySelector<HTMLButtonElement>("[data-testid='stream-mini-return']")!.click();
    player.element.querySelector<HTMLButtonElement>("[data-testid='stream-mini-popout']")!.click();
    player.element.querySelector<HTMLButtonElement>("[data-testid='stream-mini-stop']")!.click();
    expect(opened.opts.onReturn).toHaveBeenCalledTimes(1);
    expect(opened.opts.onPopout).toHaveBeenCalledTimes(1);
    expect(opened.opts.onStopWatching).toHaveBeenCalledTimes(1);
  });

  it("moves with the arrow keys, stops at the edge, and Enter returns", () => {
    const opened = open();
    player = opened.player;
    sized(player, 320, 180);
    const el = player.element;
    // Re-place at the corner through the keys: clamped at 0.
    for (let i = 0; i < 200; i++) {
      el.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    }
    expect(el.style.left).toBe("0px");
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(opened.opts.onReturn).toHaveBeenCalledTimes(1);
  });

  it("opens where the last one was left, for the session", () => {
    const first = open();
    sized(first.player, 320, 180);
    first.player.element.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }),
    );
    const left = first.player.element.style.left;
    const top = first.player.element.style.top;
    first.player.close();

    const second = open();
    player = second.player;
    expect(player.element.style.left).toBe(left);
    expect(player.element.style.top).toBe(top);
  });

  it("close removes it and reports once", () => {
    const opened = open();
    opened.player.close();
    opened.player.close();
    expect(opened.player.element.isConnected).toBe(false);
    expect(opened.opts.onClosed).toHaveBeenCalledTimes(1);
  });
});

const px = (value: string): number => Number.parseFloat(value) || 0;

/** Lay the player out: a size, and `offsetLeft`/`offsetTop` that follow its inline style. */
function laidOut(player: MiniPlayer, width: number, height: number): void {
  sized(player, width, height);
  Object.defineProperty(player.element, "offsetLeft", {
    get: () => px(player.element.style.left),
    configurable: true,
  });
  Object.defineProperty(player.element, "offsetTop", {
    get: () => px(player.element.style.top),
    configurable: true,
  });
}

function pointer(
  type: string,
  target: Element,
  init: { x?: number; y?: number; id?: number; button?: number } = {},
): PointerEvent {
  const event = new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: init.x ?? 0,
    clientY: init.y ?? 0,
    pointerId: init.id ?? 1,
    button: init.button ?? 0,
  });
  target.dispatchEvent(event);
  return event;
}

function key(target: Element, name: string): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

describe("mini-player markup", () => {
  let player: MiniPlayer | null = null;
  afterEach(() => {
    player?.close();
    player = null;
    resetMiniPlayerPosition();
  });

  it("is a labelled, focusable region described by a screen-reader hint", () => {
    player = open().player;
    const el = player.element;
    expect(el.classList.contains("stream-mini")).toBe(true);
    expect(el.getAttribute("role")).toBe("region");
    expect(el.getAttribute("tabindex")).toBe("0");
    expect(el.getAttribute("aria-describedby")).toBe("stream-mini-hint");
    const hint = el.querySelector("#stream-mini-hint");
    expect(hint?.classList.contains("sr-only")).toBe(true);
    expect(hint?.textContent).not.toBe("");
  });

  it("lays out the name and the control row with icon buttons", () => {
    player = open().player;
    const el = player.element;
    expect(el.querySelector(".stream-mini__name")?.textContent).toBe("otto");
    const controls = el.querySelector(".stream-mini__controls");
    expect(controls).not.toBeNull();
    const buttons = [...controls!.querySelectorAll("button")];
    expect(buttons).toHaveLength(3);
    for (const btn of buttons) {
      expect(btn.getAttribute("type")).toBe("button");
      expect(btn.classList.contains("video-tile-btn")).toBe(true);
      expect(btn.querySelector("svg")).not.toBeNull();
      expect(btn.getAttribute("aria-label")).toBe(btn.title);
      expect(btn.getAttribute("aria-label")).not.toBe("");
    }
  });

  it("stops reacting to its controls, keys, pointer and window once closed", () => {
    const opened = open();
    const el = opened.player.element;
    laidOut(opened.player, 320, 180);
    const buttons = [...el.querySelectorAll("button")];
    opened.player.close();

    for (const btn of buttons) btn.click();
    el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    key(el, "Enter");
    key(el, "ArrowRight");
    pointer("pointerdown", el, { x: 5, y: 5 });
    window.dispatchEvent(new Event("resize"));

    expect(opened.opts.onReturn).not.toHaveBeenCalled();
    expect(opened.opts.onPopout).not.toHaveBeenCalled();
    expect(opened.opts.onStopWatching).not.toHaveBeenCalled();
    expect(el.classList.contains("stream-mini--dragging")).toBe(false);
  });

  it("stops listening for the drag's pointermove, pointerup and pointercancel once closed", () => {
    const opened = open();
    const el = opened.player.element;
    laidOut(opened.player, 320, 180);
    el.style.left = "100px";
    el.style.top = "100px";
    pointer("pointerdown", el, { x: 110, y: 110 });
    opened.player.close();

    pointer("pointermove", el, { x: 400, y: 400 });
    expect(el.style.left).toBe("100px");
    expect(el.style.top).toBe("100px");
    pointer("pointerup", el);
    expect(el.classList.contains("stream-mini--dragging")).toBe(true);
    pointer("pointercancel", el);
    expect(el.classList.contains("stream-mini--dragging")).toBe(true);
  });
});

function layoutEveryPlayer(width: number, height: number): void {
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    get(this: HTMLElement) {
      return this.classList.contains("stream-mini") ? width : 0;
    },
    configurable: true,
  });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    get(this: HTMLElement) {
      return this.classList.contains("stream-mini") ? height : 0;
    },
    configurable: true,
  });
}

describe("mini-player placement", () => {
  let player: MiniPlayer | null = null;
  const sizeBefore = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth");
  const heightBefore = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");

  afterEach(() => {
    player?.close();
    player = null;
    resetMiniPlayerPosition();
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", sizeBefore!);
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", heightBefore!);
  });

  it("first opens at the bottom right, clear of the composer", () => {
    layoutEveryPlayer(320, 180);
    player = open().player;
    expect(player.element.style.left).toBe(`${window.innerWidth - 320 - 16}px`);
    expect(player.element.style.top).toBe(`${window.innerHeight - 180 - 96}px`);
  });

  it("returns to the default corner once the remembered position is forgotten", () => {
    layoutEveryPlayer(320, 180);
    const first = open();
    first.player.element.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }),
    );
    const moved = first.player.element.style.left;
    first.player.close();
    expect(moved).toBe("0px");

    resetMiniPlayerPosition();
    player = open().player;
    expect(player.element.style.left).toBe(`${window.innerWidth - 320 - 16}px`);
  });

  it("moves back inside a window that shrinks", () => {
    const innerWidth = window.innerWidth;
    player = open().player;
    laidOut(player, 320, 180);
    player.element.style.left = "700px";
    player.element.style.top = "100px";
    try {
      Object.defineProperty(window, "innerWidth", { value: 500, configurable: true });
      window.dispatchEvent(new Event("resize"));
      expect(player.element.style.left).toBe("180px");
      expect(player.element.style.top).toBe("100px");
    } finally {
      Object.defineProperty(window, "innerWidth", { value: innerWidth, configurable: true });
    }
  });
});

describe("mini-player dragging", () => {
  let player: MiniPlayer | null = null;
  let opts: ReturnType<typeof open>["opts"];
  let el: HTMLElement;

  beforeEach(() => {
    const opened = open();
    player = opened.player;
    opts = opened.opts;
    el = player.element;
    laidOut(player, 320, 180);
    el.style.left = "100px";
    el.style.top = "50px";
  });

  afterEach(() => {
    player?.close();
    player = null;
    resetMiniPlayerPosition();
  });

  it("follows the pointer by the offset it grabbed the player at", () => {
    const down = pointer("pointerdown", el, { x: 130, y: 70 });
    expect(down.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(el);
    expect(el.classList.contains("stream-mini--dragging")).toBe(true);

    pointer("pointermove", el, { x: 330, y: 270 });
    expect(el.style.left).toBe("300px");
    expect(el.style.top).toBe("250px");
  });

  it("captures the pointer so the drag survives leaving the player", () => {
    const capture = vi.fn();
    Object.defineProperty(el, "setPointerCapture", { value: capture, configurable: true });
    pointer("pointerdown", el, { x: 130, y: 70, id: 7 });
    expect(capture).toHaveBeenCalledWith(7);
  });

  it("starts a drag even where the platform has no pointer capture", () => {
    expect("setPointerCapture" in el).toBe(false);
    pointer("pointerdown", el, { x: 130, y: 70 });
    expect(el.classList.contains("stream-mini--dragging")).toBe(true);
  });

  it("ignores moves from another pointer while dragging", () => {
    pointer("pointerdown", el, { x: 130, y: 70, id: 1 });
    pointer("pointermove", el, { x: 330, y: 270, id: 2 });
    expect(el.style.left).toBe("100px");
    expect(el.style.top).toBe("50px");
  });

  it("does not move on a pointermove before any drag started", () => {
    pointer("pointermove", el, { x: 330, y: 270 });
    expect(el.style.left).toBe("100px");
    expect(el.style.top).toBe("50px");
  });

  it("ends only for the pointer that started it, on release or cancel", () => {
    pointer("pointerdown", el, { x: 130, y: 70, id: 1 });
    pointer("pointerup", el, { id: 2 });
    expect(el.classList.contains("stream-mini--dragging")).toBe(true);
    pointer("pointercancel", el, { id: 2 });
    expect(el.classList.contains("stream-mini--dragging")).toBe(true);

    pointer("pointerup", el, { id: 1 });
    expect(el.classList.contains("stream-mini--dragging")).toBe(false);
    pointer("pointermove", el, { x: 330, y: 270, id: 1 });
    expect(el.style.left).toBe("100px");

    pointer("pointerdown", el, { x: 130, y: 70, id: 1 });
    pointer("pointercancel", el, { id: 1 });
    expect(el.classList.contains("stream-mini--dragging")).toBe(false);
    pointer("pointermove", el, { x: 330, y: 270, id: 1 });
    expect(el.style.left).toBe("100px");
  });

  it("does not start from a control button or a non-primary button", () => {
    const stop = el.querySelector<HTMLElement>("[data-testid='stream-mini-stop']")!;
    const fromButton = pointer("pointerdown", stop, { x: 130, y: 70 });
    expect(fromButton.defaultPrevented).toBe(false);
    expect(el.classList.contains("stream-mini--dragging")).toBe(false);

    const secondary = pointer("pointerdown", el, { x: 130, y: 70, button: 2 });
    expect(secondary.defaultPrevented).toBe(false);
    expect(el.classList.contains("stream-mini--dragging")).toBe(false);
    pointer("pointermove", el, { x: 330, y: 270 });
    expect(el.style.left).toBe("100px");
  });

  it("keeps the dragged player inside the window", () => {
    pointer("pointerdown", el, { x: 130, y: 70 });
    pointer("pointermove", el, { x: -500, y: 99_999 });
    expect(el.style.left).toBe("0px");
    expect(el.style.top).toBe(`${window.innerHeight - 180}px`);
  });

  it("returns to the full view on a double-click anywhere but a control", () => {
    el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(opts.onReturn).toHaveBeenCalledTimes(1);
    el.querySelector("[data-testid='stream-mini-stop']")!.dispatchEvent(
      new MouseEvent("dblclick", { bubbles: true }),
    );
    el.querySelector(".stream-mini__name")!.dispatchEvent(
      new MouseEvent("dblclick", { bubbles: true }),
    );
    expect(opts.onReturn).toHaveBeenCalledTimes(2);
  });
});

describe("mini-player keyboard", () => {
  let player: MiniPlayer | null = null;
  let opts: ReturnType<typeof open>["opts"];
  let el: HTMLElement;

  beforeEach(() => {
    const opened = open();
    player = opened.player;
    opts = opened.opts;
    el = player.element;
    laidOut(player, 320, 180);
    el.style.left = "100px";
    el.style.top = "100px";
  });

  afterEach(() => {
    player?.close();
    player = null;
    resetMiniPlayerPosition();
  });

  it.each([
    ["ArrowLeft", "76px", "100px"],
    ["ArrowRight", "124px", "100px"],
    ["ArrowUp", "100px", "76px"],
    ["ArrowDown", "100px", "124px"],
  ])("%s moves it 24px and keeps the page from scrolling", (name, left, top) => {
    const event = key(el, name);
    expect(event.defaultPrevented).toBe(true);
    expect(el.style.left).toBe(left);
    expect(el.style.top).toBe(top);
    expect(opts.onReturn).not.toHaveBeenCalled();
  });

  it("Enter returns to the full view and is consumed", () => {
    const event = key(el, "Enter");
    expect(event.defaultPrevented).toBe(true);
    expect(opts.onReturn).toHaveBeenCalledTimes(1);
  });

  it("leaves other keys alone", () => {
    for (const name of ["a", "Tab", " ", "Escape"]) {
      const event = key(el, name);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(opts.onReturn).not.toHaveBeenCalled();
    expect(el.style.left).toBe("100px");
    expect(el.style.top).toBe("100px");
  });

  it("ignores keys pressed on a control inside it", () => {
    const stop = el.querySelector<HTMLElement>("[data-testid='stream-mini-stop']")!;
    expect(key(stop, "Enter").defaultPrevented).toBe(false);
    expect(key(stop, "ArrowRight").defaultPrevented).toBe(false);
    expect(opts.onReturn).not.toHaveBeenCalled();
    expect(el.style.left).toBe("100px");
  });
});
