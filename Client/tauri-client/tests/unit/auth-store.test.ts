import { describe, it, expect } from "vitest";
import { clearAuth } from "../../src/stores/auth.store";
import {
  blocksStore,
  setUserBlockedByMe,
  setUserBlockedByThem,
} from "../../src/stores/blocks.store";

describe("clearAuth", () => {
  it("resets blocksStore.blockedByMe so the next server's session doesn't inherit it", () => {
    // Server A: block user 7.
    setUserBlockedByMe(7, true);
    expect(blocksStore.getState().blockedByMe.has(7)).toBe(true);

    // Log out (as UserBar disconnect / Settings logout / quick-switch does).
    clearAuth();

    // Server B: user id 7 is an unrelated person. A previous server's block
    // must not still gate their DM composer / offer "Unblock" for them.
    expect(blocksStore.getState().blockedByMe.has(7)).toBe(false);
    expect(blocksStore.getState().blockedByMe.size).toBe(0);
  });

  it("resets blocksStore.blockedByThem too", () => {
    setUserBlockedByThem(9, true);
    expect(blocksStore.getState().blockedByThem.has(9)).toBe(true);

    clearAuth();

    expect(blocksStore.getState().blockedByThem.has(9)).toBe(false);
  });
});
