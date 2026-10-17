import { describe, it, expect, vi } from "vitest";
import {
  canMention,
  claimComposer,
  mentionInComposer,
  type MentionTarget,
} from "../../src/features/messaging/activeComposer";

function makeComposer(usable = true): MentionTarget & { insertMention: ReturnType<typeof vi.fn> } {
  return { insertMention: vi.fn(() => usable), canMention: () => usable };
}

describe("activeComposer", () => {
  it("has no composer until one claims the slot", () => {
    expect(canMention()).toBe(false);
    expect(mentionInComposer("Dave")).toBe(false);
  });

  it("routes a mention to the claimed composer", () => {
    const c = makeComposer();
    const release = claimComposer(c);
    expect(canMention()).toBe(true);
    expect(mentionInComposer("Dave")).toBe(true);
    expect(c.insertMention).toHaveBeenCalledWith("Dave");
    release();
    expect(mentionInComposer("Dave")).toBe(false);
  });

  it("reports a composer that cannot take text as unavailable", () => {
    const release = claimComposer(makeComposer(false));
    expect(canMention()).toBe(false);
    expect(mentionInComposer("Dave")).toBe(false);
    release();
  });

  // (23) a stale composer's destroy must not evict the one that replaced it
  it("release clears only its own claim", () => {
    const first = makeComposer();
    const second = makeComposer();
    const releaseFirst = claimComposer(first);
    const releaseSecond = claimComposer(second);

    releaseFirst();
    expect(mentionInComposer("Dave")).toBe(true);
    expect(second.insertMention).toHaveBeenCalledTimes(1);
    expect(first.insertMention).not.toHaveBeenCalled();

    releaseSecond();
    expect(mentionInComposer("Dave")).toBe(false);
  });
});
