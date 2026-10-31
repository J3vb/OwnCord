import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openPopout, openPopoutWindow, type Popout } from "../../src/features/voice/popout";

/**
 * A stand-in for the desktop window `window.open` returns: an event target
 * with its own document, a `closed` flag and close/focus spies.
 */
class FakeWindow extends EventTarget {
  document: Document = document.implementation.createHTMLDocument("popup");
  closed = false;
  readonly close = vi.fn(() => {
    this.closed = true;
  });
  readonly focus = vi.fn();
  /** The user closing the window with the system's close button. */
  closeByUser(): void {
    this.closed = true;
  }
  /** The window loading its URL: a fresh, empty document replaces the drawn one. */
  reload(): void {
    this.document = document.implementation.createHTMLDocument("reloaded");
    this.dispatchEvent(new Event("load"));
  }
}

let wins: FakeWindow[];
let openSpy: ReturnType<typeof vi.spyOn>;
let open: (win: FakeWindow | null) => void;
let opened: Array<{ url: string; name: string; features: string }>;
let toClose: Popout[];

function track<T extends Popout | null>(p: T): T {
  if (p !== null) toClose.push(p);
  return p;
}

beforeEach(() => {
  vi.useFakeTimers();
  wins = [];
  opened = [];
  toClose = [];
  let next: FakeWindow | null | undefined;
  open = (win) => {
    next = win;
  };
  openSpy = vi.spyOn(window, "open").mockImplementation((url, name, features) => {
    opened.push({ url: String(url), name: String(name), features: String(features) });
    const win = next === undefined ? new FakeWindow() : next;
    next = undefined;
    if (win !== null) wins.push(win);
    return win as unknown as Window | null;
  });
});

afterEach(() => {
  for (const p of toClose) p.close();
  openSpy.mockRestore();
  vi.useRealTimers();
  document.head.replaceChildren();
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("class");
});

function content(): HTMLElement {
  const el = document.createElement("section");
  el.id = "popout-content";
  return el;
}

