import { describe, it, expect, vi } from "vitest";
import {
  createUserProfilePopup,
  type UserProfileData,
} from "../../src/features/profiles/userProfilePopup";
import type { NoteBinding } from "../../src/features/profiles/userNotes";
import { useMountContainer } from "../helpers/mountContainer";

const user: UserProfileData = {
  id: 42,
  username: "testuser",
  avatar: null,
  role: "member",
  status: "online",
};

function stubNote(): { note: NoteBinding; fail: (failed: boolean) => void } {
  let listener: (failed: boolean) => void = () => undefined;
  const note: NoteBinding = {
    remote: false,
    readLocal: () => "saved text",
    load: () => Promise.resolve(""),
    change: vi.fn(),
    flush: vi.fn(),
    onFailedChange: (l) => {
      listener = l;
    },
    destroy: vi.fn(),
  };
  return { note, fail: (failed) => listener(failed) };
}

describe("UserProfilePopup sections", () => {
  let container: HTMLDivElement;
  useMountContainer((mounted) => {
    container = mounted;
  });
  const q = (id: string): HTMLElement | null => container.querySelector(`[data-testid="${id}"]`);

  it("shows and clears the not-saved line and keeps the card on screen each time", () => {
    const { note, fail } = stubNote();
    const popup = createUserProfilePopup({ user, anchorX: 10, anchorY: 10, note });
    popup.mount(container);
    const card = q("user-profile-popup")!;
    const tops: string[] = [];
    Object.defineProperty(card, "offsetHeight", { get: () => 900, configurable: true });

    fail(true);
    tops.push(card.style.top);
    expect(q("upp-note-error")!.textContent).not.toBe("");
    fail(false);
    expect(q("upp-note-error")!.textContent).toBe("");
    // The card is taller than the window, so each re-place clamps to the margin.
    expect(tops[0]).toBe("8px");
    expect((q("upp-note") as HTMLTextAreaElement).value).toBe("saved text");
    popup.destroy?.();
  });

  it("ignores a not-saved report that arrives after the card closed", () => {
    const { note, fail } = stubNote();
    const popup = createUserProfilePopup({ user, anchorX: 10, anchorY: 10, note });
    popup.mount(container);
    popup.destroy?.();
    expect(() => fail(true)).not.toThrow();
  });

  it("lays the phone sheet out with Message and Call apart from Report and Block", () => {
    const popup = createUserProfilePopup({
      user,
      anchorX: 1,
      anchorY: 1,
      sheet: true,
      onMessage: vi.fn(),
      onCall: vi.fn(),
      onReport: vi.fn(),
    });
    popup.mount(document.body);
    const primary = document.querySelector(".upp-sheet-primary")!;
    expect(Array.from(primary.children).map((b) => b.getAttribute("data-testid"))).toEqual([
      "upp-message-btn",
      "upp-call-btn",
    ]);
    const secondary = document.querySelector(".upp-sheet-secondary")!;
    expect(Array.from(secondary.children).map((b) => b.getAttribute("data-testid"))).toEqual([
      "upp-report-btn",
    ]);
    expect(document.querySelector(".upp-banner")!.hasAttribute("data-sheet-drag")).toBe(true);
    popup.destroy?.();
  });

  it("disables Call with its reason and does not fire it", () => {
    const onCall = vi.fn();
    const popup = createUserProfilePopup({
      user,
      anchorX: 1,
      anchorY: 1,
      onCall,
      unavailableReason: "You are offline",
    });
    popup.mount(container);
    const call = q("upp-call-btn")!;
    expect(call.getAttribute("aria-disabled")).toBe("true");
    expect(call.title).toBe("You are offline");
    expect(call.querySelector("#upp-call-reason")!.textContent).toBe("You are offline");
    call.click();
    expect(onCall).not.toHaveBeenCalled();
    expect(popup.isOpen()).toBe(true);
    popup.destroy?.();
  });
});
