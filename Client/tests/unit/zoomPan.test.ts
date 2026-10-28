import { describe, it, expect, vi, afterEach } from "vitest";
import { bindVideoZoom, createZoomPan, type ZoomPanOptions } from "../../src/lib/zoomPan";

function view(overrides: Partial<ZoomPanOptions> = {}) {
  const apply = vi.fn();
  const onDrag = vi.fn();
  const zp = createZoomPan({
    min: 0.5,
    max: 10,
    apply,
    centre: () => ({ x: 100, y: 100 }),
    onDrag,
    ...overrides,
  });
  return { zp, apply, onDrag };
}

const wheel = (deltaY: number, x = 100, y = 100, init: WheelEventInit = {}): WheelEvent =>
  new WheelEvent("wheel", {
    deltaY,
    clientX: x,
    clientY: y,
    bubbles: true,
    cancelable: true,
    ...init,
  });
const mouse = (type: string, x: number, y: number, init: MouseEventInit = {}): MouseEvent =>
  new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true, ...init });

describe("createZoomPan", () => {
  it("draws nothing until the view changes", () => {
    const { apply } = view();
    expect(apply).not.toHaveBeenCalled();
  });

  it("zooms one wheel notch in or out by 15 % of the scale", () => {
    const { zp, apply } = view();
    zp.wheel(wheel(-1));
    expect(zp.scale).toBeCloseTo(1.15);
    expect(apply).toHaveBeenLastCalledWith("translate(0px, 0px) scale(1.15)");
    zp.wheel(wheel(1));
    expect(zp.scale).toBeCloseTo(1.15 * 0.85);
  });

  it("keeps the point under the pointer where it is", () => {
    const { zp } = view();
    zp.zoomAt(3, 150, 80);
    expect(zp.scale).toBe(3);
    expect(zp.x).toBe(-100);
    expect(zp.y).toBe(40);
  });

  it("clamps the scale to its range", () => {
    const { zp } = view({ min: 1, max: 2 });
    zp.setScale(5);
    expect(zp.scale).toBe(2);
    zp.setScale(0.2);
    expect(zp.scale).toBe(1);
    zp.zoomAt(9, 100, 100);
    expect(zp.scale).toBe(2);
  });

  it("without bounds, pans freely", () => {
    const { zp } = view();
    zp.zoomAt(2, 300, 100);
    expect(zp.x).toBe(-200);
  });

  it("with bounds, never pans an edge into view", () => {
    const { zp } = view({ bounds: () => ({ width: 200, height: 100 }) });
    zp.zoomAt(2, 1000, -1000);
    expect(zp.x).toBe(-100);
    expect(zp.y).toBe(50);
    zp.setScale(1);
    expect(zp.x).toBe(0);
    expect(zp.y).toBe(0);
  });

  it("pans by the pointer's travel while zoomed in", () => {
    const { zp, apply, onDrag } = view();
    zp.setScale(2);
    const target = document.createElement("div");
    document.body.appendChild(target);
    const down = mouse("mousedown", 10, 10);
    target.dispatchEvent(down);
    expect(zp.press(down)).toBe(true);
    expect(onDrag).toHaveBeenLastCalledWith(true);
    document.dispatchEvent(mouse("mousemove", 40, 30));
    expect(zp.x).toBe(30);
    expect(zp.y).toBe(20);
    expect(apply).toHaveBeenLastCalledWith("translate(30px, 20px) scale(2)");
    document.dispatchEvent(mouse("mouseup", 40, 30));
    expect(onDrag).toHaveBeenLastCalledWith(false);
    document.dispatchEvent(mouse("mousemove", 90, 90));
    expect(zp.x).toBe(30);
    target.remove();
  });

  it("does not pan at or near 1x", () => {
    const { zp, onDrag } = view();
    zp.setScale(1.1);
    expect(zp.press(mouse("mousedown", 0, 0))).toBe(false);
    expect(onDrag).not.toHaveBeenCalled();
  });

  it("tells a click from a drag by 5 px", () => {
    const { zp } = view();
    zp.press(mouse("mousedown", 10, 10));
    expect(zp.movedSincePress(15, 5)).toBe(false);
    expect(zp.movedSincePress(16, 10)).toBe(true);
    expect(zp.movedSincePress(10, 4)).toBe(true);
  });

  it("reset ends a drag and goes back to 1x, centred", () => {
    const { zp, apply, onDrag } = view();
    zp.zoomAt(4, 130, 130);
    zp.press(mouse("mousedown", 0, 0));
    zp.reset();
    expect(onDrag).toHaveBeenLastCalledWith(false);
    expect(apply).toHaveBeenLastCalledWith("translate(0px, 0px) scale(1)");
    document.dispatchEvent(mouse("mousemove", 50, 50));
    expect(zp.x).toBe(0);
  });

  it("cancelDrag with no drag does nothing", () => {
    const { zp, onDrag } = view();
    zp.cancelDrag();
    expect(onDrag).not.toHaveBeenCalled();
  });
});

