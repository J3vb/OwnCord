import { describe, it, expect, vi, afterEach } from "vitest";
import { showScreenSharePicker } from "./ScreenSharePicker";
import type { NativeVoiceScreenSource } from "../platform/contracts/nativeVoice";

const sources: NativeVoiceScreenSource[] = [
  {
    id: "screen:1",
    kind: "screen",
    title: "Screen 1",
    thumbnail: "data:image/png;base64,iVBORw==",
  },
  { id: "window:9", kind: "window", title: "Code", thumbnail: null },
];

const dialog = () => document.querySelector<HTMLElement>('[data-testid="screen-share-picker"]');
const mounted = async () => {
  await vi.waitFor(() => expect(dialog()).not.toBeNull());
  return dialog()!;
};
const clickTab = (root: HTMLElement, label: string) => {
  const tab = [...root.querySelectorAll<HTMLButtonElement>(".ssp-tab")].find((b) =>
    b.textContent?.startsWith(label),
  )!;
  tab.click();
};

describe("showScreenSharePicker", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("lists screens first with thumbnails and resolves the pick on Go Live", async () => {
    const picking = showScreenSharePicker({
      sources,
      portal: false,
      defaultQuality: "high",
      defaultFps: 30,
    });
    const root = await mounted();
    expect(root.querySelectorAll(".ssp-source")).toHaveLength(1);
    expect(root.querySelector(".ssp-thumb img")?.getAttribute("src")).toBe(
      "data:image/png;base64,iVBORw==",
    );
    // Screens tab is first; switch to Applications for the window.
    clickTab(root, "Applications");
    const cards = [...root.querySelectorAll<HTMLButtonElement>(".ssp-source")];
    expect(cards).toHaveLength(1);
    cards[0]!.click();
    root.querySelector<HTMLButtonElement>('[data-testid="screen-share-go-live"]')!.click();
    await expect(picking).resolves.toEqual({
      source: "window:9",
      quality: "high",
      fps: 30,
    });
  });

  it("says audio is not shared instead of offering a switch", async () => {
    const picking = showScreenSharePicker({
      sources,
      portal: false,
      defaultQuality: "high",
      defaultFps: 30,
    });
    const root = await mounted();
    expect(root.querySelector('[role="switch"]')).toBeNull();
    expect(root.querySelector(".ssp-opt-text")?.textContent).toContain(
      "Audio sharing is not available on Linux yet",
    );
    root.querySelector<HTMLButtonElement>('[data-testid="screen-share-go-live"]')!.click();
    await expect(picking).resolves.not.toHaveProperty("audio");
  });

  it("keeps the selection on a visible card across tab switches", async () => {
    const picking = showScreenSharePicker({
      sources,
      portal: false,
      defaultQuality: "high",
      defaultFps: 30,
    });
    const root = await mounted();
    const checked = () =>
      [...root.querySelectorAll<HTMLButtonElement>(".ssp-source")]
        .filter((c) => c.getAttribute("aria-checked") === "true")
        .map((c) => [c.dataset["sourceId"], c.tabIndex]);
    clickTab(root, "Applications");
    expect(checked()).toEqual([["window:9", 0]]);
    clickTab(root, "Screens");
    expect(checked()).toEqual([["screen:1", 0]]);
    clickTab(root, "Applications");
    root.querySelector<HTMLButtonElement>('[data-testid="screen-share-go-live"]')!.click();
    await expect(picking).resolves.toMatchObject({ source: "window:9" });
  });

  it("restores the source chosen in a tab when the user returns to it", async () => {
    const picking = showScreenSharePicker({
      sources: [
        { id: "screen:1", kind: "screen", title: "Screen 1", thumbnail: null },
        { id: "screen:2", kind: "screen", title: "Screen 2", thumbnail: null },
        ...sources.slice(1),
      ],
      portal: false,
      defaultQuality: "high",
      defaultFps: 30,
    });
    const root = await mounted();
    root.querySelector<HTMLButtonElement>('[data-source-id="screen:2"]')!.click();
    clickTab(root, "Applications");
    clickTab(root, "Screens");
    const card = root.querySelector<HTMLButtonElement>('[data-source-id="screen:2"]')!;
    expect(card.getAttribute("aria-checked")).toBe("true");
    expect(card.tabIndex).toBe(0);
    root.querySelector<HTMLButtonElement>('[data-testid="screen-share-go-live"]')!.click();
    await expect(picking).resolves.toMatchObject({ source: "screen:2" });
  });

  it("disables Go Live on a tab with nothing to share", async () => {
    const picking = showScreenSharePicker({
      sources: [sources[0]!],
      portal: false,
      defaultQuality: "high",
      defaultFps: 30,
    });
    const root = await mounted();
    const goLive = root.querySelector<HTMLButtonElement>('[data-testid="screen-share-go-live"]')!;
    clickTab(root, "Applications");
    expect(goLive.disabled).toBe(true);
    clickTab(root, "Screens");
    expect(goLive.disabled).toBe(false);
    goLive.click();
    await expect(picking).resolves.toMatchObject({ source: "screen:1" });
  });

  it("labels the default frame rate with the quality's own rate", async () => {
    const picking = showScreenSharePicker({
      sources,
      portal: false,
      defaultQuality: "low",
      defaultFps: 30,
    });
    const root = await mounted();
    const [quality, fps] = root.querySelectorAll<HTMLSelectElement>(".ssp-select");
    expect(fps!.selectedOptions[0]!.textContent).toBe("Default (5 fps)");
    quality!.value = "medium";
    quality!.dispatchEvent(new Event("change"));
    expect(fps!.selectedOptions[0]!.textContent).toBe("Default (15 fps)");
    root.querySelector<HTMLButtonElement>('[data-testid="screen-share-go-live"]')!.click();
    await expect(picking).resolves.toMatchObject({ quality: "medium", fps: 30 });
  });

  it("carries the per-share quality and fps override", async () => {
    const picking = showScreenSharePicker({
      sources,
      portal: false,
      defaultQuality: "high",
      defaultFps: 30,
    });
    const root = await mounted();
    const [quality, fps] = root.querySelectorAll<HTMLSelectElement>(".ssp-select");
    quality!.value = "low";
    quality!.dispatchEvent(new Event("change"));
    fps!.value = "60";
    fps!.dispatchEvent(new Event("change"));
    root.querySelector<HTMLButtonElement>('[data-testid="screen-share-go-live"]')!.click();
    await expect(picking).resolves.toMatchObject({ quality: "low", fps: 60 });
  });

  it("resolves null on Cancel", async () => {
    const picking = showScreenSharePicker({
      sources,
      portal: false,
      defaultQuality: "high",
      defaultFps: 30,
    });
    const root = await mounted();
    [...root.querySelectorAll<HTMLButtonElement>("button")]
      .find((b) => b.textContent === "Cancel")!
      .click();
    await expect(picking).resolves.toBeNull();
  });

  it("resolves null when Escape dismisses the dialog", async () => {
    const picking = showScreenSharePicker({
      sources,
      portal: false,
      defaultQuality: "high",
      defaultFps: 30,
    });
    await mounted();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await expect(picking).resolves.toBeNull();
  });

  it("shows only the quality step on Wayland and resolves the portal", async () => {
    const picking = showScreenSharePicker({
      sources: [],
      portal: true,
      defaultQuality: "medium",
      defaultFps: 60,
    });
    const root = await mounted();
    expect(root.querySelectorAll(".ssp-source")).toHaveLength(0);
    expect(root.querySelector(".ssp-tabs")).toBeNull();
    expect(root.querySelector(".ssp-portal")).not.toBeNull();
    root.querySelector<HTMLButtonElement>('[data-testid="screen-share-go-live"]')!.click();
    await expect(picking).resolves.toEqual({
      source: "portal",
      quality: "medium",
      fps: 60,
    });
  });

  it("says so when there is nothing to share", async () => {
    const picking = showScreenSharePicker({
      sources: [],
      portal: false,
      defaultQuality: "high",
      defaultFps: 30,
    });
    const root = await mounted();
    expect(root.querySelector(".ssp-empty")?.textContent).toContain("No screens or windows");
    const goLive = root.querySelector<HTMLButtonElement>('[data-testid="screen-share-go-live"]')!;
    expect(goLive.disabled).toBe(true);
    [...root.querySelectorAll<HTMLButtonElement>("button")]
      .find((b) => b.textContent === "Cancel")!
      .click();
    await expect(picking).resolves.toBeNull();
  });
});
