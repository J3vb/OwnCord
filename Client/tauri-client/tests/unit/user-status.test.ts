import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  MAX_CUSTOM_STATUS_LEN,
  loadCustomStatus,
  loadUserStatus,
  loadUserStatusOrigin,
  onUserStatusChange,
  saveCustomStatus,
  saveUserStatus,
} from "@lib/userStatus";

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
    saveUserStatus("invisible");
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it("migrates a stored 'offline' to invisible", () => {
    // "offline" was this client's old spelling of "appear offline"; phase 6
    // gave that its own value, and a user who picked it meant invisible.
    localStorage.setItem("owncord:settings:userStatus", JSON.stringify("offline"));
    expect(loadUserStatus()).toBe("invisible");
  });

  it("records who chose the status", () => {
    saveUserStatus("dnd");
    expect(loadUserStatusOrigin()).toBe("manual");

    saveUserStatus("idle", "auto");
    expect(loadUserStatusOrigin()).toBe("auto");

    // The default is "manual" on purpose: everything that is not the idle
    // timer is a deliberate choice, and defaulting the other way would let a
    // real choice be silently revoked.
    saveUserStatus("online");
    expect(loadUserStatusOrigin()).toBe("manual");
  });

  it("defaults the origin to manual when nothing is stored", () => {
    expect(loadUserStatusOrigin()).toBe("manual");
  });

  it("round-trips and bounds the custom status text", () => {
    expect(loadCustomStatus()).toBe("");
    saveCustomStatus("shipping phase 6");
    expect(loadCustomStatus()).toBe("shipping phase 6");

    saveCustomStatus("x".repeat(MAX_CUSTOM_STATUS_LEN + 50));
    expect(loadCustomStatus()).toHaveLength(MAX_CUSTOM_STATUS_LEN);
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
