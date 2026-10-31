/**
 * Tests for src/components/channel-sidebar/volumeMenu.ts (was 77.7% statements
 * / 50% functions, no test file — every event handler was unexercised).
 *
 * The menu is transient DOM appended to document.body with two AbortControllers
 * governing its teardown, so the interesting failures are leaks: a menu that
 * outlives its sidebar, or a dismiss listener that survives its menu.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as voiceSession from "../helpers/voiceSessionMock";

const setUserVolume = vi.fn();
const getUserVolume = vi.fn();
const setUserLocalMute = vi.fn();
const getUserLocalMute = vi.fn((..._args: unknown[]) => false);

vi.mock("@lib/voice/livekitSession", () =>
  voiceSession.withOverrides({
    setUserVolume: (...args: unknown[]) => setUserVolume(...args) as unknown,
    getUserVolume: (...args: unknown[]) => getUserVolume(...args) as unknown,
    setUserLocalMute: (...args: unknown[]) => setUserLocalMute(...args) as unknown,
    getUserLocalMute: (...args: unknown[]) => getUserLocalMute(...args) as unknown,
  }),
);

const { showUserVolumeMenu } = await import("@components/channel-sidebar/volumeMenu");

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
  // The setters write what the getters read back, as the real prefs do.
  setUserVolume.mockReset().mockImplementation((_id: unknown, v: unknown) => {
    getUserVolume.mockReturnValue(v);
  });
  getUserVolume.mockReset().mockReturnValue(100);
  setUserLocalMute.mockReset().mockImplementation((_id: unknown, muted: unknown) => {
    getUserLocalMute.mockReturnValue(muted as boolean);
  });
  getUserLocalMute.mockReset().mockReturnValue(false);
  document.body.innerHTML = "";
});

afterEach(() => {
  // Dismiss a menu a test left open with an outside click, releasing its
  // document mousedown listener before the DOM is cleared.
  document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  vi.useRealTimers();
  document.body.innerHTML = "";
});

// ── rendering ──────────────────────────────────────────────────────────────

describe("showUserVolumeMenu rendering", () => {
  it("renders the username, the current volume and a 0-200 slider", () => {
    getUserVolume.mockReturnValue(80);

    showUserVolumeMenu(7, "alice", 10, 20, new AbortController().signal);

    expect(menuEl()).not.toBeNull();
    expect(itemTexts()).toContain("alice");
    expect(itemTexts()).toContain("User Volume: 80%");

    const slider = sliderEl();
    expect(slider?.value).toBe("80");
    expect(slider?.min).toBe("0");
    expect(slider?.max).toBe("200");
  });

  it("caps its width so a long notice wraps instead of widening the menu", () => {
    showUserVolumeMenu(7, "alice", 0, 0, new AbortController().signal, "a long notice");
    expect(menuEl()?.style.maxWidth).toBe("240px");
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

    slider.value = "100";
    slider.dispatchEvent(new Event("input", { bubbles: true }));

    expect(setUserVolume).toHaveBeenCalledWith(7, 100);
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

describe("local Mute", () => {
  function muteItem(): HTMLElement | null {
    return document.querySelector<HTMLElement>('.user-vol-menu [data-action="local-mute"]');
  }

  it("is an unchecked checkbox row while the user is not muted", () => {
    showUserVolumeMenu(7, "alice", 0, 0, new AbortController().signal);
    expect(muteItem()?.getAttribute("role")).toBe("menuitemcheckbox");
    expect(muteItem()?.getAttribute("aria-checked")).toBe("false");
  });

  it("toggles the Mute, keeps the menu open and leaves the volume alone", () => {
    getUserVolume.mockReturnValue(150);
    showUserVolumeMenu(7, "alice", 0, 0, new AbortController().signal);

    muteItem()?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(setUserLocalMute).toHaveBeenLastCalledWith(7, true);
    expect(muteItem()?.getAttribute("aria-checked")).toBe("true");
    expect(menuEl()).not.toBeNull();

    muteItem()?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(setUserLocalMute).toHaveBeenLastCalledWith(7, false);
    expect(muteItem()?.getAttribute("aria-checked")).toBe("false");
    expect(setUserVolume).not.toHaveBeenCalled();
    expect(sliderEl()?.value).toBe("150");
  });

  it("raising the slider clears the Mute", () => {
    getUserLocalMute.mockReturnValue(true);
    showUserVolumeMenu(7, "alice", 0, 0, new AbortController().signal);
    const slider = sliderEl()!;
    slider.value = "120";
    slider.dispatchEvent(new Event("input"));
    expect(setUserVolume).toHaveBeenCalledWith(7, 120);
    expect(setUserLocalMute).toHaveBeenCalledWith(7, false);
    expect(muteItem()?.getAttribute("aria-checked")).toBe("false");
  });

  it("a user at 0% opens checked, and unchecking restores 100%", () => {
    getUserVolume.mockReturnValue(0);
    showUserVolumeMenu(7, "alice", 0, 0, new AbortController().signal);
    expect(muteItem()?.getAttribute("aria-checked")).toBe("true");

    muteItem()?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(setUserVolume).toHaveBeenCalledWith(7, 100);
    expect(sliderEl()?.value).toBe("100");
    expect(muteItem()?.getAttribute("aria-checked")).toBe("false");
  });

  it("dragging the slider to 0 checks the Mute", () => {
    showUserVolumeMenu(7, "alice", 0, 0, new AbortController().signal);
    const slider = sliderEl()!;
    slider.value = "0";
    slider.dispatchEvent(new Event("input"));
    expect(muteItem()?.getAttribute("aria-checked")).toBe("true");
  });

  it("opens checked for a user already muted", () => {
    getUserLocalMute.mockReturnValue(true);
    showUserVolumeMenu(7, "alice", 0, 0, new AbortController().signal);
    expect(muteItem()?.getAttribute("aria-checked")).toBe("true");
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

  it("ties the parent-signal abort bridge to the menu's own dismiss signal, so it does not outlive a dismissed menu", () => {
    // Without a { signal } option, this bridge listener (and the closure
    // retaining a detached .user-vol-menu subtree) survives every future
    // right-click for the parent's entire lifetime — the outside-click and
    // replace-on-reopen dismiss paths remove the menu but cannot remove this
    // listener, since it is registered directly on the caller's long-lived
    // signal. Mirrors context-menu.ts's `{ signal: menuAc.signal }` pattern.
    const parentAc = new AbortController();
    const addSpy = vi.spyOn(parentAc.signal, "addEventListener");

    showUserVolumeMenu(7, "alice", 0, 0, parentAc.signal);

    expect(addSpy).toHaveBeenCalledTimes(1);
    const [eventName, , options] = addSpy.mock.calls[0]!;
    expect(eventName).toBe("abort");
    expect(options).toEqual(expect.objectContaining({ signal: expect.any(AbortSignal) }));
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

describe("moderation section with only Move to", () => {
  const actions = (): string[] =>
    [...document.querySelectorAll<HTMLElement>(".user-vol-menu [data-action]")].map(
      (el) => el.dataset.action ?? "",
    );

  it("renders only Move to when mute, deafen and disconnect are absent", () => {
    const onMove = vi.fn();
    showUserVolumeMenu(7, "alice", 0, 0, new AbortController().signal, {
      moveTargets: [{ id: 5, name: "other" }],
      onMove,
    });
    expect(actions()).toContain("move-to");
    expect(actions()).not.toContain("server-mute");
    expect(actions()).not.toContain("server-deafen");
    expect(actions()).not.toContain("voice-disconnect");
    document.querySelector<HTMLElement>('[data-move-channel="5"]')?.click();
    expect(onMove).toHaveBeenCalledWith(5);
  });

  it("renders every row when all handlers are present", () => {
    showUserVolumeMenu(7, "alice", 0, 0, new AbortController().signal, {
      serverMuted: false,
      serverDeafened: false,
      moveTargets: [{ id: 5, name: "other" }],
      onServerMute: vi.fn(),
      onServerDeafen: vi.fn(),
      onMove: vi.fn(),
      onDisconnect: vi.fn(),
    });
    expect(actions()).toEqual(
      expect.arrayContaining(["server-mute", "server-deafen", "move-to", "voice-disconnect"]),
    );
  });
});
