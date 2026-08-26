import { describe, it, expect, beforeEach } from "vitest";
import {
  blocksStore,
  setBlockedByMe,
  setUserBlockedByMe,
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

  // OC-0218: a ready-time GET /blocks and a user-initiated block/unblock can
  // race. The GET is issued before the user's own action but its reply can
  // land after — a stale full-set reply must not clobber a fresher per-user
  // delta.
  describe("setBlockedByMe staleness guard (OC-0218)", () => {
    it("applies when no revision is given (direct/legacy caller)", () => {
      setBlockedByMe([5]);
      expect(dmComposerBlockReason(blocksStore.getState(), 5)).toBe(BLOCKED_BY_ME_REASON);
    });

    it("a reply carrying the revision observed before a fresher local delta must not re-add it", () => {
      // Local user 42 starts blocked (seeded, as if from a previous ready).
      setBlockedByMe([42]);
      // A reconnect fires a fresh GET /blocks — the caller snapshots the
      // revision it observed right before issuing the request. Real callers
      // (dispatcher.ts) default the optional field to 0, exactly like
      // setBlockedByMe's own internal comparison does.
      const revBeforeFetch = blocksStore.getState().blockedByMeRev ?? 0;

      // While that GET is in flight, the user clicks "Unblock" — this is the
      // fresher, authoritative local truth.
      setUserBlockedByMe(42, false);
      expect(dmComposerBlockReason(blocksStore.getState(), 42)).toBeNull();

      // The GET's reply lands late, still carrying the stale pre-unblock
      // snapshot and the revision observed before the unblock. It must be
      // ignored, not re-add 42.
      setBlockedByMe([42], revBeforeFetch);

      expect(dmComposerBlockReason(blocksStore.getState(), 42)).toBeNull();
    });

    it("a reply carrying the current revision still applies", () => {
      setBlockedByMe([1]);
      const rev = blocksStore.getState().blockedByMeRev;
      // No local delta happened since — the snapshot is still current.
      setBlockedByMe([1, 2], rev);
      expect(dmComposerBlockReason(blocksStore.getState(), 1)).toBe(BLOCKED_BY_ME_REASON);
      expect(dmComposerBlockReason(blocksStore.getState(), 2)).toBe(BLOCKED_BY_ME_REASON);
    });
  });
});
