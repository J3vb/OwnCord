import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as mocks from "../../helpers/videoGridMocks";
import type { VideoGridComponent } from "../../../src/features/voice/videoGrid/VideoGrid";
import { fakeStream, makeTileConfig, useVideoGridHarness } from "../../helpers/videoGridHarness";

vi.mock("@lib/ui/toast", () => mocks.uiToastMock());
vi.mock("@lib/voice/livekitSession", () => mocks.voiceLivekitSessionMock());

const SHARE = 7 + 1_000_000;

describe("VideoGrid tile size and pin", () => {
  let container: HTMLDivElement;
  let grid: VideoGridComponent;

  useVideoGridHarness((c, g) => {
    container = c;
    grid = g;
  });

  const tile = (id: number): HTMLElement =>
    document.querySelector<HTMLElement>(`.video-cell[data-user-id='${id}']`)!;
  const num = (el: HTMLElement, prop: "width" | "height" | "left" | "top"): number =>
    parseFloat(el.style[prop]);
  const area = (id: number): number => num(tile(id), "width") * num(tile(id), "height");
  const control = (id: number, name: string): HTMLButtonElement =>
    tile(id).querySelector<HTMLButtonElement>(`[data-tile-control='${name}']`)!;
  const settle = (): void => {
    vi.advanceTimersByTime(50);
  };
  const addCamera = (id: number): void =>
    grid.addStream(id, `User ${id}`, fakeStream(), makeTileConfig({ audioUserId: id }));
  const menuRow = (action: string): HTMLElement =>
    document.querySelector<HTMLElement>(`.video-tile-menu [data-action='${action}']`)!;

  beforeEach(() => {
    document.body.appendChild(container);
    vi.useFakeTimers();
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      () => ({ width: 1600, height: 900, top: 0, left: 0, right: 1600, bottom: 900 }) as DOMRect,
    );
  });

  afterEach(() => {
    grid.destroy?.();
    container.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("makes a camera bigger with Large and smaller with Small", () => {
    addCamera(2);
    addCamera(3);
    settle();
    expect(area(2)).toBe(area(3));

    control(2, "size-large").click();
    settle();
    expect(area(2)).toBeGreaterThan(area(3));

    control(2, "size-small").click();
    settle();
    expect(area(2)).toBeLessThan(area(3));
  });

  it("shows a pinned camera at least as big as a screen share, ahead of it when another joins", () => {
    addCamera(2);
    grid.addStream(SHARE, "Otto (Screen)", fakeStream(), makeTileConfig({ isScreenshare: true }));
    settle();
    control(2, "pin").click();
    settle();
    expect(control(2, "pin").getAttribute("aria-pressed")).toBe("true");
    expect(area(2)).toBeGreaterThanOrEqual(area(SHARE));
    // The pinned tile leads the large tier: it sits before the share.
    const leads = (): boolean => num(tile(2), "left") <= num(tile(SHARE), "left");
    expect(leads()).toBe(true);

    addCamera(3);
    settle();
    expect(leads()).toBe(true);
    expect(area(2)).toBeGreaterThanOrEqual(area(SHARE));

    control(2, "pin").click();
    settle();
    expect(control(2, "pin").getAttribute("aria-pressed")).toBe("false");
    expect(area(2)).toBeLessThan(area(SHARE));
  });

  it("keeps pinned tiles in the order they were pinned", () => {
    addCamera(2);
    addCamera(3);
    settle();
    control(3, "pin").click();
    control(2, "pin").click();
    settle();
    const before = (a: number, b: number): boolean =>
      num(tile(a), "top") < num(tile(b), "top") ||
      (num(tile(a), "top") === num(tile(b), "top") && num(tile(a), "left") < num(tile(b), "left"));
    expect(before(3, 2)).toBe(true);
  });

  it("forgets the pin and size of a stream that ends, and moves focus to the grid", () => {
    addCamera(2);
    addCamera(3);
    settle();
    control(2, "size-large").click();
    control(3, "pin").click();
    settle();
    control(3, "pin").focus();

    grid.removeStream(3);
    settle();
    expect(document.activeElement).toBe(document.querySelector("[data-testid='video-grid']"));
    // The same id coming back starts from the default.
    addCamera(3);
    settle();
    expect(control(3, "pin").getAttribute("aria-pressed")).toBe("false");
    expect(control(3, "size-medium").getAttribute("aria-checked")).toBe("true");
    expect(control(2, "size-large").getAttribute("aria-checked")).toBe("true");
  });

  it("keeps the pin and size of a share through a republish hold", () => {
    grid.setCallbacks({ isStreamLive: () => true });
    grid.addStream(SHARE, "Otto (Screen)", fakeStream(), makeTileConfig({ isScreenshare: true }));
    addCamera(2);
    settle();
    control(SHARE, "size-small").click();
    settle();

    grid.addStream(SHARE, "Otto (Screen)", null, makeTileConfig({ isScreenshare: true }));
    grid.removeStream(SHARE);
    vi.advanceTimersByTime(100);
    grid.addStream(SHARE, "Otto (Screen)", fakeStream(), makeTileConfig({ isScreenshare: true }));
    settle();
    expect(control(SHARE, "size-small").getAttribute("aria-checked")).toBe("true");
    expect(area(SHARE)).toBeLessThan(area(2));
  });

  it("takes the last of two size clicks before the re-pack frame", () => {
    addCamera(2);
    addCamera(3);
    settle();
    control(2, "size-large").click();
    control(2, "size-small").click();
    settle();
    expect(area(2)).toBeLessThan(area(3));
    expect(control(2, "size-small").getAttribute("aria-checked")).toBe("true");
  });

  it("is a radiogroup that follows the size, moves with the arrow keys and keeps focus", () => {
    addCamera(2);
    addCamera(3);
    settle();
    const group = tile(2).querySelector("[role='radiogroup']")!;
    expect(group.querySelectorAll("[role='radio']")).toHaveLength(3);
    expect(control(2, "size-medium").getAttribute("aria-checked")).toBe("true");

    control(2, "size-medium").focus();
    control(2, "size-medium").dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    );
    settle();
    expect(control(2, "size-large").getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(control(2, "size-large"));

    control(2, "size-large").dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }),
    );
    control(2, "size-medium").dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }),
    );
    settle();
    expect(control(2, "size-small").getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(control(2, "size-small"));

    control(2, "size-large").click();
    control(2, "size-large").focus();
    settle();
    expect(document.activeElement).toBe(control(2, "size-large"));
  });

  it("changes the size and the pin from the tile menu", async () => {
    addCamera(2);
    addCamera(3);
    settle();
    const open = async (): Promise<void> => {
      tile(2).dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, clientX: 5, clientY: 5 }),
      );
      await vi.dynamicImportSettled();
    };
    await open();
    expect(menuRow("size-medium").getAttribute("aria-checked")).toBe("true");
    expect(menuRow("pin").textContent).toBe("Pin");
    menuRow("size-large").click();
    settle();
    expect(area(2)).toBeGreaterThan(area(3));

    await open();
    expect(menuRow("size-large").getAttribute("aria-checked")).toBe("true");
    menuRow("pin").click();
    settle();
    expect(control(2, "pin").getAttribute("aria-pressed")).toBe("true");
    await open();
    expect(menuRow("pin").textContent).toBe("Unpin");
  });

  it("shows no hover size controls on a phone but keeps the menu rows", async () => {
    vi.stubGlobal("matchMedia", () => ({
      matches: true,
      addEventListener() {},
      removeEventListener() {},
    }));
    addCamera(2);
    addCamera(3);
    settle();
    expect(tile(2).querySelector<HTMLElement>(".video-tile-arrange")!.hidden).toBe(true);

    tile(2).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 5, clientY: 5 }));
    await vi.dynamicImportSettled();
    menuRow("size-small").click();
    settle();
    expect(area(2)).toBeLessThan(area(3));
  });

  it("forgets sizes and pins when the call's streams are cleared", () => {
    addCamera(2);
    addCamera(3);
    settle();
    control(2, "size-small").click();
    control(3, "pin").click();
    settle();

    grid.clearStreams();
    addCamera(2);
    addCamera(3);
    settle();
    expect(control(2, "size-medium").getAttribute("aria-checked")).toBe("true");
    expect(control(3, "pin").getAttribute("aria-pressed")).toBe("false");
    expect(area(2)).toBe(area(3));
  });

  it("gives a new tile's size group one tab stop before the first pack", () => {
    addCamera(2);
    const radios = [...tile(2).querySelectorAll<HTMLElement>("[role='radio']")];
    expect(radios.map((r) => r.tabIndex)).toEqual([-1, 0, -1]);
    expect(control(2, "size-medium").getAttribute("aria-checked")).toBe("true");
    grid.addStream(SHARE, "Otto (Screen)", fakeStream(), makeTileConfig({ isScreenshare: true }));
    expect(control(SHARE, "size-large").tabIndex).toBe(0);
  });

  it("hides and shows the size controls as the layout flips to a phone and back", () => {
    let phone = false;
    vi.stubGlobal("matchMedia", () => ({
      get matches() {
        return phone;
      },
      addEventListener() {},
      removeEventListener() {},
    }));
    addCamera(2);
    settle();
    const group = tile(2).querySelector<HTMLElement>(".video-tile-arrange")!;
    expect(group.hidden).toBe(false);

    phone = true;
    window.dispatchEvent(new Event("resize"));
    expect(group.hidden).toBe(true);
    phone = false;
    window.dispatchEvent(new Event("resize"));
    expect(group.hidden).toBe(false);
  });

  it("leaves the size and pin rows out of the menu of a full-screen tile", async () => {
    addCamera(2);
    settle();
    control(2, "fullscreen").click();
    await vi.dynamicImportSettled();
    tile(2).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 5, clientY: 5 }));
    await vi.dynamicImportSettled();
    expect(document.querySelector(".video-tile-menu [data-action='focus']")).not.toBeNull();
    expect(document.querySelector(".video-tile-menu [data-action='size-small']")).toBeNull();
    expect(document.querySelector(".video-tile-menu [data-action='pin']")).toBeNull();
  });
});
