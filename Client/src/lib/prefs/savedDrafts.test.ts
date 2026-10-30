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
