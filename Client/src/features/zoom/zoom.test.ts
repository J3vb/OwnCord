import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectConsole } from "../../../tests/helpers/console";
import {
  DEFAULT_ZOOM,
  ZOOM_LEVELS,
  ZOOM_PREF_KEY,
  createZoomController,
  loadZoom,
  snapZoom,
  stepZoom,
  zoomIndex,
  type ZoomHost,
} from "./zoom";

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

const stored = (): string | null => localStorage.getItem("owncord:settings:" + ZOOM_PREF_KEY);

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

describe("levels", () => {
  it("lists Discord's levels", () => {
    expect(ZOOM_LEVELS).toEqual([50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200]);
  });

  it("snaps to the nearest level and falls back to 100 for junk", () => {
    expect(snapZoom(120)).toBe(125);
    expect(snapZoom(1)).toBe(50);
    expect(snapZoom(9999)).toBe(200);
    for (const bad of [NaN, Infinity, "150", null, undefined, {}]) {
      expect(snapZoom(bad)).toBe(100);
    }
  });

  it("steps one level and clamps at the ends", () => {
    expect(stepZoom(100, 1)).toBe(110);
    expect(stepZoom(100, -1)).toBe(90);
    expect(stepZoom(200, 1)).toBe(200);
    expect(stepZoom(50, -1)).toBe(50);
    expect(stepZoom(120, 1)).toBe(150);
    expect(zoomIndex(100)).toBe(5);
  });
});

describe("stored level", () => {
  it("defaults to 100", () => {
    expect(loadZoom()).toBe(DEFAULT_ZOOM);
  });

  it("reads a stored level", () => {
    localStorage.setItem("owncord:settings:" + ZOOM_PREF_KEY, "150");
    expect(loadZoom()).toBe(150);
  });

  it.each(["120", '"150"', "null", "1e999", "{", "-5", "true"])("ignores %s", (raw) => {
    localStorage.setItem("owncord:settings:" + ZOOM_PREF_KEY, raw);
    expect(loadZoom()).toBe(100);
  });
});

describe("controller", () => {
  it("applies the stored level at startup", async () => {
    localStorage.setItem("owncord:settings:" + ZOOM_PREF_KEY, "125");
    const setZoom = vi.fn().mockResolvedValue(true);
    const zoom = createZoomController({ setZoom });
    await zoom.applyStored();
    expect(setZoom).toHaveBeenCalledExactlyOnceWith(1.25);
    expect(zoom.current()).toBe(125);
  });

  it("does not call the host when the stored level is the default", async () => {
    const setZoom = vi.fn().mockResolvedValue(true);
    await createZoomController({ setZoom }).applyStored();
    expect(setZoom).not.toHaveBeenCalled();
  });

  it("applies and saves a set level, snapped", async () => {
    const setZoom = vi.fn().mockResolvedValue(true);
    const zoom = createZoomController({ setZoom });
    await zoom.set(160);
    expect(setZoom).toHaveBeenCalledWith(1.5);
    expect(stored()).toBe("150");
    await zoom.reset();
    expect(setZoom).toHaveBeenLastCalledWith(1);
    expect(stored()).toBe("100");
  });

  it("keeps the last good level and saves nothing when the host returns false", async () => {
    const zoom = createZoomController({ setZoom: vi.fn().mockResolvedValue(false) });
    const seen: number[] = [];
    zoom.subscribe((l) => seen.push(l), new AbortController().signal);
    await zoom.step(1);
    expect(zoom.current()).toBe(100);
    expect(stored()).toBeNull();
    expect(seen).toEqual([110, 100]);
  });

  it("survives a host that throws (no unhandled rejection)", async () => {
    const zoom = createZoomController({ setZoom: vi.fn().mockRejectedValue(new Error("denied")) });
    await expect(zoom.step(1)).resolves.toBeUndefined();
    expectConsole("warn", /zoom failed/);
    expect(zoom.current()).toBe(100);
    expect(stored()).toBeNull();
  });

  it("recovers after a failure once the host works", async () => {
    const setZoom = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    const zoom = createZoomController({ setZoom });
    await zoom.step(1);
    await zoom.step(1);
    expect(zoom.current()).toBe(110);
    expect(stored()).toBe("110");
  });

  it("applyStored failure does not overwrite the stored value", async () => {
    localStorage.setItem("owncord:settings:" + ZOOM_PREF_KEY, "150");
    const zoom = createZoomController({ setZoom: vi.fn().mockResolvedValue(false) });
    await zoom.applyStored();
    expect(zoom.current()).toBe(100);
    expect(stored()).toBe("150");
  });

  it("ends at the right level when steps arrive while a call is pending", async () => {
    const { host, calls, release } = gatedHost();
    const zoom = createZoomController(host);
    const a = zoom.step(1);
    const b = zoom.step(1);
    const c = zoom.step(1);
    expect(zoom.current()).toBe(150);
    expect(calls).toEqual([1.1]);
    release();
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toEqual([1.1, 1.5]);
    release();
    await Promise.all([a, b, c]);
    expect(calls.at(-1)).toBe(1.5);
    expect(zoom.current()).toBe(150);
    expect(stored()).toBe("150");
  });

  it("a request made during a failing call is still applied", async () => {
    const { host, calls, release } = gatedHost();
    const zoom = createZoomController(host);
    const a = zoom.step(1);
    const b = zoom.step(-1);
    release(false);
    await Promise.all([a, b]);
    expect(zoom.current()).toBe(100);
    expect(calls.length).toBeGreaterThanOrEqual(1);
  });

  it("notifies subscribers until their signal aborts", async () => {
    const zoom = createZoomController({ setZoom: vi.fn().mockResolvedValue(true) });
    const ac = new AbortController();
    const seen: number[] = [];
    zoom.subscribe((l) => seen.push(l), ac.signal);
    await zoom.step(1);
    ac.abort();
    await zoom.step(1);
    expect(seen).toEqual([110]);
  });

  it("does not subscribe on an aborted signal, and survives a throwing listener", async () => {
    const zoom = createZoomController({ setZoom: vi.fn().mockResolvedValue(true) });
    const ac = new AbortController();
    ac.abort();
    const never = vi.fn();
    zoom.subscribe(never, ac.signal);
    zoom.subscribe(() => {
      throw new Error("boom");
    }, new AbortController().signal);
    await zoom.step(1);
    expectConsole("warn", /zoom listener failed/);
    expect(never).not.toHaveBeenCalled();
    expect(zoom.current()).toBe(110);
  });
});
