import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { loadSavedDraft, saveDraft } from "./savedDrafts";

describe("saved drafts (3A-3)", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
  });

  it("round-trips text and reply per channel", () => {
    saveDraft("a.example", 1, 10, {
      content: "half a thought",
      replyTo: { messageId: 5, username: "Ann", ping: false },
    });
    expect(loadSavedDraft("a.example", 1, 10)).toEqual({
      content: "half a thought",
      replyTo: { messageId: 5, username: "Ann", ping: false },
    });
    expect(loadSavedDraft("a.example", 1, 11)).toBeNull();
  });

  it("keeps servers and accounts apart", () => {
    saveDraft("a.example", 1, 10, { content: "mine", replyTo: null });
    expect(loadSavedDraft("b.example", 1, 10)).toBeNull();
    expect(loadSavedDraft("a.example", 2, 10)).toBeNull();
  });

  it("removes a channel's entry when its draft empties", () => {
    saveDraft("a.example", 1, 10, { content: "x", replyTo: null });
    saveDraft("a.example", 1, 10, { content: "", replyTo: null });
    expect(loadSavedDraft("a.example", 1, 10)).toBeNull();
    expect(localStorage.getItem("owncord:drafts:a.example:1")).toBeNull();
  });

  it("keeps the 50 most recently saved drafts", () => {
    for (let ch = 1; ch <= 51; ch++)
      saveDraft("a.example", 1, ch, { content: `c${ch}`, replyTo: null });
    expect(loadSavedDraft("a.example", 1, 1)).toBeNull();
    expect(loadSavedDraft("a.example", 1, 2)?.content).toBe("c2");
    expect(loadSavedDraft("a.example", 1, 51)?.content).toBe("c51");
  });

  it("does not keep a draft too long to ever send", () => {
    saveDraft("a.example", 1, 10, { content: "short", replyTo: null });
    saveDraft("a.example", 1, 10, { content: "x".repeat(8001), replyTo: null });
    expect(loadSavedDraft("a.example", 1, 10)).toBeNull();
  });

  it("trims by save time, not by channel id", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    for (let ch = 100; ch >= 51; ch--) {
      saveDraft("a.example", 1, ch, { content: `c${ch}`, replyTo: null });
      vi.setSystemTime(Date.now() + 1000);
    }
    // Channel 51 is the newest of the 50; a 51st draft evicts the oldest, 100.
    saveDraft("a.example", 1, 1, { content: "c1", replyTo: null });
    expect(loadSavedDraft("a.example", 1, 51)?.content).toBe("c51");
    expect(loadSavedDraft("a.example", 1, 100)).toBeNull();
    expect(loadSavedDraft("a.example", 1, 1)?.content).toBe("c1");
  });

  it("drops a draft untouched for 30 days", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    saveDraft("a.example", 1, 10, { content: "old", replyTo: null });
    vi.setSystemTime(Date.now() + 30 * 24 * 60 * 60 * 1000);
    expect(loadSavedDraft("a.example", 1, 10)).toBeNull();
  });

  it("ignores corrupt or wrongly shaped storage", () => {
    localStorage.setItem("owncord:drafts:a.example:1", "{not json");
    expect(loadSavedDraft("a.example", 1, 10)).toBeNull();
    localStorage.setItem(
      "owncord:drafts:a.example:1",
      JSON.stringify({
        "10": { content: 3, savedAt: Date.now() },
        "11": { content: "ok", replyTo: { messageId: "x" }, savedAt: Date.now() },
      }),
    );
    expect(loadSavedDraft("a.example", 1, 10)).toBeNull();
    expect(loadSavedDraft("a.example", 1, 11)).toBeNull();
    saveDraft("a.example", 1, 12, { content: "fresh", replyTo: null });
    expect(loadSavedDraft("a.example", 1, 12)?.content).toBe("fresh");
  });
});

describe("saved drafts storage shapes", () => {
  const KEY = "owncord:drafts:a.example:1";
  const reply = { messageId: 5, username: "Ann" };

  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  function seed(entries: Record<string, unknown>): void {
    localStorage.setItem(KEY, JSON.stringify(entries));
  }

  it("skips each wrongly shaped entry without losing the good ones beside it", () => {
    const savedAt = Date.now();
    seed({
      "10": { content: "good", savedAt },
      "11": null,
      "12": "text",
      "13": { content: "x", replyTo: null, savedAt },
      "14": { content: "x", replyTo: { messageId: 5 }, savedAt },
      "15": { content: "x", replyTo: { ...reply, messageId: 1.5 }, savedAt },
      "16": { content: "x", replyTo: { ...reply, ping: "yes" }, savedAt },
      "17": { content: "x", replyTo: { ...reply, self: "yes" }, savedAt },
      "18": { content: "x", savedAt: String(savedAt) },
      "19": { content: "x" },
    });
    expect(loadSavedDraft("a.example", 1, 10)?.content).toBe("good");
    for (const channel of [11, 12, 13, 14, 15, 16, 17, 18, 19]) {
      expect(loadSavedDraft("a.example", 1, channel)).toBeNull();
    }
  });

  it("ignores a stored list that is not an object of drafts", () => {
    localStorage.setItem(KEY, JSON.stringify([{ content: "x", savedAt: Date.now() }]));
    expect(loadSavedDraft("a.example", 1, 0)).toBeNull();
    localStorage.setItem(KEY, "null");
    expect(loadSavedDraft("a.example", 1, 10)).toBeNull();
    localStorage.setItem(KEY, "7");
    expect(loadSavedDraft("a.example", 1, 10)).toBeNull();
  });

  it("keeps a reply target whose optional flags are booleans", () => {
    seed({
      "10": { content: "x", replyTo: { ...reply, ping: true, self: false }, savedAt: Date.now() },
    });
    expect(loadSavedDraft("a.example", 1, 10)?.replyTo).toEqual({
      ...reply,
      ping: true,
      self: false,
    });
  });

  it("keeps a reply with no text, and a draft of exactly the longest saveable length", () => {
    saveDraft("a.example", 1, 10, { content: "", replyTo: reply });
    expect(loadSavedDraft("a.example", 1, 10)).toEqual({ content: "", replyTo: reply });
    saveDraft("a.example", 1, 11, { content: "x".repeat(8000), replyTo: null });
    expect(loadSavedDraft("a.example", 1, 11)?.content).toHaveLength(8000);
  });

  it("drops a draft that has neither text nor a reply, even when it was saved before", () => {
    saveDraft("a.example", 1, 10, { content: "x", replyTo: null });
    saveDraft("a.example", 1, 10, { content: "", replyTo: null });
    expect(loadSavedDraft("a.example", 1, 10)).toBeNull();
  });
});

describe("saved drafts racing on one channel", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
  });

  it("two drafts saved for the same channel leave only the later one, in the newest slot", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    saveDraft("a.example", 1, 10, { content: "first", replyTo: null });
    saveDraft("a.example", 1, 11, { content: "other", replyTo: null });
    vi.setSystemTime(Date.now() + 1000);
    saveDraft("a.example", 1, 10, { content: "second", replyTo: null });

    expect(loadSavedDraft("a.example", 1, 10)?.content).toBe("second");
    expect(loadSavedDraft("a.example", 1, 11)?.content).toBe("other");
    const stored = JSON.parse(localStorage.getItem("owncord:drafts:a.example:1")!) as Record<
      string,
      { savedAt: number }
    >;
    expect(Object.keys(stored).toSorted()).toEqual(["10", "11"]);
    expect(stored["10"]!.savedAt).toBeGreaterThan(stored["11"]!.savedAt);
  });
});