describe("openPopoutWindow", () => {
  it("opens a popup window with a never-reused label in its URL and name", () => {
    const a = track(openPopoutWindow({ title: "A", content: content(), onClosed: vi.fn() }))!;
    const b = track(openPopoutWindow({ title: "B", content: content(), onClosed: vi.fn() }))!;
    expect(a.label).toMatch(/^owncord-popout-\d+$/);
    expect(b.label).not.toBe(a.label);
    expect(opened[0]).toEqual({
      url: `about:blank#${a.label}`,
      name: a.label,
      features: "popup,width=960,height=540",
    });
    expect(opened[1]!.name).toBe(b.label);
  });

  it("returns null and starts no timers when no window could open", () => {
    open(null);
    const onClosed = vi.fn();
    expect(openPopoutWindow({ title: "A", content: content(), onClosed })).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(5_000);
    expect(onClosed).not.toHaveBeenCalled();
  });

  it("moves the content into the window's document with its title, theme and styles", () => {
    document.documentElement.setAttribute("data-theme", "dark");
    document.documentElement.className = "app-root";
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "https://app.test/styles.css";
    const style = document.createElement("style");
    style.textContent = ".x { color: red; }";
    const icon = document.createElement("link");
    icon.rel = "icon";
    icon.href = "https://app.test/icon.png";
    document.head.append(link, style, icon);

    const el = content();
    const onDraw = vi.fn();
    track(openPopoutWindow({ title: "Stream of Ann", content: el, onDraw, onClosed: vi.fn() }));
    const doc = wins[0]!.document;

    expect(doc.title).toBe("Stream of Ann");
    expect(doc.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(doc.documentElement.className).toBe("app-root");
    expect(doc.body.contains(el)).toBe(true);
    const copiedLink = doc.head.querySelector("link[rel='stylesheet']");
    expect(copiedLink?.getAttribute("href")).toBe("https://app.test/styles.css");
    expect(doc.head.querySelector("style")?.textContent).toBe(".x { color: red; }");
    expect(doc.head.querySelector("link[rel='icon']")).toBeNull();
    expect(doc.head.querySelectorAll("link, style")).toHaveLength(2);
    expect(onDraw).toHaveBeenCalledTimes(1);
    expect(onDraw.mock.calls[0]![0]).toBe(doc);
    expect(onDraw.mock.calls[0]![1]).toBeInstanceOf(AbortSignal);
  });

  it("follows the app's root attributes while the window is open, and stops once it closes", async () => {
    document.documentElement.setAttribute("data-theme", "dark");
    const p = openPopoutWindow({ title: "A", content: content(), onClosed: vi.fn() })!;
    const root = wins[0]!.document.documentElement;
    expect(root.getAttribute("data-theme")).toBe("dark");
    expect(root.classList.contains("mirror-self-camera")).toBe(false);

    document.documentElement.classList.add("mirror-self-camera");
    document.documentElement.setAttribute("data-theme", "light");
    await Promise.resolve();
    expect(root.classList.contains("mirror-self-camera")).toBe(true);
    expect(root.getAttribute("data-theme")).toBe("light");

    document.documentElement.removeAttribute("class");
    await Promise.resolve();
    expect(root.hasAttribute("class")).toBe(false);

    p.close();
    document.documentElement.classList.add("mirror-self-camera");
    await Promise.resolve();
    expect(root.hasAttribute("class")).toBe(false);
  });

  it("does not draw twice into a document that already holds the content", () => {
    const onDraw = vi.fn();
    track(openPopoutWindow({ title: "A", content: content(), onDraw, onClosed: vi.fn() }));
    wins[0]!.dispatchEvent(new Event("load"));
    expect(onDraw).toHaveBeenCalledTimes(1);
  });

  it("draws again when the window loads a new document", () => {
    const el = content();
    const onDraw = vi.fn();
    track(openPopoutWindow({ title: "T", content: el, onDraw, onClosed: vi.fn() }));
    wins[0]!.reload();
    expect(onDraw).toHaveBeenCalledTimes(2);
    expect(wins[0]!.document.body.contains(el)).toBe(true);
    expect(wins[0]!.document.title).toBe("T");
  });

  it("reports a close by the user once, at the next check", () => {
    const onClosed = vi.fn();
    track(openPopoutWindow({ title: "A", content: content(), onClosed }));
    vi.advanceTimersByTime(299);
    wins[0]!.closeByUser();
    vi.advanceTimersByTime(0);
    expect(onClosed).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onClosed).toHaveBeenCalledTimes(1);
    expect(onClosed).toHaveBeenCalledWith(true);
    vi.advanceTimersByTime(3_000);
    expect(onClosed).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the window while nobody closes it", () => {
    const onClosed = vi.fn();
    track(openPopoutWindow({ title: "A", content: content(), onClosed }));
    vi.advanceTimersByTime(10_000);
    expect(onClosed).not.toHaveBeenCalled();
    expect(wins[0]!.close).not.toHaveBeenCalled();
  });

  it("closes the window itself and reports a close that was not the user's", () => {
    const onClosed = vi.fn();
    const popout = openPopoutWindow({ title: "A", content: content(), onClosed })!;
    popout.close();
    expect(wins[0]!.close).toHaveBeenCalledTimes(1);
    expect(onClosed).toHaveBeenCalledTimes(1);
    expect(onClosed).toHaveBeenCalledWith(false);
    popout.close();
    expect(wins[0]!.close).toHaveBeenCalledTimes(1);
    expect(onClosed).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not close a window that is already closed", () => {
    const onClosed = vi.fn();
    const popout = openPopoutWindow({ title: "A", content: content(), onClosed })!;
    wins[0]!.closeByUser();
    popout.close();
    expect(wins[0]!.close).not.toHaveBeenCalled();
    expect(onClosed).toHaveBeenCalledWith(false);
  });

  it("ignores the window loading after it was closed while it was still opening", () => {
    const el = content();
    const onDraw = vi.fn();
    const onClosed = vi.fn();
    const popout = openPopoutWindow({ title: "A", content: el, onDraw, onClosed })!;
    popout.close();
    wins[0]!.reload();
    expect(onDraw).toHaveBeenCalledTimes(1);
    expect(wins[0]!.document.body.contains(el)).toBe(false);
    expect(onClosed).toHaveBeenCalledTimes(1);
  });

  it("takes the window along when the app page goes away", () => {
    track(openPopoutWindow({ title: "A", content: content(), onClosed: vi.fn() }));
    window.dispatchEvent(new Event("pagehide"));
    expect(wins[0]!.close).toHaveBeenCalledTimes(1);
  });

  it("stops watching the app page once the window is closed", () => {
    const popout = openPopoutWindow({ title: "A", content: content(), onClosed: vi.fn() })!;
    popout.close();
    wins[0]!.close.mockClear();
    window.dispatchEvent(new Event("pagehide"));
    expect(wins[0]!.close).not.toHaveBeenCalled();
  });

  it("brings the window to the front on focus()", () => {
    const popout = track(openPopoutWindow({ title: "A", content: content(), onClosed: vi.fn() }))!;
    popout.focus();
    expect(wins[0]!.focus).toHaveBeenCalledTimes(1);
  });
});

