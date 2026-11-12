import { afterEach, describe, expect, it, vi } from "vitest";
import { createControlSlot } from "./controlSlot";
import { clearHost, hostAndroidApp } from "../../../tests/helpers/androidHost";
import { expectConsole } from "../../../tests/helpers/console";
import { createDeferred } from "../../../tests/helpers/deferred";

type Build = (signal: AbortSignal) => HTMLButtonElement;

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function bar(...classes: string[]): HTMLElement {
  const el = document.createElement("div");
  for (const cls of classes) el.appendChild(document.createElement("span")).className = cls;
  return el;
}

const order = (el: HTMLElement): string[] => [...el.children].map((c) => c.className || c.tagName);

describe("control slot", () => {
  afterEach(() => clearHost());

  it("builds nothing for a slot cleared while its control was loading", async () => {
    hostAndroidApp();
    const loading = createDeferred<Build>();
    const build = vi.fn<Build>(() => document.createElement("button"));
    const slot = createControlSlot("test", () => loading.promise);
    const el = bar("mute");
    slot.attach(el);
    slot.clear();
    loading.resolve(build);
    await settle();
    expect(build).not.toHaveBeenCalled();
    expect(order(el)).toEqual(["mute"]);
  });

  it("puts a control still loading where the bar was last drawn", async () => {
    hostAndroidApp();
    const loading = createDeferred<Build>();
    const slot = createControlSlot("test", () => loading.promise);
    const first = bar("mute");
    const second = bar("mute", "leave");
    const placedFirst = vi.fn();
    const placedSecond = vi.fn();
    slot.attach(first, null, placedFirst);
    slot.attach(second, second.querySelector(".leave"), placedSecond);
    loading.resolve(() => document.createElement("button"));
    await settle();
    expect(order(first)).toEqual(["mute"]);
    expect(order(second)).toEqual(["mute", "BUTTON", "leave"]);
    expect(placedFirst).not.toHaveBeenCalled();
    expect(placedSecond).toHaveBeenCalledTimes(1);
  });

  it("goes to the bar's start when the control to go before has left it", async () => {
    hostAndroidApp();
    const slot = createControlSlot("test", () =>
      Promise.resolve(() => document.createElement("button")),
    );
    const el = bar("mute", "leave");
    const leave = el.querySelector(".leave")!;
    slot.attach(el, leave);
    leave.remove();
    await settle();
    expect(order(el)).toEqual(["BUTTON", "mute"]);
  });

  it.each<[string, () => Promise<Build>]>([
    ["cannot load", () => Promise.reject(new Error("chunk missing"))],
    [
      "cannot be built",
      () =>
        Promise.resolve(() => {
          throw new Error("no store");
        }),
    ],
  ])("says which control %s, and leaves the bar as it was", async (_why, load) => {
    hostAndroidApp();
    const slot = createControlSlot("route", load);
    const el = bar("mute");
    slot.attach(el);
    await settle();
    expectConsole("warn", "The route control failed to load");
    expect(order(el)).toEqual(["mute"]);
  });
});
