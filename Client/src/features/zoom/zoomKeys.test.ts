import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createZoomController, type ZoomHost } from "./zoom";
import { startZoom, zoomKeyAction, ZOOM_PREF_KEY } from "./zoomKeys";

function key(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
}

const stored = (): string | null => localStorage.getItem("owncord:settings:" + ZOOM_PREF_KEY);

/** A host whose calls stay pending until released, in order. */
function gatedHost(): { host: ZoomHost; calls: number[]; release: (ok?: boolean) => void } {
  const calls: number[] = [];
  const gates: Array<(ok: boolean) => void> = [];
  return {
    calls,
    host: {
      setZoom: (scale) => {
        calls.push(scale);
        return new Promise<boolean>((resolve) => gates.push(resolve));
      },
    },
    release: (ok = true) => gates.shift()?.(ok),
  };
}

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

describe("keys", () => {
  it.each([
    [{ key: "=", ctrlKey: true }, "in"],
    [{ key: "+", ctrlKey: true, shiftKey: true }, "in"],
    [{ key: "=", ctrlKey: true, shiftKey: true }, "in"],
    [{ key: "+", code: "NumpadAdd", ctrlKey: true }, "in"],
    [{ key: "-", ctrlKey: true }, "out"],
    [{ key: "-", code: "NumpadSubtract", ctrlKey: true }, "out"],
    [{ key: "_", ctrlKey: true, shiftKey: true }, "out"],
    [{ key: ")", code: "Digit0", ctrlKey: true, shiftKey: true }, "reset"],
    [{ key: ")", ctrlKey: true, shiftKey: true }, null],
    [{ key: "0", ctrlKey: true }, "reset"],
    [{ key: "=", metaKey: true }, "in"],
    [{ key: "=" }, null],
    [{ key: "=", ctrlKey: true, altKey: true }, null],
    [{ key: "k", ctrlKey: true }, null],
  ] as const)("%j is %s", (init, expected) => {
    expect(zoomKeyAction(key(init))).toBe(expected);
  });

  it("drives the host through the shortcuts, even from a text field", async () => {
    const setZoom = vi.fn().mockResolvedValue(true);
    const zoom = createZoomController({ setZoom });
    const ac = new AbortController();
    startZoom(() => Promise.resolve(zoom), ac.signal);
    const input = document.createElement("input");
    document.body.appendChild(input);

    const plus = key({ key: "=", ctrlKey: true });
    input.dispatchEvent(plus);
    expect(plus.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(setZoom).toHaveBeenLastCalledWith(1.1));
    input.dispatchEvent(key({ key: "+", ctrlKey: true, shiftKey: true }));
    await vi.waitFor(() => expect(setZoom).toHaveBeenLastCalledWith(1.25));
    input.dispatchEvent(key({ key: "-", ctrlKey: true }));
    await vi.waitFor(() => expect(setZoom).toHaveBeenLastCalledWith(1.1));
    input.dispatchEvent(key({ key: "0", ctrlKey: true }));
    await vi.waitFor(() => expect(setZoom).toHaveBeenLastCalledWith(1));

    const other = key({ key: "k", ctrlKey: true });
    input.dispatchEvent(other);
    expect(other.defaultPrevented).toBe(false);

    ac.abort();
    input.dispatchEvent(key({ key: "=", ctrlKey: true }));
    expect(zoom.current()).toBe(100);
    input.remove();
  });

  it("Ctrl+0 returns straight to the default from a zoomed level", async () => {
    const setZoom = vi.fn().mockResolvedValue(true);
    const zoom = createZoomController({ setZoom });
    const ac = new AbortController();
    startZoom(() => Promise.resolve(zoom), ac.signal);
    for (let i = 0; i < 4; i++) {
      document.dispatchEvent(key({ key: "=", ctrlKey: true }));
      // oxlint-disable-next-line no-await-in-loop -- let each step settle in order
      await vi.waitFor(() => expect(setZoom).toHaveBeenCalledTimes(i + 1));
    }
    expect(zoom.current()).toBeGreaterThan(110);
    const reset = key({ key: "0", ctrlKey: true });
    document.dispatchEvent(reset);
    expect(reset.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(setZoom).toHaveBeenLastCalledWith(1));
    expect(zoom.current()).toBe(100);
    ac.abort();
  });

  it("rapid Ctrl+= presses with a pending call end at the right level", async () => {
    const { host, calls, release } = gatedHost();
    const zoom = createZoomController(host);
    const ac = new AbortController();
    startZoom(() => Promise.resolve(zoom), ac.signal);
    for (let i = 0; i < 4; i++) document.dispatchEvent(key({ key: "=", ctrlKey: true }));
    await vi.waitFor(() => expect(zoom.current()).toBe(175));
    for (let i = 0; i < 5; i++) {
      release();
      // oxlint-disable-next-line no-await-in-loop -- let each release settle in order
      await Promise.resolve();
      // oxlint-disable-next-line no-await-in-loop -- let each release settle in order
      await Promise.resolve();
    }
    await vi.waitFor(() => expect(stored()).toBe("175"));
    expect(calls.at(-1)).toBe(1.75);
    expect(calls).toEqual(calls.toSorted((a, b) => a - b));
    ac.abort();
  });
});

describe("startZoom", () => {
  it("applies a stored non-default level at startup, and skips the load at 100", async () => {
    const ac = new AbortController();
    const load = vi.fn();
    startZoom(load, ac.signal);
    expect(load).not.toHaveBeenCalled();

    localStorage.setItem("owncord:settings:" + ZOOM_PREF_KEY, "125");
    const setZoom = vi.fn().mockResolvedValue(true);
    const zoom = createZoomController({ setZoom });
    startZoom(() => Promise.resolve(zoom), ac.signal);
    await vi.waitFor(() => expect(setZoom).toHaveBeenCalledExactlyOnceWith(1.25));
    ac.abort();
  });

  it("leaves the app usable when the controller fails to load", async () => {
    localStorage.setItem("owncord:settings:" + ZOOM_PREF_KEY, "125");
    const ac = new AbortController();
    const load = vi.fn().mockRejectedValue(new Error("chunk failed"));
    startZoom(load, ac.signal);
    const e = key({ key: "=", ctrlKey: true });
    document.dispatchEvent(e);
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    expect(e.defaultPrevented).toBe(true);
    ac.abort();
  });
});
