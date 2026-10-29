import { describe, it, expect, beforeEach } from "vitest";
import { listSessionResets } from "@lib/sessionRegistry";
import {
  clearCustomEmoji,
  customEmojiLoaded,
  emojiStore,
  listCustomEmoji,
  resolveEmoji,
  setCustomEmoji,
  SHORTCODE_PATTERN,
  type CustomEmoji,
} from "@stores/emoji.store";

const WAVE: CustomEmoji = { id: 1, shortcode: "wave", url: "/api/v1/emoji/1/image" };
const PARTY: CustomEmoji = { id: 2, shortcode: "party_parrot", url: "/api/v1/emoji/2/image" };

function rev(): number {
  return emojiStore.getState().rev ?? 0;
}

describe("emoji store", () => {
  beforeEach(() => {
    clearCustomEmoji();
  });

  it("is registered to run on sign-out", () => {
    expect(listSessionResets()).toContain("emoji:store");
  });

  it("starts empty and not loaded after a clear", () => {
    expect(listCustomEmoji()).toEqual([]);
    expect(customEmojiLoaded()).toBe(false);
    expect(emojiStore.getState().byShortcode.size).toBe(0);
  });

  it("stores the set in the order given and marks it loaded", () => {
    setCustomEmoji([WAVE, PARTY]);
    expect(listCustomEmoji()).toEqual([WAVE, PARTY]);
    expect(customEmojiLoaded()).toBe(true);
  });

  it("lowercases shortcodes and keeps id and url", () => {
    setCustomEmoji([{ id: 9, shortcode: "WaVe", url: "/x" }]);
    expect(listCustomEmoji()).toEqual([{ id: 9, shortcode: "wave", url: "/x" }]);
    expect(resolveEmoji("wave")?.id).toBe(9);
  });

  it("skips entries whose shortcode or url is not a string", () => {
    setCustomEmoji([
      { id: 1, shortcode: 5, url: "/a" } as unknown as CustomEmoji,
      { id: 2, shortcode: "ok", url: 7 } as unknown as CustomEmoji,
      { id: 3, shortcode: "fine", url: "/c" },
    ]);
    expect(listCustomEmoji().map((e) => e.id)).toEqual([3]);
  });

  it("skips a null entry without discarding the rest", () => {
    setCustomEmoji([null as unknown as CustomEmoji, WAVE]);
    expect(listCustomEmoji()).toEqual([WAVE]);
  });

  it("skips shortcodes the server would not accept", () => {
    setCustomEmoji([
      { id: 1, shortcode: "a", url: "/1" },
      { id: 2, shortcode: "has space", url: "/2" },
      { id: 3, shortcode: "x".repeat(33), url: "/3" },
      { id: 4, shortcode: "dash-ed", url: "/4" },
      { id: 5, shortcode: "ab", url: "/5" },
      { id: 6, shortcode: "x".repeat(32), url: "/6" },
      { id: 7, shortcode: "ok\n", url: "/7" },
    ]);
    expect(listCustomEmoji().map((e) => e.id)).toEqual([5, 6]);
  });

  it("matches the shortcode pattern exactly", () => {
    expect(SHORTCODE_PATTERN.test("ab")).toBe(true);
    expect(SHORTCODE_PATTERN.test("a_9")).toBe(true);
    expect(SHORTCODE_PATTERN.test("a")).toBe(false);
    expect(SHORTCODE_PATTERN.test("Ab")).toBe(false);
    expect(SHORTCODE_PATTERN.test(" ab")).toBe(false);
    expect(SHORTCODE_PATTERN.test("ab ")).toBe(false);
  });

  it("lets the first spelling win a duplicate in the lookup but keeps both in the list", () => {
    setCustomEmoji([
      { id: 1, shortcode: "dup", url: "/first" },
      { id: 2, shortcode: "DUP", url: "/second" },
    ]);
    expect(listCustomEmoji()).toHaveLength(2);
    expect(resolveEmoji("dup")?.url).toBe("/first");
  });

  it("bumps the revision by one on each write", () => {
    const before = rev();
    setCustomEmoji([WAVE]);
    expect(rev()).toBe(before + 1);
    setCustomEmoji([]);
    expect(rev()).toBe(before + 2);
  });

  it("applies a reply that carries the revision it observed", () => {
    const observed = rev();
    setCustomEmoji([WAVE], observed);
    expect(listCustomEmoji()).toEqual([WAVE]);
    expect(rev()).toBe(observed + 1);
  });

  it("drops a stale reply when a broadcast landed after the fetch was issued", () => {
    const observed = rev();
    setCustomEmoji([PARTY]);
    const afterBroadcast = rev();
    setCustomEmoji([WAVE], observed);
    expect(listCustomEmoji()).toEqual([PARTY]);
    expect(rev()).toBe(afterBroadcast);
  });

  it("treats an unset revision as 0 when checking a reply", () => {
    emojiStore.setState(() => ({ emoji: [], byShortcode: new Map() }));
    setCustomEmoji([WAVE], 0);
    expect(listCustomEmoji()).toEqual([WAVE]);
    expect(emojiStore.getState().rev).toBe(1);
  });

  it("treats an unset revision as 0 when bumping it", () => {
    emojiStore.setState(() => ({ emoji: [], byShortcode: new Map() }));
    setCustomEmoji([]);
    expect(emojiStore.getState().rev).toBe(1);
  });

  it("bumps the revision on clear instead of resetting it, and forgets the set", () => {
    setCustomEmoji([WAVE]);
    const before = rev();
    clearCustomEmoji();
    expect(rev()).toBe(before + 1);
    expect(listCustomEmoji()).toEqual([]);
    expect(customEmojiLoaded()).toBe(false);
    expect(resolveEmoji("wave")).toBeNull();
  });

  it("bumps from 0 when the revision was never set", () => {
    emojiStore.setState(() => ({ emoji: [], byShortcode: new Map() }));
    clearCustomEmoji();
    expect(emojiStore.getState().rev).toBe(1);
  });

  describe("resolveEmoji", () => {
    beforeEach(() => {
      setCustomEmoji([WAVE, PARTY]);
    });

    it("resolves a bare name case-insensitively", () => {
      expect(resolveEmoji("WAVE")).toEqual(WAVE);
    });

    it("resolves the colon spelling", () => {
      expect(resolveEmoji(":party_parrot:")).toEqual(PARTY);
      expect(resolveEmoji(":WAVE:")).toEqual(WAVE);
    });

    it("does not strip a lone leading or trailing colon", () => {
      expect(resolveEmoji(":wave")).toBeNull();
      expect(resolveEmoji("wave:")).toBeNull();
    });

    it("does not treat a bare pair of colons as a name", () => {
      expect(resolveEmoji("::")).toBeNull();
      expect(resolveEmoji(":")).toBeNull();
    });

    it("is null for an unknown name and for a non-string", () => {
      expect(resolveEmoji("nope")).toBeNull();
      expect(resolveEmoji(undefined as unknown as string)).toBeNull();
    });

    it("strips colons only when both ends have one", () => {
      // Dropping a single colon with the first and last character would land on these.
      setCustomEmoji([
        WAVE,
        { id: 7, shortcode: "wav", url: "/7" },
        { id: 8, shortcode: "ave", url: "/8" },
      ]);
      expect(resolveEmoji(":wave")).toBeNull();
      expect(resolveEmoji("wave:")).toBeNull();
      expect(resolveEmoji(":wave:")).toEqual(WAVE);
    });

    it("strips exactly one pair of colons", () => {
      expect(resolveEmoji("::wave::")).toBeNull();
    });
  });
});
