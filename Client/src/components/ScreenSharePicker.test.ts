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
      audio: true,
    });
  });

  it("retitles the audio option for the picked app, not a screen", async () => {
    const picking = showScreenSharePicker({
      sources,
      portal: false,
      defaultQuality: "high",
      defaultFps: 30,
    });
    const root = await mounted();
    clickTab(root, "Applications");
    root.querySelector<HTMLButtonElement>(".ssp-source")!.click();
    expect(root.querySelector(".ssp-opt-text")?.textContent).toContain("Code");
    root.querySelector<HTMLButtonElement>('[data-testid="screen-share-go-live"]')!.click();
    await picking;
  });

  it("starts with audio on and toggles it off", async () => {
    const picking = showScreenSharePicker({
      sources,
      portal: false,
      defaultQuality: "high",
      defaultFps: 30,
    });
    const root = await mounted();
    const toggle = root.querySelector<HTMLButtonElement>(".ssp-switch")!;
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    toggle.click();
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    root.querySelector<HTMLButtonElement>('[data-testid="screen-share-go-live"]')!.click();
    await expect(picking).resolves.toMatchObject({ audio: false });
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

  it("shows only the audio/quality step on Wayland and resolves the portal", async () => {
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
      audio: true,
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
