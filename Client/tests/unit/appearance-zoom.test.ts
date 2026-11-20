import { describe, it, expect, vi, beforeEach } from "vitest";

const { setZoom, hostWindow } = vi.hoisted(() => {
  const setZoom = vi.fn<(scale: number) => Promise<boolean>>();
  return { setZoom, hostWindow: { available: true, setZoom } };
});
vi.mock("../../src/platform/desktop", () => ({ desktop: { window: hostWindow } }));

import { expectConsole } from "../helpers/console";
import { buildAppearanceTab } from "../../src/features/settings/AppearanceTab";
import { appZoom } from "../../src/features/zoom";

function build(): { tab: HTMLElement; ac: AbortController } {
  const ac = new AbortController();
  const tab = buildAppearanceTab(ac.signal);
  document.body.appendChild(tab);
  return { tab, ac };
}

describe("AppearanceTab zoom", () => {
  beforeEach(async () => {
    localStorage.clear();
    document.body.replaceChildren();
    hostWindow.available = true;
    setZoom.mockReset().mockResolvedValue(true);
    await appZoom.reset();
    setZoom.mockClear();
    localStorage.clear();
  });

  it("shows the level and applies and saves a slider change", async () => {
    const { tab, ac } = build();
    const slider = tab.querySelector<HTMLInputElement>('input[aria-label="Zoom level"]')!;
    const label = slider.nextElementSibling!;
    expect(label.textContent).toBe("100%");
    slider.value = "8"; // 150%
    slider.dispatchEvent(new Event("input"));
    await vi.waitFor(() => expect(setZoom).toHaveBeenCalledWith(1.5));
    expect(label.textContent).toBe("150%");
    await vi.waitFor(() => expect(localStorage.getItem("owncord:settings:zoomLevel")).toBe("150"));
    ac.abort();
  });

  it("has no zoom row where the host cannot zoom (the web build)", () => {
    hostWindow.available = false;
    const { tab, ac } = build();
    expect(tab.querySelector('input[aria-label="Zoom level"]')).toBeNull();
    expect(tab.textContent).not.toContain("Zoom level");
    ac.abort();
  });

  it("resets to 100% and follows the zoom keys while open", async () => {
    const { tab, ac } = build();
    const slider = tab.querySelector<HTMLInputElement>('input[aria-label="Zoom level"]')!;
    await appZoom.step(1);
    expect(slider.value).toBe("6");
    expect(slider.nextElementSibling!.textContent).toBe("110%");
    tab.querySelector<HTMLButtonElement>("button[aria-label='Reset zoom to 100%']")!.click();
    await vi.waitFor(() => expect(slider.value).toBe("5"));
    expect(setZoom).toHaveBeenLastCalledWith(1);
    ac.abort();
  });

  it("snaps the slider back when the native zoom fails", async () => {
    setZoom.mockRejectedValue(new Error("denied"));
    const { tab, ac } = build();
    const slider = tab.querySelector<HTMLInputElement>('input[aria-label="Zoom level"]')!;
    slider.value = "9";
    slider.dispatchEvent(new Event("input"));
    await vi.waitFor(() => expect(slider.value).toBe("5"));
    expectConsole("warn", /zoom failed/);
    expect(localStorage.getItem("owncord:settings:zoomLevel")).toBeNull();
    ac.abort();
  });
});
