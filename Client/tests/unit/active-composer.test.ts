import { describe, it, expect, vi } from "vitest";
import {
  canMention,
  claimComposer,
  focusComposer,
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

  it("sends a mention to the composer the user last focused, and hands the slot back on release", () => {
    const channel = makeComposer();
    const thread = makeComposer();
    const releaseChannel = claimComposer(channel);
    const releaseThread = claimComposer(thread);

    mentionInComposer("Dave");
    expect(thread.insertMention).toHaveBeenCalledTimes(1);

    focusComposer(channel);
    mentionInComposer("Eve");
    expect(channel.insertMention).toHaveBeenCalledWith("Eve");

    focusComposer(thread);
    releaseThread();
    mentionInComposer("Fay");
    expect(channel.insertMention).toHaveBeenCalledWith("Fay");
    expect(thread.insertMention).toHaveBeenCalledTimes(1);

    releaseChannel();
    expect(mentionInComposer("Gus")).toBe(false);
  });

  it("ignores a focus on a composer that was already released", () => {
    const live = makeComposer();
    const gone = makeComposer();
    const releaseLive = claimComposer(live);
    claimComposer(gone)();
    focusComposer(gone);
    expect(mentionInComposer("Dave")).toBe(true);
    expect(live.insertMention).toHaveBeenCalledTimes(1);
    releaseLive();
  });

  it("releasing a claim twice drops nothing else", () => {
    const a = makeComposer();
    const b = makeComposer();
    const releaseA = claimComposer(a);
    const releaseB = claimComposer(b);
    releaseA();
    releaseA();

    // b is still claimed: when a later composer leaves, b takes the slot back.
    const c = makeComposer();
    claimComposer(c)();
    expect(mentionInComposer("Dave")).toBe(true);
    expect(b.insertMention).toHaveBeenCalledWith("Dave");
    expect(c.insertMention).not.toHaveBeenCalled();
    releaseB();
  });

  it("releasing a composer that does not hold the slot leaves the focused one in place", () => {
    const a = makeComposer();
    const b = makeComposer();
    const c = makeComposer();
    const releaseA = claimComposer(a);
    const releaseB = claimComposer(b);
    const releaseC = claimComposer(c);
    focusComposer(b);

    releaseA();
    mentionInComposer("Dave");
    expect(b.insertMention).toHaveBeenCalledWith("Dave");
    expect(c.insertMention).not.toHaveBeenCalled();

    releaseC();
    releaseB();
  });
});
