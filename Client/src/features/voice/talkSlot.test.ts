import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const made = vi.hoisted(() => ({ count: 0, signals: [] as AbortSignal[] }));
vi.mock("./talkButton", () => ({
  createTalkButton: (variant: string, signal: AbortSignal) => {
    made.count += 1;
    made.signals.push(signal);
    const btn = document.createElement("button");
    btn.dataset.testid = `talk-button-${variant}`;
    return btn;
  },
}));

import { createTalkSlot } from "./talkSlot";
import { clearHost, hostAndroidApp, hostDesktopApp } from "../../../tests/helpers/androidHost";

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function bar(): HTMLElement {
  const el = document.createElement("div");
  el.appendChild(document.createElement("span")).className = "mute";
  return el;
}

describe("talk slot", () => {
  beforeEach(() => {
    made.count = 0;
    made.signals = [];
  });
  afterEach(() => clearHost());

  it("places nothing off the Android app", async () => {
    hostDesktopApp();
    const slot = createTalkSlot("bar");
    const el = bar();
    slot.attach(el);
    await settle();
    expect(made.count).toBe(0);
    expect(el.children).toHaveLength(1);
  });

  it("puts the button before the given control, and calls back once it is in", async () => {
    hostAndroidApp();
    const slot = createTalkSlot("bar");
    const el = bar();
    el.appendChild(document.createElement("span")).className = "leave";
    const placed = vi.fn();
    slot.attach(el, el.querySelector(".leave"), placed);
    await settle();
    expect([...el.children].map((c) => c.className || c.tagName)).toEqual([
      "mute",
      "BUTTON",
      "leave",
    ]);
    expect(placed).toHaveBeenCalledTimes(1);
  });

  it("moves the same button into a redrawn bar, so a held button is not replaced", async () => {
    hostAndroidApp();
    const slot = createTalkSlot("call");
    const first = bar();
    slot.attach(first);
    await settle();
    const btn = first.querySelector("button")!;

    const second = bar();
    slot.attach(second);
    await settle();
    expect(made.count).toBe(1);
    expect(second.firstElementChild).toBe(btn);
    expect(first.querySelector("button")).toBeNull();
    expect(made.signals[0]!.aborted).toBe(false);
  });

  it("clear takes the button down, and one still loading never appears", async () => {
    hostAndroidApp();
    const slot = createTalkSlot("bar");
    const el = bar();
    slot.attach(el);
    await settle();
    slot.clear();
    expect(el.querySelector("button")).toBeNull();
    expect(made.signals[0]!.aborted).toBe(true);

    slot.attach(el);
    slot.clear();
    await settle();
    expect(el.querySelector("button")).toBeNull();
  });
});
