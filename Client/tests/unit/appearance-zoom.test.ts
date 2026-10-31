import { describe, it, expect, vi, beforeEach } from "vitest";

const setZoom = vi.hoisted(() => vi.fn<(scale: number) => Promise<boolean>>());
vi.mock("../../src/platform/desktop", () => ({ desktop: { window: { setZoom } } }));

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
    setZoom.mockReset().mockResolvedValue(true);
    await appZoom.reset();
    setZoom.mockClear();
    localStorage.clear();
  });

  it("shows the level and applies and saves a slider change", async () => {
    const { tab, ac } = build();
    const slider = tab.querySelector<HTMLInputElement>('input[aria-label="Zoom Level"]')!;
    const label = slider.nextElementSibling!;
    expect(label.textContent).toBe("100%");
    slider.value = "8"; // 150%
    slider.dispatchEvent(new Event("input"));
    await vi.waitFor(() => expect(setZoom).toHaveBeenCalledWith(1.5));
    expect(label.textContent).toBe("150%");
    await vi.waitFor(() => expect(localStorage.getItem("owncord:settings:zoomLevel")).toBe("150"));
    ac.abort();
  });

  it("resets to 100% and follows the zoom keys while open", async () => {
    const { tab, ac } = build();
    const slider = tab.querySelector<HTMLInputElement>('input[aria-label="Zoom Level"]')!;
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
    const slider = tab.querySelector<HTMLInputElement>('input[aria-label="Zoom Level"]')!;
    slider.value = "9";
    slider.dispatchEvent(new Event("input"));
    await vi.waitFor(() => expect(slider.value).toBe("5"));
    expectConsole("warn", /zoom failed/);
    expect(localStorage.getItem("owncord:settings:zoomLevel")).toBeNull();
    ac.abort();
  });
});