function video(): HTMLVideoElement {
  const v = document.createElement("video");
  v.play = vi.fn(() => Promise.resolve());
  return v;
}

function key(doc: Document, init: KeyboardEventInit): KeyboardEvent {
  const e = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  doc.dispatchEvent(e);
  return e;
}

function setupPopout(extra: { controls?: HTMLElement; fullscreen?: boolean } = {}) {
  const v = video();
  const onClosed = vi.fn();
  const setWindowFullscreen = vi.fn(() => Promise.resolve());
  const popout = track(
    openPopout({
      title: "Ann's screen",
      video: v,
      controls: extra.controls,
      onClosed,
      setWindowFullscreen: extra.fullscreen === false ? undefined : setWindowFullscreen,
    }),
  )!;
  const doc = wins[wins.length - 1]!.document;
  const root = doc.querySelector<HTMLElement>(".video-popout")!;
  const button = root.querySelector<HTMLButtonElement>("[data-popout-control='fullscreen']")!;
  return { v, onClosed, setWindowFullscreen, popout, doc, root, button };
}

describe("openPopout", () => {
  it("returns null when no window could open", () => {
    open(null);
    const onClosed = vi.fn();
    expect(openPopout({ title: "x", video: video(), onClosed })).toBeNull();
    expect(onClosed).not.toHaveBeenCalled();
  });

  it("puts the video, the controls and the full screen button in the window, and plays", () => {
    const controls = document.createElement("div");
    controls.className = "ctl";
    const { v, doc, root, button } = setupPopout({ controls });
    expect(doc.title).toBe("Ann's screen");
    expect([...root.childNodes]).toEqual([v, controls, button]);
    expect(button.tagName).toBe("BUTTON");
    expect(button.type).toBe("button");
    expect(button.className).toBe("video-tile-btn video-popout__fullscreen");
    expect(v.play).toHaveBeenCalledTimes(1);
  });

  it("omits the controls slot when there are none", () => {
    const { v, root, button } = setupPopout();
    expect([...root.childNodes]).toEqual([v, button]);
  });

  it("starts out offering full screen", () => {
    const { button, setWindowFullscreen } = setupPopout();
    expect(button.getAttribute("aria-label")).toBe("Full screen");
    expect(button.title).toBe("Full screen");
    expect(button.querySelector("svg")).not.toBeNull();
    expect(setWindowFullscreen).not.toHaveBeenCalled();
  });

  it("survives a video whose play() rejects or returns nothing", async () => {
    const v = document.createElement("video");
    v.play = vi.fn(() => Promise.reject(new Error("blocked")));
    const popout = track(openPopout({ title: "x", video: v, onClosed: vi.fn() }));
    expect(popout).not.toBeNull();
    await Promise.resolve();
    const w = document.createElement("video");
    w.play = vi.fn(() => undefined as unknown as Promise<void>);
    expect(track(openPopout({ title: "y", video: w, onClosed: vi.fn() }))).not.toBeNull();
  });

  it("goes full screen on the F key when the page cannot, and follows it with the window", async () => {
    const { doc, button, setWindowFullscreen } = setupPopout();
    const idle = button.innerHTML;
    const e = key(doc, { key: "f" });
    expect(e.defaultPrevented).toBe(true);
    expect(setWindowFullscreen).toHaveBeenCalledTimes(1);
    expect(setWindowFullscreen).toHaveBeenLastCalledWith(true, opened[opened.length - 1]!.name);
    expect(button.getAttribute("aria-label")).toBe("Exit full screen");
    expect(button.title).toBe("Exit full screen");
    expect(button.innerHTML).not.toBe(idle);

    key(doc, { key: "F" });
    expect(setWindowFullscreen).toHaveBeenCalledTimes(2);
    expect(setWindowFullscreen).toHaveBeenLastCalledWith(false, opened[opened.length - 1]!.name);
    expect(button.getAttribute("aria-label")).toBe("Full screen");
    expect(button.innerHTML).toBe(idle);
  });

  it("keeps full screen on keys other than Escape", () => {
    const { doc, setWindowFullscreen } = setupPopout();
    key(doc, { key: "f" });
    expect(setWindowFullscreen).toHaveBeenCalledTimes(1);
    for (const k of ["g", "Enter", " ", "ArrowLeft", "Tab"]) {
      expect(key(doc, { key: k }).defaultPrevented, k).toBe(false);
    }
    expect(setWindowFullscreen).toHaveBeenCalledTimes(1);
  });

  it("stops following the window's full screen and keys once it is closed", () => {
    const { doc, root, popout, setWindowFullscreen } = setupPopout();
    popout.close();
    key(doc, { key: "f" });
    Object.defineProperty(doc, "fullscreenElement", { value: root, configurable: true });
    doc.dispatchEvent(new Event("fullscreenchange"));
    expect(setWindowFullscreen).not.toHaveBeenCalled();
  });

  it("releases the zoom bindings when no window could open", () => {
    const wheelSignals: AbortSignal[] = [];
    const add = EventTarget.prototype.addEventListener;
    const spy = vi.spyOn(EventTarget.prototype, "addEventListener").mockImplementation(function (
      this: EventTarget,
      type,
      listener,
      options,
    ) {
      if (type === "wheel" && typeof options === "object" && options?.signal) {
        wheelSignals.push(options.signal);
      }
      return add.call(this, type, listener, options);
    });
    try {
      open(null);
      expect(openPopout({ title: "x", video: video(), onClosed: vi.fn() })).toBeNull();
    } finally {
      spy.mockRestore();
    }
    expect(wheelSignals).toHaveLength(1);
    expect(wheelSignals[0]!.aborted).toBe(true);
  });

  it("ignores F with a modifier and other keys", () => {
    const { doc, setWindowFullscreen } = setupPopout();
    for (const init of [
      { key: "f", ctrlKey: true },
      { key: "f", metaKey: true },
      { key: "f", altKey: true },
      { key: "g" },
    ]) {
      expect(key(doc, init).defaultPrevented).toBe(false);
    }
    expect(setWindowFullscreen).not.toHaveBeenCalled();
  });

  it("leaves full screen on Escape, but only while in it", () => {
    const { doc, button, setWindowFullscreen } = setupPopout();
    expect(key(doc, { key: "Escape" }).defaultPrevented).toBe(false);
    expect(setWindowFullscreen).not.toHaveBeenCalled();

    key(doc, { key: "f" });
    expect(key(doc, { key: "Escape", isComposing: true }).defaultPrevented).toBe(false);
    expect(key(doc, { key: "Escape", keyCode: 229 }).defaultPrevented).toBe(false);
    expect(setWindowFullscreen).toHaveBeenCalledTimes(1);

    const e = key(doc, { key: "Escape" });
    expect(e.defaultPrevented).toBe(true);
    expect(setWindowFullscreen).toHaveBeenLastCalledWith(false, expect.any(String));
    expect(button.getAttribute("aria-label")).toBe("Full screen");
  });

  it("toggles from the button and from a double click on the picture", () => {
    const { root, button, setWindowFullscreen } = setupPopout();
    button.click();
    expect(setWindowFullscreen).toHaveBeenLastCalledWith(true, expect.any(String));
    root.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(setWindowFullscreen).toHaveBeenLastCalledWith(false, expect.any(String));
    expect(setWindowFullscreen).toHaveBeenCalledTimes(2);
  });

  it("asks the page for HTML full screen first and does not touch the window until it fails", async () => {
    const { root, button, setWindowFullscreen } = setupPopout();
    const request = vi.fn(() => Promise.resolve());
    root.requestFullscreen = request;
    button.click();
    await Promise.resolve();
    expect(request).toHaveBeenCalledTimes(1);
    expect(setWindowFullscreen).not.toHaveBeenCalled();
  });

  it("falls back to window full screen when the page refuses", async () => {
    const { root, button, setWindowFullscreen } = setupPopout();
    root.requestFullscreen = vi.fn(() => Promise.reject(new Error("denied")));
    button.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(setWindowFullscreen).toHaveBeenCalledWith(true, expect.any(String));
    expect(button.getAttribute("aria-label")).toBe("Exit full screen");
  });

  it("exits HTML full screen when the page is in it", () => {
    const { doc, root, button } = setupPopout();
    const exit = vi.fn(() => Promise.resolve());
    Object.defineProperty(doc, "fullscreenElement", { value: root, configurable: true });
    (doc as unknown as { exitFullscreen: () => Promise<void> }).exitFullscreen = exit;
    button.click();
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("swallows a refused exit from HTML full screen", async () => {
    const { doc, root, button } = setupPopout();
    Object.defineProperty(doc, "fullscreenElement", { value: root, configurable: true });
    (doc as unknown as { exitFullscreen: () => Promise<void> }).exitFullscreen = vi.fn(() =>
      Promise.reject(new Error("no")),
    );
    button.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(button.getAttribute("aria-label")).toBe("Full screen");
  });

  it("follows the page's own full screen changes", () => {
    const { doc, root, button, setWindowFullscreen } = setupPopout();
    Object.defineProperty(doc, "fullscreenElement", { value: root, configurable: true });
    doc.dispatchEvent(new Event("fullscreenchange"));
    expect(button.getAttribute("aria-label")).toBe("Exit full screen");
    expect(setWindowFullscreen).toHaveBeenLastCalledWith(true, expect.any(String));

    Object.defineProperty(doc, "fullscreenElement", { value: null, configurable: true });
    doc.dispatchEvent(new Event("fullscreenchange"));
    expect(button.getAttribute("aria-label")).toBe("Full screen");
    expect(setWindowFullscreen).toHaveBeenLastCalledWith(false, expect.any(String));
    expect(setWindowFullscreen).toHaveBeenCalledTimes(2);
  });

  it("does not repeat the window call when the state did not change", () => {
    const { doc, setWindowFullscreen } = setupPopout();
    doc.dispatchEvent(new Event("fullscreenchange"));
    expect(setWindowFullscreen).not.toHaveBeenCalled();
  });

  it("works without a window full screen hook and ignores a rejecting one", async () => {
    const plain = setupPopout({ fullscreen: false });
    plain.button.click();
    expect(plain.button.getAttribute("aria-label")).toBe("Exit full screen");

    const v = video();
    const failing = vi.fn(() => Promise.reject(new Error("no window")));
    track(openPopout({ title: "z", video: v, onClosed: vi.fn(), setWindowFullscreen: failing }));
    const doc = wins[1]!.document;
    doc.querySelector<HTMLButtonElement>("[data-popout-control='fullscreen']")!.click();
    await Promise.resolve();
    expect(failing).toHaveBeenCalledTimes(1);
  });

  it("reports the close to its caller, with who closed it", () => {
    const first = setupPopout();
    vi.advanceTimersByTime(0);
    wins[0]!.closeByUser();
    vi.advanceTimersByTime(300);
    expect(first.onClosed).toHaveBeenCalledTimes(1);
    expect(first.onClosed).toHaveBeenCalledWith(true);

    const second = setupPopout();
    second.popout.close();
    expect(second.onClosed).toHaveBeenCalledWith(false);
  });

  it("stops zooming the picture once the window is closed", () => {
    const { popout, root } = setupPopout();
    const wheel = (): boolean => {
      const e = new WheelEvent("wheel", { ctrlKey: true, deltaY: -100, cancelable: true });
      root.dispatchEvent(e);
      return e.defaultPrevented;
    };
    expect(wheel()).toBe(true);
    popout.close();
    expect(wheel()).toBe(false);
  });
});
