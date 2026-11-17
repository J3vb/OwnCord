import { afterEach, describe, expect, it, vi } from "vitest";

const made = vi.hoisted(() => ({ calls: [] as { variant: string; signal: AbortSignal }[] }));
vi.mock("./routeButton", () => ({
  createRouteButton: (variant: string, signal: AbortSignal) => {
    made.calls.push({ variant, signal });
    const btn = document.createElement("button");
    btn.dataset.testid = `route-button-${variant}`;
    return btn;
  },
}));

import { createRouteSlot } from "./routeSlot";
import { clearHost, hostAndroidApp, hostDesktopApp } from "../../../tests/helpers/androidHost";

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("route slot", () => {
  afterEach(() => {
    made.calls = [];
    clearHost();
  });

  it("keeps the route button of its bar, alive until the slot is cleared", async () => {
    hostAndroidApp();
    const slot = createRouteSlot("dm");
    const el = document.createElement("div");
    const camera = el.appendChild(document.createElement("span"));
    el.appendChild(document.createElement("span"));
    slot.attach(el, camera.nextSibling);
    await settle();
    expect(made.calls.map((c) => c.variant)).toEqual(["dm"]);
    expect(camera.nextElementSibling).toBe(el.querySelector("[data-testid='route-button-dm']"));
    expect(made.calls[0]!.signal.aborted).toBe(false);

    slot.clear();
    expect(made.calls[0]!.signal.aborted).toBe(true);
    expect(el.querySelector("button")).toBeNull();
  });

  it("builds nothing off the Android app", async () => {
    hostDesktopApp();
    createRouteSlot("call").attach(document.createElement("div"));
    await settle();
    expect(made.calls).toEqual([]);
  });
});