describe("bindVideoZoom", () => {
  let ctl: AbortController;
  afterEach(() => {
    ctl.abort();
    document.body.replaceChildren();
  });

  function host() {
    const el = document.createElement("div");
    const select = document.createElement("button");
    select.className = "video-cell-select";
    const other = document.createElement("button");
    el.append(select, other);
    document.body.appendChild(el);
    Object.defineProperty(el, "clientWidth", { value: 400 });
    Object.defineProperty(el, "clientHeight", { value: 200 });
    el.getBoundingClientRect = () => new DOMRect(0, 0, 400, 200);
    ctl = new AbortController();
    const zp = bindVideoZoom(el, ctl.signal);
    return { el, select, other, zp };
  }

  it("zooms on Ctrl + wheel only, and keeps a plain wheel for scrolling", () => {
    const { el, zp } = host();
    const plain = wheel(-1, 200, 100);
    el.dispatchEvent(plain);
    expect(zp.scale).toBe(1);
    expect(plain.defaultPrevented).toBe(false);

    const ctrl = wheel(-1, 200, 100, { ctrlKey: true });
    el.dispatchEvent(ctrl);
    expect(ctrl.defaultPrevented).toBe(true);
    expect(zp.scale).toBeCloseTo(1.15);
    expect(el.style.getPropertyValue("--video-scale")).toBe(String(zp.scale));
    expect(el.style.getPropertyValue("--video-pan")).toBe("0px 0px");
    expect(el.classList.contains("video-zoomed")).toBe(true);
  });

  it("zooms towards the pointer as shown, after a pan", () => {
    const { el, zp } = host();
    zp.zoomAt(2, 300, 100);
    expect(zp.x).toBe(-100);
    el.dispatchEvent(wheel(-1, 300, 100, { ctrlKey: true }));
    // The pointer is 200 px right of the shown centre (100 left of the box's).
    expect(zp.x).toBeCloseTo(-100 - 200 * 0.15);
  });

  it("drops its variables and class back at 1x", () => {
    const { el, zp } = host();
    zp.setScale(2);
    zp.reset();
    expect(el.style.getPropertyValue("--video-scale")).toBe("");
    expect(el.style.getPropertyValue("--video-pan")).toBe("");
    expect(el.classList.contains("video-zoomed")).toBe(false);
  });

  it("a drag that pans is no click; a still press is", () => {
    const { el, select, zp } = host();
    const clicks = vi.fn();
    select.addEventListener("click", clicks);
    zp.setScale(2);

    select.dispatchEvent(mouse("mousedown", 100, 100));
    expect(el.classList.contains("video-panning")).toBe(true);
    document.dispatchEvent(mouse("mousemove", 140, 100));
    document.dispatchEvent(mouse("mouseup", 140, 100));
    select.dispatchEvent(mouse("click", 140, 100));
    expect(clicks).not.toHaveBeenCalled();
    expect(zp.x).toBe(40);
    expect(el.classList.contains("video-panning")).toBe(false);

    select.dispatchEvent(mouse("mousedown", 100, 100));
    document.dispatchEvent(mouse("mouseup", 100, 100));
    select.dispatchEvent(mouse("click", 100, 100));
    expect(clicks).toHaveBeenCalledTimes(1);
  });

  it("never pans from the host's own controls or a secondary button", () => {
    const { el, other, select, zp } = host();
    zp.setScale(2);
    const onControl = mouse("mousedown", 10, 10);
    other.dispatchEvent(onControl);
    expect(onControl.defaultPrevented).toBe(false);
    select.dispatchEvent(mouse("mousedown", 10, 10, { button: 2 }));
    expect(el.classList.contains("video-panning")).toBe(false);
  });

  it("a click at 1x passes through", () => {
    const { select } = host();
    const clicks = vi.fn();
    select.addEventListener("click", clicks);
    select.dispatchEvent(mouse("mousedown", 10, 10));
    select.dispatchEvent(mouse("click", 50, 10));
    expect(clicks).toHaveBeenCalledTimes(1);
  });

  it("stops listening and ends a drag when its signal aborts", () => {
    const { el, select, zp } = host();
    zp.setScale(2);
    select.dispatchEvent(mouse("mousedown", 0, 0));
    ctl.abort();
    expect(el.classList.contains("video-panning")).toBe(false);
    el.dispatchEvent(wheel(-1, 0, 0, { ctrlKey: true }));
    expect(zp.scale).toBe(2);
  });
});
