import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as mocks from "../../helpers/videoGridMocks";
import type {
  GridPerson,
  VideoGridComponent,
} from "../../../src/features/voice/videoGrid/VideoGrid";
import { fakeStream, makeTileConfig, useVideoGridHarness } from "../../helpers/videoGridHarness";

vi.mock("@lib/ui/toast", () => mocks.uiToastMock());
vi.mock("@lib/voice/livekitSession", () => mocks.voiceLivekitSessionMock());

const PLACE = ["left", "top", "width", "height"] as const;

describe("VideoGrid participant strip", () => {
  let container: HTMLDivElement;
  let grid: VideoGridComponent;
  let gridSize = { width: 1920, height: 1080 };

  useVideoGridHarness((c, g) => {
    container = c;
    grid = g;
  });

  const root = (): HTMLElement =>
    document.querySelector<HTMLElement>("[data-testid='video-grid']")!;
  const strip = (): HTMLElement | null => root().querySelector<HTMLElement>(".video-people-strip");
  const cell = (id: number): HTMLElement =>
    document.querySelector<HTMLElement>(`.video-cell[data-user-id='${id}']`)!;
  const avatar = (id: number): HTMLElement =>
    document.querySelector<HTMLElement>(`.video-cell[data-person-id='${id}']`)!;
  const px = (el: HTMLElement, prop: (typeof PLACE)[number]): number => parseFloat(el.style[prop]);
  const person = (id: number): GridPerson => ({
    userId: id,
    label: `Person ${id}`,
    content: document.createElement("button"),
  });
  const people = (n: number, from = 10): GridPerson[] =>
    Array.from({ length: n }, (_, i) => person(from + i));
  const addCamera = (id: number): void =>
    grid.addStream(id, `User ${id}`, fakeStream(), makeTileConfig({ audioUserId: id }));

  beforeEach(() => {
    gridSize = { width: 1920, height: 1080 };
    document.body.appendChild(container);
    vi.useFakeTimers();
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      () =>
        ({
          ...gridSize,
          top: 0,
          left: 0,
          right: gridSize.width,
          bottom: gridSize.height,
        }) as DOMRect,
    );
  });

  afterEach(() => {
    grid.destroy?.();
    container.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("seats the people in the strip and packs the camera clear of it", () => {
    grid.setPeople(people(2));
    addCamera(2);
    vi.advanceTimersByTime(50);

    const bar = strip()!;
    expect(bar.hidden).toBe(false);
    expect(bar.classList.contains("video-people-strip--side")).toBe(false);
    expect([10, 11].every((id) => avatar(id).parentElement === bar)).toBe(true);
    for (const prop of PLACE) expect(avatar(10).style[prop]).toBe("");

    const camera = cell(2);
    expect(px(camera, "top") + px(camera, "height")).toBeLessThanOrEqual(px(bar, "top"));
    expect(px(bar, "top") + px(bar, "height")).toBe(1080);
  });

  it("brings the people back to the main area, packed, when the last camera ends", () => {
    grid.setPeople(people(2));
    addCamera(2);
    vi.advanceTimersByTime(50);
    const before = avatar(10);
    avatar(10).querySelector("button")!.focus();

    grid.removeStream(2);
    vi.advanceTimersByTime(50);

    expect(strip()).toBeNull();
    expect(avatar(10)).toBe(before);
    expect(avatar(10).parentElement).toBe(root());
    expect(root().classList.contains("video-grid--packed")).toBe(true);
    expect(px(avatar(10), "width")).toBeGreaterThan(0);
    expect(document.activeElement).toBe(avatar(10).querySelector("button"));
  });

  it("keeps keyboard focus on a person's control as the cell moves into the strip", () => {
    grid.setPeople(people(2));
    avatar(11).querySelector("button")!.focus();
    addCamera(2);
    vi.advanceTimersByTime(50);
    expect(avatar(11).parentElement).toBe(strip());
    expect(document.activeElement).toBe(avatar(11).querySelector("button"));
  });

  it("keeps 60 people at their size in a strip that scrolls", () => {
    grid.setPeople(people(60));
    addCamera(2);
    vi.advanceTimersByTime(50);
    const bar = strip()!;
    expect(bar.querySelectorAll(".video-cell--avatar")).toHaveLength(60);
    expect(px(bar, "height")).toBe(96);
    const cameraHeight = px(cell(2), "height");
    expect(cameraHeight).toBeGreaterThan(0);
    // The tiles are never packed to fit; the strip's overflow takes the rest.
    for (const prop of PLACE) expect(avatar(30).style[prop]).toBe("");
    grid.setPeople(people(61));
    vi.advanceTimersByTime(50);
    expect(px(cell(2), "height")).toBe(cameraHeight);
  });

  it("puts the strip on the right of a very wide grid and below a regular one", () => {
    grid.setPeople(people(2));
    addCamera(2);
    vi.advanceTimersByTime(50);
    expect(strip()!.classList.contains("video-people-strip--side")).toBe(false);

    gridSize = { width: 5120, height: 1440 };
    addCamera(3);
    vi.advanceTimersByTime(50);
    const bar = strip()!;
    expect(bar.classList.contains("video-people-strip--side")).toBe(true);
    expect(px(bar, "left") + px(bar, "width")).toBe(5120);
    expect(px(bar, "top")).toBe(0);
    for (const id of [2, 3]) {
      expect(px(cell(id), "left") + px(cell(id), "width")).toBeLessThanOrEqual(px(bar, "left"));
    }
  });

  it("keeps the strip at the bottom on a phone, however wide the grid", () => {
    vi.stubGlobal("matchMedia", () => ({
      matches: true,
      addEventListener() {},
      removeEventListener() {},
    }));
    gridSize = { width: 5120, height: 1440 };
    grid.setPeople(people(2));
    addCamera(2);
    vi.advanceTimersByTime(50);
    expect(strip()!.classList.contains("video-people-strip--side")).toBe(false);
  });

  it("hides the strip with Show non-video participants", () => {
    grid.setExitVisible(true);
    grid.setPeople(people(2));
    addCamera(2);
    vi.advanceTimersByTime(50);
    expect(strip()!.hidden).toBe(false);
    const toggle = root().querySelector<HTMLButtonElement>("[data-view-toggle='nonVideo']")!;
    toggle.click();
    vi.advanceTimersByTime(50);
    expect(strip()!.hidden).toBe(true);
    toggle.click();
    vi.advanceTimersByTime(50);
    expect(strip()!.hidden).toBe(false);
  });

  it("leaves focus mode as it was: avatars in the thumb strip, no participant strip", () => {
    grid.setPeople(people(2));
    addCamera(2);
    addCamera(3);
    vi.advanceTimersByTime(50);
    cell(2).querySelector<HTMLButtonElement>("[data-tile-control='select']")!.click();
    vi.advanceTimersByTime(50);
    expect(strip()).toBeNull();
    expect(avatar(10).parentElement!.classList.contains("video-focus-strip")).toBe(true);
    expect(avatar(10).classList.contains("thumb")).toBe(true);
  });

  it("keeps the strip clear of the call bar and the tiles clear of the strip", () => {
    grid.setCallbacks({
      callControls: { onMuteToggle: vi.fn(), onDeafenToggle: vi.fn(), onLeave: vi.fn() },
    });
    grid.setExitVisible(true);
    grid.setPeople(people(2));
    addCamera(2);
    vi.advanceTimersByTime(50);
    const bar = strip()!;
    // 56px of the 1080 belong to the call bar.
    expect(px(bar, "top") + px(bar, "height")).toBe(1080 - 56);
    expect(px(cell(2), "top") + px(cell(2), "height")).toBeLessThanOrEqual(px(bar, "top"));
  });

  it("seats a person who joins, and drops one who leaves, in the strip", () => {
    grid.setPeople(people(2));
    addCamera(2);
    vi.advanceTimersByTime(50);
    grid.setPeople(people(3));
    expect(avatar(12).parentElement).toBe(strip());
    for (const prop of PLACE) expect(avatar(12).style[prop]).toBe("");
    grid.setPeople(people(3).slice(1));
    expect(document.querySelector("[data-person-id='10']")).toBeNull();
    expect(strip()!.querySelectorAll(".video-cell--avatar")).toHaveLength(2);
  });

  it("keeps video tiles before the strip in tab order", () => {
    grid.setPeople(people(2));
    addCamera(2);
    addCamera(3);
    vi.advanceTimersByTime(50);
    const kids = [...root().children];
    expect(kids.indexOf(cell(3))).toBeLessThan(kids.indexOf(strip()!));
    expect(kids.indexOf(cell(2))).toBeLessThan(kids.indexOf(strip()!));
  });

  it("returns the people to the strip on leaving focus mode", () => {
    grid.setPeople(people(2));
    addCamera(2);
    addCamera(3);
    vi.advanceTimersByTime(50);
    cell(2).querySelector<HTMLButtonElement>("[data-tile-control='select']")!.click();
    cell(2).querySelector<HTMLButtonElement>("[data-tile-control='grid']")!.click();
    vi.advanceTimersByTime(50);
    expect(avatar(10).parentElement).toBe(strip());
    expect(avatar(10).classList.contains("thumb")).toBe(false);
  });

  it("marks a speaking person in the strip", () => {
    grid.setPeople(people(2));
    addCamera(2);
    vi.advanceTimersByTime(50);
    grid.setSpeaking(new Set([10]));
    expect(avatar(10).classList.contains("video-cell--speaking")).toBe(true);
    expect(avatar(11).classList.contains("video-cell--speaking")).toBe(false);
  });

  it("leaves no stale cells in the strip after destroy and mount", () => {
    grid.setPeople(people(2));
    addCamera(2);
    vi.advanceTimersByTime(50);
    grid.destroy?.();
    grid.mount(container);
    grid.setPeople(people(1, 20));
    addCamera(5);
    vi.advanceTimersByTime(50);
    const cells = [...strip()!.querySelectorAll<HTMLElement>(".video-cell--avatar")];
    expect(cells.map((c) => c.dataset["personId"])).toEqual(["20"]);
  });

  it("keeps the people in the main area when the strip would leave the video no room", () => {
    gridSize = { width: 600, height: 250 };
    grid.setPeople(people(2));
    addCamera(2);
    vi.advanceTimersByTime(50);
    expect(strip()).toBeNull();
    expect(avatar(10).parentElement).toBe(root());
    expect(px(avatar(10), "width")).toBeGreaterThan(0);
  });

  it("leaves the strip as it is while the grid has no size", () => {
    grid.setPeople(people(2));
    addCamera(2);
    vi.advanceTimersByTime(50);
    gridSize = { width: 0, height: 0 };
    grid.setPeople(people(3));
    vi.advanceTimersByTime(50);
    expect(avatar(10).parentElement).toBe(strip());
    expect(avatar(12).parentElement).toBe(strip());
  });
});
