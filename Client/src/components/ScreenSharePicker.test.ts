import { describe, it, expect, vi, afterEach } from "vitest";
import { showScreenSharePicker } from "./ScreenSharePicker";
import type { NativeVoiceScreenSource } from "../platform/contracts/nativeVoice";

// 120 fps is hidden for now (lib/shareFps). Most tests here offer it so the
// picker's dormant 120 handling (monitor gate, Wayland cap, M-2 hint) keeps
// its coverage; "offers only 60 while 120 is hidden" runs the shipped state.
const offer120 = vi.hoisted(() => ({ value: true }));
vi.mock("@lib/shareFps", () => ({
  get SHARE_FPS_OPTIONS(): readonly number[] {
    return offer120.value ? [60, 120] : [60];
  },
}));

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

const openWithAudio = async () => {
  const picking = showScreenSharePicker({
    sources,
    portal: false,
    audioAvailable: true,
    defaultQuality: "high",
    defaultFps: 30,
  });
  return { picking, root: await mounted() };
};

describe("showScreenSharePicker", () => {
  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
    offer120.value = true;
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
      "Audio sharing needs a PulseAudio or PipeWire sound server",
    );
    root.querySelector<HTMLButtonElement>('[data-testid="screen-share-go-live"]')!.click();
    await expect(picking).resolves.not.toHaveProperty("audio");
  });

  it("shows a share-audio switch on Linux when the host can capture audio", async () => {
    const first = await openWithAudio();
    const toggle = first.root.querySelector<HTMLElement>('[role="switch"]')!;
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(first.root.querySelector(".ssp-opt-text")).toBeNull();
    first.root.querySelector<HTMLButtonElement>('[data-testid="screen-share-go-live"]')!.click();
    await expect(first.picking).resolves.toMatchObject({ audio: true });
    await vi.waitFor(() => expect(document.querySelector('[role="switch"]')).toBeNull());

    const second = await openWithAudio();
    const off = second.root.querySelector<HTMLElement>('[role="switch"]')!;
    off.click();
    expect(off.getAttribute("aria-checked")).toBe("false");
    second.root.querySelector<HTMLButtonElement>('[data-testid="screen-share-go-live"]')!.click();
    await expect(second.picking).resolves.toMatchObject({ audio: false });
  });

  it("toggles the share-audio switch with Space and Enter", async () => {
    const { picking, root } = await openWithAudio();
    const toggle = root.querySelector<HTMLElement>('[role="switch"]')!;
    for (const [key, expected] of [
      [" ", "false"],
      ["Enter", "true"],
    ] as const) {
      toggle.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
      expect(toggle.getAttribute("aria-checked")).toBe(expected);
    }
    toggle.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    root.querySelector<HTMLButtonElement>('[data-testid="screen-share-go-live"]')!.click();
    await expect(picking).resolves.toMatchObject({ audio: true });
  });

  it("asks only for the source when changing a live share's source", async () => {
    const picking = showScreenSharePicker({
      sources,
      portal: false,
      sourceOnly: true,
      defaultQuality: "high",
      defaultFps: 30,
    });
    const root = await mounted();
    expect(root.querySelector(".ssp-options")).toBeNull();
    expect(root.querySelectorAll(".ssp-select")).toHaveLength(0);
    root.querySelector<HTMLButtonElement>(".ssp-source")!.click();
    root.querySelector<HTMLButtonElement>('[data-testid="screen-share-go-live"]')!.click();
    await expect(picking).resolves.toMatchObject({ source: "screen:1" });
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
    // Low is 720p too: its frame rate is what tells it apart from Medium.
    expect(quality!.selectedOptions[0]!.textContent).toBe("Low (720p, 5 fps)");
    quality!.value = "medium";
    quality!.dispatchEvent(new Event("change"));
    expect(fps!.selectedOptions[0]!.textContent).toBe("Default (30 fps)");
    expect(quality!.selectedOptions[0]!.textContent).toBe("Medium (720p)");
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

  it("disables 120 fps on Wayland, where the portal capture stops at 60", async () => {
    const picking = showScreenSharePicker({
      sources: [],
      portal: true,
      defaultQuality: "source",
      defaultFps: 120,
    });
    const root = await mounted();
    const fps = root.querySelectorAll<HTMLSelectElement>(".ssp-select")[1]!;
    const option120 = [...fps.options].find((o) => o.value === "120")!;
    expect(option120.disabled).toBe(true);
    expect(option120.title).toBe("Wayland screen capture is limited to 60 fps");
    // A saved 120 falls back to the highest rate the capture can deliver.
    expect(fps.value).toBe("60");
    root.querySelector<HTMLButtonElement>('[data-testid="screen-share-go-live"]')!.click();
    await expect(picking).resolves.toMatchObject({ quality: "source", fps: 60 });
  });

  it("offers 120 fps where the capture is not the portal", async () => {
    const picking = showScreenSharePicker({
      sources,
      portal: false,
      defaultQuality: "source",
      defaultFps: 120,
    });
    const root = await mounted();
    const fps = root.querySelectorAll<HTMLSelectElement>(".ssp-select")[1]!;
    expect([...fps.options].find((o) => o.value === "120")!.disabled).toBe(false);
    expect(fps.value).toBe("120");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await expect(picking).resolves.toBeNull();
  });

  it("offers only 60 while 120 is hidden", async () => {
    offer120.value = false;
    const picking = showScreenSharePicker({
      sources,
      portal: false,
      defaultQuality: "source",
      defaultFps: 60,
    });
    const root = await mounted();
    const fps = root.querySelectorAll<HTMLSelectElement>(".ssp-select")[1]!;
    expect([...fps.options].map((o) => o.value)).toEqual(["30", "60"]);
    expect(fps.value).toBe("60");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await expect(picking).resolves.toBeNull();
  });

  describe("monitor refresh gate on 120 fps", () => {
    const monitors: NativeVoiceScreenSource[] = [
      { id: "screen:1", kind: "screen", title: "Slow", thumbnail: null, refreshHz: 60 },
      { id: "screen:2", kind: "screen", title: "Fast", thumbnail: null, refreshHz: 144 },
      { id: "screen:3", kind: "screen", title: "Unknown", thumbnail: null, refreshHz: null },
      { id: "window:9", kind: "window", title: "Code", thumbnail: null, refreshHz: null },
    ];
    const open = async (defaultFps: number) => {
      const picking = showScreenSharePicker({
        sources: monitors,
        portal: false,
        defaultQuality: "source",
        defaultFps,
      });
      const root = await mounted();
      const fps = root.querySelectorAll<HTMLSelectElement>(".ssp-select")[1]!;
      const option120 = [...fps.options].find((o) => o.value === "120")!;
      const pick = (id: string) =>
        root.querySelector<HTMLButtonElement>(`[data-source-id="${id}"]`)!.click();
      return { picking, root, fps, option120, pick };
    };

    it("disables 120 with the monitor rate on a 60 Hz screen", async () => {
      const { picking, fps, option120 } = await open(120);
      expect(option120.disabled).toBe(true);
      expect(option120.title).toBe("Your monitor runs at 60 Hz");
      expect(fps.value).toBe("60");
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      await expect(picking).resolves.toBeNull();
    });

    it("allows 120 on a 144 Hz screen", async () => {
      const { picking, fps, option120, pick } = await open(120);
      pick("screen:2");
      expect(option120.disabled).toBe(false);
      expect(option120.title).toBe("");
      fps.value = "120";
      fps.dispatchEvent(new Event("change"));
      document.querySelector<HTMLButtonElement>('[data-testid="screen-share-go-live"]')!.click();
      await expect(picking).resolves.toMatchObject({ source: "screen:2", fps: 120 });
    });

    it("never gates on an unknown rate or a window", async () => {
      const { picking, option120, pick, root } = await open(120);
      pick("screen:3");
      expect(option120.disabled).toBe(false);
      pick("screen:1");
      expect(option120.disabled).toBe(true);
      clickTab(root, "Applications");
      expect(option120.disabled).toBe(false);
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      await expect(picking).resolves.toBeNull();
    });

    it("drops a chosen 120 to 60 when switching to a 60 Hz screen", async () => {
      const { picking, fps, option120, pick } = await open(60);
      pick("screen:2");
      fps.value = "120";
      fps.dispatchEvent(new Event("change"));
      expect(fps.value).toBe("120");
      pick("screen:1");
      expect(option120.disabled).toBe(true);
      expect(fps.value).toBe("60");
      document.querySelector<HTMLButtonElement>('[data-testid="screen-share-go-live"]')!.click();
      await expect(picking).resolves.toMatchObject({ source: "screen:1", fps: 60 });
    });

    it("restores a saved 120 when moving from a 60 Hz screen to a 144 Hz one", async () => {
      const { picking, fps, pick } = await open(120);
      expect(fps.value).toBe("60");
      pick("screen:2");
      expect(fps.value).toBe("120");
      document.querySelector<HTMLButtonElement>('[data-testid="screen-share-go-live"]')!.click();
      await expect(picking).resolves.toMatchObject({ source: "screen:2", fps: 120 });
    });
  });

  it("shows only the quality step before the Windows picker and resolves the OS pick", async () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Edg/141",
    );
    const picking = showScreenSharePicker({
      sources: [],
      portal: false,
      osPicker: true,
      defaultQuality: "high",
      defaultFps: 120,
    });
    const root = await mounted();
    expect(root.querySelector(".ssp-tabs")).toBeNull();
    expect(root.querySelector(".ssp-empty")).toBeNull();
    expect(root.querySelector(".ssp-portal")?.textContent).toContain(
      "Windows will now ask which screen or window",
    );
    // The OS picker owns the audio choice, so there is no Linux audio note.
    expect(root.textContent).not.toContain("Audio sharing is not available");
    const [quality, fps] = root.querySelectorAll<HTMLSelectElement>(".ssp-select");
    expect(fps!.value).toBe("120");
    quality!.value = "source";
    quality!.dispatchEvent(new Event("change"));
    fps!.value = "60";
    fps!.dispatchEvent(new Event("change"));
    const goLive = root.querySelector<HTMLButtonElement>('[data-testid="screen-share-go-live"]')!;
    expect(goLive.disabled).toBe(false);
    goLive.click();
    await expect(picking).resolves.toEqual({ source: "os", quality: "source", fps: 60 });
  });

  it("on Windows says what 120 fps needs, only while 120 is chosen (M-2)", async () => {
    const picking = showScreenSharePicker({
      sources: [],
      portal: false,
      osPicker: true,
      defaultQuality: "high",
      defaultFps: 30,
    });
    const root = await mounted();
    const hint = root.querySelector<HTMLElement>('[data-testid="ssp-fps120-hint"]')!;
    expect(hint.textContent).toBe(
      "120 fps needs a 120 Hz or faster monitor. It uses H.264 on your graphics card where it can, even if you picked VP8.",
    );
    expect(hint.hidden).toBe(true);
    const fps = root.querySelectorAll<HTMLSelectElement>(".ssp-select")[1]!;
    fps.value = "120";
    fps.dispatchEvent(new Event("change"));
    expect(hint.hidden).toBe(false);
    expect(fps.getAttribute("aria-describedby")).toBe(hint.id);
    fps.value = "60";
    fps.dispatchEvent(new Event("change"));
    expect(hint.hidden).toBe(true);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await expect(picking).resolves.toBeNull();
  });

  it("has no 120 fps hint outside the Windows picker", async () => {
    const picking = showScreenSharePicker({
      sources,
      portal: false,
      defaultQuality: "source",
      defaultFps: 120,
    });
    const root = await mounted();
    expect(root.querySelector('[data-testid="ssp-fps120-hint"]')).toBeNull();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await expect(picking).resolves.toBeNull();
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
