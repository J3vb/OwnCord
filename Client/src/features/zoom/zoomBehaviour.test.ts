// Zoom controller edges: halfway values, change notifications and the log
// lines a failing host or listener leaves.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectConsole } from "../../../tests/helpers/console";
import { captureLogs } from "../../../tests/helpers/log-capture";
import { createZoomController, snapZoom, stepZoom, ZOOM_PREF_KEY } from "./zoom";

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

describe("halfway between two levels", () => {
  it("snaps to the lower level", () => {
    expect(snapZoom(58.5)).toBe(50);
    expect(snapZoom(71)).toBe(67);
    expect(snapZoom(137.5)).toBe(125);
  });

  it("steps from the lower level", () => {
    expect(stepZoom(71, 1)).toBe(75);
    expect(stepZoom(71, -1)).toBe(50);
  });
});

describe("change notifications", () => {
  it("tells subscribers nothing when the requested level is the current one", async () => {
    const zoom = createZoomController({ setZoom: vi.fn().mockResolvedValue(true) });
    const seen: number[] = [];
    zoom.subscribe((level) => seen.push(level), new AbortController().signal);
    await zoom.set(100);
    await zoom.set(101);
    expect(seen).toEqual([]);
  });

  it("tells subscribers the stored level when it is applied at startup", async () => {
    localStorage.setItem("owncord:settings:" + ZOOM_PREF_KEY, "125");
    const zoom = createZoomController({ setZoom: vi.fn().mockResolvedValue(true) });
    const seen: number[] = [];
    zoom.subscribe((level) => seen.push(level), new AbortController().signal);
    await zoom.applyStored();
    expect(seen).toEqual([125]);
  });
});

describe("zoom log lines", () => {
  it("logs a host that throws under the zoom component with the error", async () => {
    const logs = captureLogs();
    const zoom = createZoomController({ setZoom: vi.fn().mockRejectedValue(new Error("denied")) });
    await zoom.step(1);
    expectConsole("warn", /zoom failed/);
    expect(logs.find("zoom failed")).toMatchObject([
      { level: "warn", component: "zoom", data: { error: "Error: denied" } },
    ]);
  });

  it("logs a listener that throws under the zoom component with the error", async () => {
    const logs = captureLogs();
    const zoom = createZoomController({ setZoom: vi.fn().mockResolvedValue(true) });
    zoom.subscribe(() => {
      throw new Error("boom");
    }, new AbortController().signal);
    await zoom.step(1);
    expectConsole("warn", /zoom listener failed/);
    expect(logs.find("zoom listener failed")).toMatchObject([
      { level: "warn", component: "zoom", data: { error: "Error: boom" } },
    ]);
  });
});
