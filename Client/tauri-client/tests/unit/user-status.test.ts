import { describe, it, expect, beforeEach, vi } from "vitest";
import { loadUserStatus, saveUserStatus, onUserStatusChange } from "@lib/userStatus";

describe("userStatus", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("defaults to online with nothing stored", () => {
    expect(loadUserStatus()).toBe("online");
  });

  it("round-trips a saved status", () => {
    saveUserStatus("dnd");
    expect(loadUserStatus()).toBe("dnd");
  });

  it("falls back to online for a value that is not a status", () => {
    localStorage.setItem("owncord:settings:userStatus", JSON.stringify("busy"));
    expect(loadUserStatus()).toBe("online");
  });

  it("falls back to online for corrupted storage", () => {
    localStorage.setItem("owncord:settings:userStatus", "{not json");
    expect(loadUserStatus()).toBe("online");
  });

  it("notifies listeners on change and stops after unsubscribe", () => {
    const seen = vi.fn();
    const unsub = onUserStatusChange(seen);

    saveUserStatus("idle");
    expect(seen).toHaveBeenCalledWith("idle");

    unsub();
    saveUserStatus("offline");
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it("ignores unrelated preference changes", () => {
    const seen = vi.fn();
    onUserStatusChange(seen, { signal: new AbortController().signal });

    window.dispatchEvent(
      new CustomEvent("owncord:pref-change", { detail: { key: "compactMode" } }),
    );

    expect(seen).not.toHaveBeenCalled();
  });
});
