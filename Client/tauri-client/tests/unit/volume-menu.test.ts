/**
 * Tests for src/components/channel-sidebar/volume-menu.ts (was 77.7% statements
 * / 50% functions, no test file — every event handler was unexercised).
 *
 * The menu is transient DOM appended to document.body with two AbortControllers
 * governing its teardown, so the interesting failures are leaks: a menu that
 * outlives its sidebar, or a dismiss listener that survives its menu.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const setUserVolume = vi.fn();
const getUserVolume = vi.fn();

vi.mock("@lib/livekitSession", () => ({
  setUserVolume: (...args: unknown[]) => setUserVolume(...args) as unknown,
  getUserVolume: (...args: unknown[]) => getUserVolume(...args) as unknown,
}));

const { showUserVolumeMenu } = await import("@components/channel-sidebar/volume-menu");

function menuEl(): HTMLElement | null {
  return document.querySelector(".user-vol-menu");
}

function sliderEl(): HTMLInputElement | null {
  return document.querySelector<HTMLInputElement>(".user-vol-menu input[type=range]");
}

function itemTexts(): string[] {
  return [...document.querySelectorAll(".user-vol-menu .context-menu-item")].map(
    (el) => el.textContent ?? "",
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  setUserVolume.mockReset();
  getUserVolume.mockReset().mockReturnValue(100);
  document.body.innerHTML = "";
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

// ── rendering ──────────────────────────────────────────────────────────────

describe("showUserVolumeMenu rendering", () => {
  it("renders the username, the current volume and a 0-200 slider", () => {
    getUserVolume.mockReturnValue(140);

    showUserVolumeMenu(7, "alice", 10, 20, new AbortController().signal);

    expect(menuEl()).not.toBeNull();
    expect(itemTexts()).toContain("alice");
    expect(itemTexts()).toContain("User Volume: 140%");

    const slider = sliderEl();
    expect(slider?.value).toBe("140");
    expect(slider?.min).toBe("0");
    expect(slider?.max).toBe("200");
  });

  it("positions the menu at the supplied coordinates", () => {
    showUserVolumeMenu(7, "alice", 123, 456, new AbortController().signal);

    expect(menuEl()?.style.left).toBe("123px");
    expect(menuEl()?.style.top).toBe("456px");
  });

  it("reads the current volume for the requested user", () => {
    showUserVolumeMenu(42, "bob", 0, 0, new AbortController().signal);

    expect(getUserVolume).toHaveBeenCalledWith(42);
  });

  it("renders a volume of 0 rather than treating it as absent", () => {
    getUserVolume.mockReturnValue(0);

    showUserVolumeMenu(7, "alice", 0, 0, new AbortController().signal);

    expect(itemTexts()).toContain("User Volume: 0%");
    expect(sliderEl()?.value).toBe("0");
  });
});

// ── slider ─────────────────────────────────────────────────────────────────

describe("volume slider", () => {
  it("applies the new volume and updates both labels", () => {
    showUserVolumeMenu(7, "alice", 0, 0, new AbortController().signal);
    const slider = sliderEl();
    if (slider === null) throw new Error("no slider rendered");

    slider.value = "55";
    slider.dispatchEvent(new Event("input", { bubbles: true }));

    expect(setUserVolume).toHaveBeenCalledWith(7, 55);
    expect(itemTexts()).toContain("User Volume: 55%");
    expect(document.querySelector(".slider-val")?.textContent).toBe("55%");
  });

  it("supports boosting above 100%", () => {
    showUserVolumeMenu(7, "alice", 0, 0, new AbortController().signal);
    const slider = sliderEl();
    if (slider === null) throw new Error("no slider rendered");

    slider.value = "200";
    slider.dispatchEvent(new Event("input", { bubbles: true }));

    expect(setUserVolume).toHaveBeenCalledWith(7, 200);
  });

  it("supports muting to 0%", () => {
    showUserVolumeMenu(7, "alice", 0, 0, new AbortController().signal);
    const slider = sliderEl();
    if (slider === null) throw new Error("no slider rendered");

    slider.value = "0";
    slider.dispatchEvent(new Event("input", { bubbles: true }));

    expect(setUserVolume).toHaveBeenCalledWith(7, 0);
    expect(itemTexts()).toContain("User Volume: 0%");
  });
});

// ── reset ──────────────────────────────────────────────────────────────────

describe("reset button", () => {
  it("restores 100% in the store, the slider and both labels", () => {
    getUserVolume.mockReturnValue(30);
    showUserVolumeMenu(7, "alice", 0, 0, new AbortController().signal);

    const reset = [
      ...document.querySelectorAll<HTMLElement>(".user-vol-menu .context-menu-item"),
    ].find((el) => el.textContent === "Reset Volume");
    reset?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(setUserVolume).toHaveBeenCalledWith(7, 100);
    expect(sliderEl()?.value).toBe("100");
    expect(itemTexts()).toContain("User Volume: 100%");
    expect(document.querySelector(".slider-val")?.textContent).toBe("100%");
  });
});

// ── dismissal and teardown ─────────────────────────────────────────────────

describe("dismissal", () => {
  it("closes on a mousedown outside the menu", () => {
    showUserVolumeMenu(7, "alice", 0, 0, new AbortController().signal);
    vi.runAllTimers(); // the outside-click listener is attached on a macrotask

    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));

    expect(menuEl()).toBeNull();
  });

  it("stays open on a mousedown inside the menu", () => {
    showUserVolumeMenu(7, "alice", 0, 0, new AbortController().signal);
    vi.runAllTimers();

    sliderEl()?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));

    expect(menuEl()).not.toBeNull();
  });

  it("ignores clicks landing before the listener is attached", () => {
    showUserVolumeMenu(7, "alice", 0, 0, new AbortController().signal);

    // The setTimeout(0) exists so the right-click that opened the menu does not
    // immediately close it again.
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));

    expect(menuEl()).not.toBeNull();
  });

  it("removes the menu when the parent component aborts", () => {
    const ac = new AbortController();
    showUserVolumeMenu(7, "alice", 0, 0, ac.signal);
    vi.runAllTimers();

    ac.abort();

    expect(menuEl()).toBeNull();
  });

  it("does not re-attach the dismiss listener when aborted before the timer fires", () => {
    const ac = new AbortController();
    showUserVolumeMenu(7, "alice", 0, 0, ac.signal);

    ac.abort();
    // The scheduled callback checks the dismiss signal first, so no listener is
    // registered against an already-removed menu.
    expect(() => {
      vi.runAllTimers();
    }).not.toThrow();
    expect(menuEl()).toBeNull();
  });
});

describe("re-opening", () => {
  it("replaces any menu already on screen", () => {
    showUserVolumeMenu(7, "alice", 0, 0, new AbortController().signal);
    vi.runAllTimers();

    showUserVolumeMenu(9, "bob", 50, 60, new AbortController().signal);

    expect(document.querySelectorAll(".user-vol-menu")).toHaveLength(1);
    expect(itemTexts()).toContain("bob");
    expect(itemTexts()).not.toContain("alice");
  });

  it("the replaced menu's dismiss listener no longer closes the new menu", () => {
    showUserVolumeMenu(7, "alice", 0, 0, new AbortController().signal);
    vi.runAllTimers(); // first menu's outside-click listener is live

    showUserVolumeMenu(9, "bob", 0, 0, new AbortController().signal);
    // Deliberately do NOT run timers: only the stale listener from the first
    // menu is attached. It was aborted on replace, so this click must not close
    // the freshly opened menu.
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));

    expect(menuEl()).not.toBeNull();
    expect(itemTexts()).toContain("bob");
  });

  it("the new menu operates on the new user", () => {
    showUserVolumeMenu(7, "alice", 0, 0, new AbortController().signal);
    showUserVolumeMenu(9, "bob", 0, 0, new AbortController().signal);
    const slider = sliderEl();
    if (slider === null) throw new Error("no slider rendered");

    slider.value = "20";
    slider.dispatchEvent(new Event("input", { bubbles: true }));

    expect(setUserVolume).toHaveBeenCalledWith(9, 20);
    expect(setUserVolume).not.toHaveBeenCalledWith(7, 20);
  });
});
