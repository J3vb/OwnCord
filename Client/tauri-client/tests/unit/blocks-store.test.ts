import { describe, it, expect, beforeEach } from "vitest";
import {
  blocksStore,
  setBlockedByMe,
  setUserBlockedByThem,
  clearBlockedByThem,
  dmComposerBlockReason,
  BLOCKED_BY_ME_REASON,
  BLOCKED_BY_THEM_REASON,
} from "../../src/stores/blocks.store";

describe("blocksStore", () => {
  beforeEach(() => {
    blocksStore.setState(() => ({ blockedByMe: new Set(), blockedByThem: new Set() }));
  });

  describe("dmComposerBlockReason", () => {
    it("returns null when the recipient is not blocked in either direction", () => {
      expect(dmComposerBlockReason(blocksStore.getState(), 5)).toBeNull();
    });

    it("gates with the explicit reason when the local user blocked them", () => {
      setBlockedByMe([5]);
      expect(dmComposerBlockReason(blocksStore.getState(), 5)).toBe(BLOCKED_BY_ME_REASON);
      expect(BLOCKED_BY_ME_REASON).toBe("You've blocked this user. Unblock to send messages.");
    });

    it("gates with the neutral reason when being blocked", () => {
      setUserBlockedByThem(7, true);
      expect(dmComposerBlockReason(blocksStore.getState(), 7)).toBe(BLOCKED_BY_THEM_REASON);
      expect(BLOCKED_BY_THEM_REASON).toBe("You can't message this user right now.");
    });

    it("prefers the explicit reason over the neutral one when both apply", () => {
      setBlockedByMe([9]);
      setUserBlockedByThem(9, true);
      expect(dmComposerBlockReason(blocksStore.getState(), 9)).toBe(BLOCKED_BY_ME_REASON);
    });

    it("only gates the blocked recipient, not others", () => {
      setBlockedByMe([5]);
      expect(dmComposerBlockReason(blocksStore.getState(), 6)).toBeNull();
    });
  });

  describe("un-gating", () => {
    it("un-gates when the local user unblocks (blockedByMe cleared)", () => {
      setBlockedByMe([5]);
      expect(dmComposerBlockReason(blocksStore.getState(), 5)).toBe(BLOCKED_BY_ME_REASON);
      setBlockedByMe([]); // GET /blocks after an unblock returns the shrunken list
      expect(dmComposerBlockReason(blocksStore.getState(), 5)).toBeNull();
    });

    it("un-gates a being-blocked recipient when cleared on reconnect", () => {
      setUserBlockedByThem(7, true);
      expect(dmComposerBlockReason(blocksStore.getState(), 7)).toBe(BLOCKED_BY_THEM_REASON);
      clearBlockedByThem();
      expect(dmComposerBlockReason(blocksStore.getState(), 7)).toBeNull();
    });

    it("setUserBlockedByThem(false) removes a single recipient", () => {
      setUserBlockedByThem(7, true);
      setUserBlockedByThem(8, true);
      setUserBlockedByThem(7, false);
      expect(dmComposerBlockReason(blocksStore.getState(), 7)).toBeNull();
      expect(dmComposerBlockReason(blocksStore.getState(), 8)).toBe(BLOCKED_BY_THEM_REASON);
    });
  });

  describe("immutability", () => {
    it("setUserBlockedByThem is a no-op (same reference) when state is unchanged", () => {
      const before = blocksStore.getState();
      setUserBlockedByThem(7, false); // not present → no change
      expect(blocksStore.getState()).toBe(before);
    });

    it("clearBlockedByThem is a no-op (same reference) when already empty", () => {
      const before = blocksStore.getState();
      clearBlockedByThem();
      expect(blocksStore.getState()).toBe(before);
    });
  });
});
