import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { NativeVoiceScreenSources } from "../../../platform/contracts/nativeVoice";

const host = vi.hoisted((): { sources: NativeVoiceScreenSources } => ({
  sources: { portal: false, sources: [] },
}));
vi.mock("../../../platform/desktop", () => ({
  desktop: { nativeVoice: { screenSources: () => Promise.resolve(host.sources) } },
}));

import { pickScreenSource } from "./screenPicker";
import { captureOptions } from "./screenTrack";

const x11: NativeVoiceScreenSources = {
  portal: false,
  sources: [
    { id: "screen:277", kind: "screen", title: "screen", thumbnail: "data:image/bmp;base64,Qk0=" },
    { id: "window:81", kind: "window", title: "Terminal", thumbnail: null },
  ],
};

const picker = () => document.querySelector<HTMLElement>('[data-testid="native-screen-picker"]');
/** Let the source enumeration resolve and the modal mount. */
const mounted = async () => {
  await vi.waitFor(() => expect(picker()).not.toBeNull());
  return picker()!;
};

describe("pickScreenSource", () => {
  beforeEach(() => {
    host.sources = x11;
  });
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("leaves the pick to the desktop portal on Wayland without showing anything", async () => {
    host.sources = { portal: true, sources: [] };
    await expect(pickScreenSource()).resolves.toBe("portal");
    expect(picker()).toBeNull();
  });

  it("shows each screen and window with what would be shared, and resolves the pick", async () => {
    const picking = pickScreenSource();
    const modal = await mounted();
    const cards = [...modal.querySelectorAll<HTMLButtonElement>(".native-screen-source")];
    expect(cards.map((c) => c.getAttribute("aria-label"))).toEqual([
      "Share Screen: screen",
      "Share Window: Terminal",
    ]);
    expect(cards[0]!.querySelector("img")!.getAttribute("src")).toBe("data:image/bmp;base64,Qk0=");
    expect(cards[1]!.textContent).toContain("No preview");
    cards[1]!.click();
    await expect(picking).resolves.toBe("window:81");
    expect(picker()).toBeNull();
  });

  it("resolves null when cancelled or dismissed with Escape", async () => {
    const cancelled = pickScreenSource();
    const modal = await mounted();
    [...modal.querySelectorAll("button")].find((b) => b.textContent === "Cancel")!.click();
    await expect(cancelled).resolves.toBeNull();

    const escaped = pickScreenSource();
    await mounted();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await expect(escaped).resolves.toBeNull();
    expect(picker()).toBeNull();
  });

  it("says so when there is nothing to share", async () => {
    host.sources = { portal: false, sources: [] };
    const picking = pickScreenSource();
    const modal = await mounted();
    expect(modal.textContent).toContain("No screens or windows can be shared");
    [...modal.querySelectorAll("button")].find((b) => b.textContent === "Cancel")!.click();
    await expect(picking).resolves.toBeNull();
  });
});

describe("captureOptions", () => {
  it("maps the web presets onto the host capture, as createLocalScreenTracks reads them", () => {
    expect(captureOptions({ resolution: { width: 1280, height: 720, frameRate: 5 } })).toEqual({
      fps: 5,
      maxWidth: 1280,
      maxHeight: 720,
    });
    // "source" at 60/120 fps: a zero size is uncapped.
    expect(captureOptions({ resolution: { width: 0, height: 0, frameRate: 60 } })).toEqual({
      fps: 60,
      maxWidth: 0,
      maxHeight: 0,
    });
    // No resolution: the library's 1080p30 default.
    expect(captureOptions({})).toEqual({ fps: 30, maxWidth: 1920, maxHeight: 1080 });
    expect(captureOptions(undefined)).toEqual({ fps: 30, maxWidth: 1920, maxHeight: 1080 });
  });
});
