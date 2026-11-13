import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as mocks from "../../helpers/videoGridMocks";
import { usePhone } from "../../helpers/phoneMedia";
import type {
  GridPerson,
  VideoGridComponent,
} from "../../../src/features/voice/videoGrid/VideoGrid";
import {
  fakeStream,
  makeTileConfig,
  useVideoGridHarness,
  viewMenuRow,
} from "../../helpers/videoGridHarness";

vi.mock("@lib/ui/toast", () => mocks.uiToastMock());
vi.mock("@lib/voice/livekitSession", () => mocks.voiceLivekitSessionMock());

const PLACE = ["left", "top", "width", "height"] as const;

describe("VideoGrid voice-only cards", () => {
  let container: HTMLDivElement;
  let grid: VideoGridComponent;

  useVideoGridHarness((c, g) => {
    container = c;
    grid = g;
  });

  const root = (): HTMLElement =>
    container.querySelector<HTMLElement>("[data-testid='video-grid']")!;
  const cards = (): boolean => root().classList.contains("video-grid--cards");
  const packed = (): boolean => root().classList.contains("video-grid--packed");
  const avatar = (id: number): HTMLElement | null =>
    root().querySelector<HTMLElement>(`.video-cell[data-person-id='${id}']`);
  /** The people drawn as cards in the main area, in order. */
  const cardIds = (): number[] =>
    [
      ...root().querySelectorAll<HTMLElement>(
        ".video-grid__cards > .video-cell--avatar:not([hidden])",
      ),
    ].map((el) => Number(el.dataset["personId"]));
  const person = (id: number): GridPerson => ({
    userId: id,
    label: `Person ${id}`,
    content: document.createElement("div"),
  });
  const camera = (id: number): void =>
    grid.addStream(id, `User ${id}`, fakeStream(), makeTileConfig({ audioUserId: id }));
  const settle = (): void => {
    vi.advanceTimersByTime(50);
  };

  beforeEach(() => {
    localStorage.clear();
    document.body.appendChild(container);
    vi.useFakeTimers();
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      () => ({ width: 1280, height: 720, top: 0, left: 0, right: 1280, bottom: 720 }) as DOMRect,
    );
  });

  afterEach(() => {
    container.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("draws one card per person, unpacked, with their speaking ring and mute badge", () => {
    grid.setExitVisible(true);
    grid.setPeople([person(1), person(2)]);
    grid.setSpeaking(new Set([2]));
    grid.setUserAudioState(new Map([[1, { muted: true, deafened: false }]]));
    settle();

    expect(cards()).toBe(true);
    expect(packed()).toBe(false);
    expect(cardIds()).toEqual([1, 2]);
    for (const prop of PLACE) expect(avatar(1)!.style[prop]).toBe("");
    expect(avatar(1)!.querySelector(".video-username")!.textContent).toBe("Person 1");
    expect(avatar(2)!.classList.contains("video-cell--speaking")).toBe(true);
    expect(avatar(1)!.querySelector("[data-testid='tile-audio-state']")).not.toBeNull();
    expect(avatar(2)!.querySelector("[data-testid='tile-audio-state']")).toBeNull();
  });

  it("goes cards, grid, cards with the right people as a camera turns on and off", () => {
    grid.setExitVisible(true);
    grid.setPeople([person(1), person(2), person(3)]);
    settle();
    const kept = avatar(1);
    expect(cardIds()).toEqual([1, 2, 3]);

    camera(2);
    settle();
    expect(cards()).toBe(false);
    expect(packed()).toBe(true);
    // Person 2's card steps aside for their camera tile; the others go to the strip.
    expect(avatar(2)).toBeNull();
    expect(root().querySelector(".video-people-strip")!.contains(avatar(1))).toBe(true);
    expect(root().querySelector(".video-cell[data-user-id='2']")).not.toBeNull();

    grid.removeStream(2);
    vi.advanceTimersByTime(5_000);
    expect(root().querySelector(".video-cell[data-user-id='2']")).toBeNull();
    expect(cards()).toBe(true);
    expect(packed()).toBe(false);
    expect(root().querySelector(".video-people-strip")).toBeNull();
    expect(cardIds()).toEqual([1, 2, 3]);
    // The same card element, reused, with no packed place left on it.
    expect(avatar(1)).toBe(kept);
    for (const prop of PLACE) expect(avatar(1)!.style[prop]).toBe("");

    camera(3);
    settle();
    expect(cards()).toBe(false);
    grid.removeStream(3);
    vi.advanceTimersByTime(5_000);
    expect(cards()).toBe(true);
    expect(cardIds()).toEqual([1, 2, 3]);
  });

  it("keeps a screen share in the grid, and returns to cards when it stops", () => {
    grid.setPeople([person(1), person(2)]);
    grid.addStream(
      2 + 1_000_000,
      "Person 2 (Screen)",
      fakeStream(),
      makeTileConfig({ audioUserId: 2, isScreenshare: true }),
    );
    settle();
    expect(cards()).toBe(false);
    grid.removeStream(2 + 1_000_000);
    vi.advanceTimersByTime(5_000);
    expect(cards()).toBe(true);
    expect(cardIds()).toEqual([1, 2]);
  });

  it("adds and drops cards as people join and leave, down to the last one in a DM call", () => {
    grid.setExitVisible(true);
    grid.setPeople([person(1), person(2)]);
    settle();
    expect(cardIds()).toEqual([1, 2]);

    grid.setPeople([person(1), person(2), person(3)]);
    settle();
    expect(cards()).toBe(true);
    expect(cardIds()).toEqual([1, 2, 3]);
    for (const prop of PLACE) expect(avatar(3)!.style[prop]).toBe("");

    grid.setPeople([person(1), person(3)]);
    settle();
    expect(avatar(2)).toBeNull();
    expect(cardIds()).toEqual([1, 3]);

    // The other person leaves the DM call: you stay as the one card.
    grid.setPeople([person(1)]);
    settle();
    expect(cards()).toBe(true);
    expect(cardIds()).toEqual([1]);

    grid.setPeople([]);
    settle();
    expect(cards()).toBe(false);
    expect(cardIds()).toEqual([]);
  });

  it("keeps keyboard focus on a card's control through a camera on, off round trip", () => {
    const own = (id: number): GridPerson => ({
      userId: id,
      label: `Person ${id}`,
      content: document.createElement("button"),
    });
    const roster = [own(1), own(2), own(3)];
    grid.setExitVisible(true);
    grid.setPeople(roster);
    settle();
    const control = roster[0]!.content;
    control.focus();
    expect(document.activeElement).toBe(control);

    camera(2);
    settle();
    expect(cards()).toBe(false);
    expect(document.activeElement).toBe(control);

    grid.removeStream(2);
    vi.advanceTimersByTime(5_000);
    expect(cards()).toBe(true);
    expect(document.activeElement).toBe(control);
  });

  it("ignores Show non-video participants while nobody has video, and applies it again after", () => {
    grid.setExitVisible(true);
    grid.setPeople([person(1), person(2), person(3)]);
    settle();
    viewMenuRow(root(), "nonVideo")!.click();
    settle();
    // The row shows the choice as it is.
    expect(viewMenuRow(root(), "nonVideo")!.getAttribute("aria-checked")).toBe("false");
    expect(cards()).toBe(true);
    expect(cardIds()).toEqual([1, 2, 3]);

    camera(2);
    settle();
    expect(avatar(1)!.hidden).toBe(true);
    expect(avatar(3)!.hidden).toBe(true);

    grid.removeStream(2);
    vi.advanceTimersByTime(5_000);
    expect(cards()).toBe(true);
    expect(cardIds()).toEqual([1, 2, 3]);
  });

  it("shows the people as cards when only your own camera is on and Show my camera is off", () => {
    grid.setExitVisible(true);
    grid.setPeople([person(1), person(2), person(3)]);
    grid.addStream(1, "You", fakeStream(), makeTileConfig({ isSelf: true, audioUserId: 1 }));
    settle();
    expect(cards()).toBe(false);

    viewMenuRow(root(), "selfCamera")!.click();
    settle();
    const own = root().querySelector<HTMLElement>(".video-cell[data-user-id='1']")!;
    expect(own.hidden).toBe(true);
    expect(cards()).toBe(true);
    expect(packed()).toBe(false);
    expect(root().querySelector(".video-people-strip")).toBeNull();
    // Your card steps aside for your (hidden) camera tile; the others show.
    expect(cardIds()).toEqual([2, 3]);

    // Show non-video participants off still waits: no video is on show.
    viewMenuRow(root(), "nonVideo")!.click();
    settle();
    expect(cardIds()).toEqual([2, 3]);
  });

  it("keeps the grid's own controls after the cards in tab order", () => {
    grid.setCallbacks({
      callControls: { onMuteToggle: vi.fn(), onDeafenToggle: vi.fn(), onLeave: vi.fn() },
    });
    grid.setExitVisible(true);
    grid.setPeople([person(1)]);
    grid.setPeople([person(1), person(2)]);
    settle();
    const kids = [...root().children];
    const box = root().querySelector(".video-grid__cards")!;
    expect(box.lastElementChild).toBe(avatar(2));
    const lastCard = kids.indexOf(box);
    expect(lastCard).toBeGreaterThanOrEqual(0);
    expect(lastCard).toBeLessThan(kids.indexOf(root().querySelector(".video-grid__views")!));
    expect(lastCard).toBeLessThan(kids.indexOf(root().querySelector(".video-grid__controls")!));
  });

  it("on a phone, keeps the round View options control and its menu without Show chat", () => {
    usePhone(true);
    grid.setCallbacks({
      callControls: { onMuteToggle: vi.fn(), onDeafenToggle: vi.fn(), onLeave: vi.fn() },
      onExitGrid: vi.fn(),
    });
    grid.setExitVisible(true);
    grid.setPeople([person(1), person(2)]);
    settle();
    expect(cards()).toBe(true);

    const views = root().querySelector<HTMLButtonElement>("[data-call-control='views']")!;
    views.click();
    const rows = [...document.querySelectorAll<HTMLElement>(".context-menu [data-testid]")];
    expect(rows.map((r) => r.dataset["testid"])).toEqual([
      "view-menu-nonVideo",
      "view-menu-selfCamera",
      "view-menu-strip",
      "view-menu-popout",
    ]);
  });
});
