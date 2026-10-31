import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  CALL_CHAT_WIDTH_PREF,
  clampCallChatWidth,
  createCallChatResize,
  type CallChatResize,
} from "../../src/features/voice/callChatResize";
import { savePref } from "../../src/lib/prefs/preferences";

describe("clampCallChatWidth", () => {
  it("keeps 280-640 and leaves the grid 360 px", () => {
    expect(clampCallChatWidth(100, 0)).toBe(280);
    expect(clampCallChatWidth(999, 0)).toBe(640);
    expect(clampCallChatWidth(500, 800)).toBe(440);
    expect(clampCallChatWidth(500, 1200)).toBe(500);
    // A column too narrow for both still gets the minimum (the split stacks).
    expect(clampCallChatWidth(500, 500)).toBe(280);
    expect(clampCallChatWidth(Number.NaN, 0)).toBe(360);
  });
});

describe("createCallChatResize", () => {
  let column: HTMLElement;
  let resize: CallChatResize;
  const handle = () => column.querySelector<HTMLElement>(".call-chat-resize");
  const width = () => column.style.getPropertyValue("--call-chat-width");

  function pointer(type: string, x: number): void {
    const e = new MouseEvent(type, { clientX: x, button: 0, bubbles: true });
    Object.defineProperty(e, "pointerId", { value: 1 });
    handle()?.dispatchEvent(e);
  }

  function attachWithPointerCapture(): HTMLElement {
    resize = createCallChatResize(column);
    resize.attach();
    const h = handle();
    if (h === null) throw new Error("no handle");
    h.setPointerCapture = vi.fn();
    h.releasePointerCapture = vi.fn();
    return h;
  }

  beforeEach(() => {
    localStorage.clear();
    column = document.createElement("div");
    column.getBoundingClientRect = () => ({ width: 1100 }) as DOMRect;
    document.body.appendChild(column);
  });

  afterEach(() => {
    resize?.destroy();
    column.remove();
  });

  it("attach adds a labelled separator and applies the saved width", () => {
    savePref(CALL_CHAT_WIDTH_PREF, 420);
    resize = createCallChatResize(column);
    expect(handle()).toBeNull();
    resize.attach();
    const h = handle();
    expect(h?.getAttribute("role")).toBe("separator");
    expect(h?.getAttribute("aria-label")).toBe("Resize call chat");
    expect(h?.getAttribute("aria-valuenow")).toBe("420");
    expect(width()).toBe("420px");
  });

  it("drag left widens, saves once on pointerup, and capture loss ends the drag", () => {
    attachWithPointerCapture();
    const spy = vi.spyOn(Storage.prototype, "setItem");

    pointer("pointerdown", 700);
    pointer("pointermove", 600);
    expect(width()).toBe("460px");
    pointer("pointermove", 0);
    expect(width()).toBe("640px");
    expect(spy).not.toHaveBeenCalled();
    pointer("lostpointercapture", 0);
    expect(localStorage.getItem(`owncord:settings:${CALL_CHAT_WIDTH_PREF}`)).toBe("640");
    pointer("pointermove", 900);
    expect(width()).toBe("640px");
    spy.mockRestore();
  });

  it("detach mid-drag ends the drag and saves, so the next split's drag works", () => {
    attachWithPointerCapture();
    pointer("pointerdown", 700);
    pointer("pointermove", 620);
    resize.detach();
    expect(localStorage.getItem(`owncord:settings:${CALL_CHAT_WIDTH_PREF}`)).toBe("440");

    resize.attach();
    expect(width()).toBe("440px");
    pointer("pointermove", 500);
    expect(width()).toBe("440px");
    pointer("pointerdown", 700);
    pointer("pointermove", 680);
    expect(width()).toBe("460px");
  });

  it("arrow keys step by 16 and save; Home and End jump", () => {
    resize = createCallChatResize(column);
    resize.attach();
    const key = (k: string) =>
      handle()?.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
    key("ArrowLeft");
    expect(width()).toBe("376px");
    expect(localStorage.getItem(`owncord:settings:${CALL_CHAT_WIDTH_PREF}`)).toBe("376");
    key("ArrowRight");
    key("ArrowRight");
    expect(width()).toBe("344px");
    key("Home");
    expect(width()).toBe("280px");
    key("End");
    expect(width()).toBe("640px");
  });

  it("refit narrows the shown width for a smaller column and widens it back", () => {
    savePref(CALL_CHAT_WIDTH_PREF, 600);
    resize = createCallChatResize(column);
    resize.attach();
    expect(width()).toBe("600px");
    resize.refit(800);
    expect(width()).toBe("440px");
    resize.refit(1200);
    expect(width()).toBe("600px");
  });

  it("detach removes the handle and the width", () => {
    resize = createCallChatResize(column);
    resize.attach();
    resize.detach();
    expect(handle()).toBeNull();
    expect(width()).toBe("");
    resize.refit(900);
    expect(width()).toBe("");
  });

  it("saves under the call chat width key and tags the handle for tests", () => {
    resize = createCallChatResize(column);
    resize.attach();
    expect(handle()?.getAttribute("data-testid")).toBe("call-chat-resize");
    handle()?.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    expect(localStorage.getItem("owncord:settings:callChatWidth")).toBe("640");
  });

  it("a drag is capped by the column width measured when it starts", () => {
    attachWithPointerCapture();
    // The column shrank since attach and no refit has been reported.
    column.getBoundingClientRect = () => ({ width: 800 }) as DOMRect;
    pointer("pointerdown", 700);
    pointer("pointermove", 0);
    expect(width()).toBe("440px");
  });

  it("attach leaves a handle that is already in the column where it is", () => {
    resize = createCallChatResize(column);
    resize.attach();
    const after = document.createElement("span");
    column.appendChild(after);
    resize.attach();
    expect(column.firstElementChild).toBe(handle());
    expect(column.lastElementChild).toBe(after);
  });

  it("destroy removes the handle and the width, and a later attach does nothing", () => {
    resize = createCallChatResize(column);
    resize.attach();
    expect(width()).toBe("360px");
    resize.destroy();
    expect(handle()).toBeNull();
    expect(width()).toBe("");
    resize.attach();
    expect(handle()).toBeNull();
    expect(width()).toBe("");
  });

  it("destroy mid-drag saves where the drag ended", () => {
    attachWithPointerCapture();
    pointer("pointerdown", 700);
    pointer("pointermove", 650);
    resize.destroy();
    expect(localStorage.getItem("owncord:settings:callChatWidth")).toBe("410");
  });
});
