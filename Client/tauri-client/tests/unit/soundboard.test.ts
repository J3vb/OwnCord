import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createSoundboard } from "../../src/components/Soundboard";
import type { SoundItem } from "../../src/components/Soundboard";

const testSounds: SoundItem[] = [
  { id: 1, name: "Airhorn", durationMs: 2500 },
  { id: 2, name: "Rimshot", durationMs: 1200 },
  { id: 3, name: "Sad Trombone", durationMs: 3800 },
];

describe("Soundboard", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    vi.useRealTimers();
    container.remove();
  });

  it("renders empty state when no sounds", () => {
    const board = createSoundboard({
      sounds: [],
      onPlaySound: vi.fn(),
    });
    board.mount(container);

    const empty = container.querySelector(".soundboard__empty");
    expect(empty).not.toBeNull();
    expect(empty!.textContent).toBe("No sounds available");

    board.destroy?.();
  });

  it("renders sound buttons with names and durations", () => {
    const board = createSoundboard({
      sounds: testSounds,
      onPlaySound: vi.fn(),
    });
    board.mount(container);

    const buttons = container.querySelectorAll(".sound-btn");
    expect(buttons.length).toBe(3);

    const names = Array.from(container.querySelectorAll(".sound-btn__name")).map(
      (el) => el.textContent,
    );
    expect(names).toEqual(["Airhorn", "Rimshot", "Sad Trombone"]);

    const durations = Array.from(container.querySelectorAll(".sound-btn__duration")).map(
      (el) => el.textContent,
    );
    expect(durations).toEqual(["2.5s", "1.2s", "3.8s"]);

    board.destroy?.();
  });

  it("calls onPlaySound with correct id when button is clicked", () => {
    const onPlaySound = vi.fn();
    const board = createSoundboard({
      sounds: testSounds,
      onPlaySound,
    });
    board.mount(container);

    const buttons = container.querySelectorAll(".sound-btn") as NodeListOf<HTMLButtonElement>;
    buttons[1]!.click();
    expect(onPlaySound).toHaveBeenCalledWith(2);

    board.destroy?.();
  });

  it("disables all buttons during cooldown", () => {
    const board = createSoundboard({
      sounds: testSounds,
      onPlaySound: vi.fn(),
    });
    board.mount(container);

    const buttons = container.querySelectorAll(".sound-btn") as NodeListOf<HTMLButtonElement>;
    buttons[0]!.click();

    // All buttons should be disabled
    for (const btn of buttons) {
      expect(btn.disabled).toBe(true);
      expect(btn.classList.contains("sound-btn--cooldown")).toBe(true);
    }

    board.destroy?.();
  });

  it("re-enables buttons after cooldown period", () => {
    const board = createSoundboard({
      sounds: testSounds,
      onPlaySound: vi.fn(),
    });
    board.mount(container);

    const buttons = container.querySelectorAll(".sound-btn") as NodeListOf<HTMLButtonElement>;
    buttons[0]!.click();

    // Advance past cooldown (3000ms)
    vi.advanceTimersByTime(3000);

    for (const btn of buttons) {
      expect(btn.disabled).toBe(false);
      expect(btn.classList.contains("sound-btn--cooldown")).toBe(false);
    }

    board.destroy?.();
  });

  it("does not fire onPlaySound when button is disabled", () => {
    const onPlaySound = vi.fn();
    const board = createSoundboard({
      sounds: testSounds,
      onPlaySound,
    });
    board.mount(container);

    const buttons = container.querySelectorAll(".sound-btn") as NodeListOf<HTMLButtonElement>;
    buttons[0]!.click(); // first click triggers cooldown
    onPlaySound.mockClear();

    buttons[1]!.click(); // should not fire since disabled
    expect(onPlaySound).not.toHaveBeenCalled();

    board.destroy?.();
  });

  it("cleans up on destroy", () => {
    const board = createSoundboard({
      sounds: testSounds,
      onPlaySound: vi.fn(),
    });
    board.mount(container);

    expect(container.querySelector(".soundboard")).not.toBeNull();

    board.destroy?.();
    expect(container.querySelector(".soundboard")).toBeNull();
  });
});
