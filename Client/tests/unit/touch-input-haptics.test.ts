// The Android app buzzes once when a long-press opens a bottom sheet, and
// never when it opens a popover menu or nothing.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installTouchInput } from "../../src/lib/ui/touchInput";
import { closeBottomSheet, openBottomSheet } from "../../src/lib/ui/bottomSheet";

let ctrl: AbortController;
let vibrate: ReturnType<typeof vi.fn>;

function touch(type: string, target: Element, x = 20, y = 20): void {
  target.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerType: "touch",
      isPrimary: true,
      clientX: x,
      clientY: y,
    }),
  );
}

function row(): Element {
  const host = document.createElement("div");
  host.innerHTML = '<div class="message"><span id="t">hi</span></div>';
  document.body.appendChild(host);
  return host.querySelector("#t")!;
}

function openSheet(): void {
  const content = document.createElement("div");
  content.innerHTML = "<button>Reply</button>";
  openBottomSheet({ label: "Actions", content });
}

function install(haptics: boolean | undefined): void {
  installTouchInput(ctrl.signal, haptics === undefined ? {} : { haptics });
}

async function settleHistory(): Promise<void> {
  vi.useRealTimers();
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  vi.useFakeTimers();
}

beforeEach(() => {
  vi.useFakeTimers();
  ctrl = new AbortController();
  vibrate = vi.fn(() => true);
  Object.defineProperty(navigator, "vibrate", { value: vibrate, configurable: true });
  Object.defineProperty(window, "visualViewport", { value: undefined, configurable: true });
});

afterEach(async () => {
  closeBottomSheet();
  ctrl.abort();
  await settleHistory();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
  Reflect.deleteProperty(navigator, "vibrate");
});

describe("long-press buzz", () => {
  it("buzzes once, briefly, when the long-press opens a sheet", () => {
    install(true);
    document.addEventListener("contextmenu", openSheet, { signal: ctrl.signal });
    const t = row();
    touch("pointerdown", t);
    vi.advanceTimersByTime(499);
    expect(vibrate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(document.querySelector(".bottom-sheet")).not.toBeNull();
    expect(vibrate).toHaveBeenCalledTimes(1);
    const ms = vibrate.mock.calls[0]![0] as number;
    expect(ms).toBeGreaterThanOrEqual(8);
    expect(ms).toBeLessThanOrEqual(15);
    // Lifting the finger buzzes nothing more.
    touch("pointerup", t);
    vi.advanceTimersByTime(2000);
    expect(vibrate).toHaveBeenCalledTimes(1);
  });

  it("buzzes when the sheet's code loads a moment after the long-press", () => {
    install(true);
    document.addEventListener("contextmenu", () => setTimeout(openSheet, 250), {
      signal: ctrl.signal,
    });
    touch("pointerdown", row());
    vi.advanceTimersByTime(500);
    expect(vibrate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(250);
    expect(vibrate).toHaveBeenCalledTimes(1);
  });

  it("does not buzz when the long-press opens nothing, or only a popover", () => {
    install(true);
    const popover = document.createElement("div");
    popover.className = "context-menu";
    document.addEventListener("contextmenu", () => document.body.appendChild(popover), {
      signal: ctrl.signal,
    });
    touch("pointerdown", row());
    vi.advanceTimersByTime(600);
    expect(vibrate).not.toHaveBeenCalled();
  });

  it("does not buzz for a sheet that opens long after the long-press, from something else", () => {
    install(true);
    document.addEventListener("contextmenu", () => undefined, { signal: ctrl.signal });
    touch("pointerdown", row());
    vi.advanceTimersByTime(500);
    vi.advanceTimersByTime(5000);
    openSheet();
    expect(vibrate).not.toHaveBeenCalled();
  });

  it("does not buzz outside the Android app", () => {
    install(false);
    document.addEventListener("contextmenu", openSheet, { signal: ctrl.signal });
    touch("pointerdown", row());
    vi.advanceTimersByTime(600);
    expect(document.querySelector(".bottom-sheet")).not.toBeNull();
    expect(vibrate).not.toHaveBeenCalled();
  });

  it("does not buzz when no option is given", () => {
    install(undefined);
    document.addEventListener("contextmenu", openSheet, { signal: ctrl.signal });
    touch("pointerdown", row());
    vi.advanceTimersByTime(600);
    expect(vibrate).not.toHaveBeenCalled();
  });

  it("swallows a vibrate that throws, and the sheet still opens", () => {
    install(true);
    vibrate.mockImplementation(() => {
      throw new Error("no permission");
    });
    document.addEventListener("contextmenu", openSheet, { signal: ctrl.signal });
    touch("pointerdown", row());
    expect(() => vi.advanceTimersByTime(600)).not.toThrow();
    expect(vibrate).toHaveBeenCalledTimes(1);
    expect(document.querySelector(".bottom-sheet")).not.toBeNull();
  });

  it("does nothing where the webview has no vibrate at all", () => {
    Reflect.deleteProperty(navigator, "vibrate");
    install(true);
    document.addEventListener("contextmenu", openSheet, { signal: ctrl.signal });
    touch("pointerdown", row());
    expect(() => vi.advanceTimersByTime(600)).not.toThrow();
    expect(document.querySelector(".bottom-sheet")).not.toBeNull();
  });

  it("buzzes for the webview's own long-press (a native contextmenu) that opens a sheet", () => {
    install(true);
    document.addEventListener("contextmenu", openSheet, { signal: ctrl.signal });
    const t = row();
    touch("pointerdown", t);
    vi.advanceTimersByTime(100);
    t.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    expect(vibrate).toHaveBeenCalledTimes(1);
  });

  it("does not buzz for a right-click with no finger down", () => {
    install(true);
    document.addEventListener("contextmenu", openSheet, { signal: ctrl.signal });
    row().dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    expect(document.querySelector(".bottom-sheet")).not.toBeNull();
    expect(vibrate).not.toHaveBeenCalled();
  });

  it("stops watching when the touch input is torn down", () => {
    install(true);
    document.addEventListener("contextmenu", () => setTimeout(openSheet, 250), {
      signal: ctrl.signal,
    });
    touch("pointerdown", row());
    vi.advanceTimersByTime(500);
    ctrl.abort();
    vi.advanceTimersByTime(250);
    expect(vibrate).not.toHaveBeenCalled();
  });
});
