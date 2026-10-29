import { describe, it, expect, beforeEach } from "vitest";
import {
  stickersStore,
  setStickers,
  clearStickers,
  listStickers,
  findSticker,
  stickersLoaded,
} from "../../src/stores/stickers.store";
import { runSessionResets } from "../../src/lib/sessionRegistry";

const wave = { id: 1, name: "Wave", emoji: "👋", url: "/api/v1/stickers/1/image" };
const party = { id: 2, name: "Party", emoji: null, url: "/api/v1/stickers/2/image" };

describe("stickers store", () => {
  beforeEach(() => {
    clearStickers();
    stickersStore.flush();
  });

  it("starts empty and not loaded", () => {
    expect(listStickers()).toEqual([]);
    expect(stickersLoaded()).toBe(false);
  });

  it("replaces the whole set", () => {
    setStickers([wave, party]);
    stickersStore.flush();
    expect(listStickers().map((s) => s.name)).toEqual(["Wave", "Party"]);
    expect(stickersLoaded()).toBe(true);
    setStickers([party]);
    stickersStore.flush();
    expect(listStickers().map((s) => s.name)).toEqual(["Party"]);
    expect(findSticker(1)).toBeNull();
    expect(findSticker(2)?.name).toBe("Party");
  });

  it("skips malformed and duplicate entries", () => {
    setStickers([wave, { ...wave, name: "Dup" }, { id: "x" } as never, null as never]);
    stickersStore.flush();
    expect(listStickers().map((s) => s.name)).toEqual(["Wave"]);
  });

  it("skips an entry whose id is not a number or whose url is missing", () => {
    setStickers([
      { ...wave, id: "1" as never },
      { ...wave, id: 3, name: "NoUrl", url: undefined as never },
      { ...wave, id: 4, name: 7 as never },
      party,
    ]);
    stickersStore.flush();
    expect(listStickers().map((s) => s.name)).toEqual(["Party"]);
  });

  it("keeps a stated emoji and turns a missing one into null", () => {
    setStickers([
      { ...wave, emoji: "\u{1F44B}" },
      { ...party, emoji: undefined as never },
    ]);
    stickersStore.flush();
    expect(listStickers().map((s) => s.emoji)).toEqual(["\u{1F44B}", null]);
  });

  it("normalises an empty emoji to null", () => {
    setStickers([{ ...wave, emoji: "" }]);
    stickersStore.flush();
    expect(listStickers()[0]!.emoji).toBeNull();
  });

  it("drops a fetch reply that a newer write overtook", () => {
    const rev = stickersStore.getState().rev;
    setStickers([party]); // a sticker_update lands while the GET is in flight
    setStickers([wave], rev); // the stale GET answers
    stickersStore.flush();
    expect(listStickers().map((s) => s.name)).toEqual(["Party"]);
  });

  it("applies a fetch reply nothing overtook", () => {
    setStickers([wave], stickersStore.getState().rev);
    stickersStore.flush();
    expect(listStickers()).toHaveLength(1);
  });

  it("a session reset clears the set, so another server's stickers never show", () => {
    setStickers([wave, party]);
    stickersStore.flush();
    const revBefore = stickersStore.getState().rev;
    runSessionResets("server_switch");
    stickersStore.flush();
    expect(listStickers()).toEqual([]);
    expect(stickersLoaded()).toBe(false);
    // A GET still in flight from the old server cannot bring its set back.
    setStickers([wave], revBefore);
    stickersStore.flush();
    expect(listStickers()).toEqual([]);
  });
});
