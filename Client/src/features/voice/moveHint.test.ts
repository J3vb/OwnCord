/**
 * The moderator-move and AFK-move notes the voice UI sounds and the AFK toast
 * read: each is spent by the first connect or acknowledgement that settles it.
 */
import { afterEach, describe, expect, it } from "vitest";
import { runSessionResets } from "../../lib/sessionRegistry";
import {
  clearAfkMove,
  isVoiceMovePending,
  noteAfkMove,
  noteVoiceMoved,
  takeAfkMove,
  takeVoiceMoved,
} from "./moveHint";

afterEach(() => {
  takeVoiceMoved(null);
  clearAfkMove();
});

describe("moderator move note", () => {
  it("is pending from the note until a connect or teardown settles it", () => {
    expect(isVoiceMovePending()).toBe(false);
    noteVoiceMoved(20);
    expect(isVoiceMovePending()).toBe(true);
    expect(takeVoiceMoved(20)).toBe(true);
    expect(isVoiceMovePending()).toBe(false);
  });

  it("answers false for a teardown, and for a teardown with nothing noted", () => {
    expect(takeVoiceMoved(null)).toBe(false);
    noteVoiceMoved(20);
    expect(takeVoiceMoved(null)).toBe(false);
    expect(isVoiceMovePending()).toBe(false);
  });

  it("is spent by a connect to a different channel, which is not the move", () => {
    noteVoiceMoved(20);
    expect(takeVoiceMoved(30)).toBe(false);
    expect(isVoiceMovePending()).toBe(false);
    expect(takeVoiceMoved(20)).toBe(false);
  });

  it("is answered once: the second connect to the same channel is an ordinary join", () => {
    noteVoiceMoved(20);
    expect(takeVoiceMoved(20)).toBe(true);
    expect(takeVoiceMoved(20)).toBe(false);
  });

  it("is replaced by a newer move", () => {
    noteVoiceMoved(20);
    noteVoiceMoved(30);
    expect(takeVoiceMoved(20)).toBe(false);
    noteVoiceMoved(20);
    noteVoiceMoved(30);
    expect(takeVoiceMoved(30)).toBe(true);
  });
});

describe("AFK move note", () => {
  it("is answered once, for the channel it was noted for", () => {
    noteAfkMove(5);
    expect(takeAfkMove(5)).toBe(true);
    expect(takeAfkMove(5)).toBe(false);
  });

  it("is spent by an acknowledgement for a different channel", () => {
    noteAfkMove(5);
    expect(takeAfkMove(6)).toBe(false);
    expect(takeAfkMove(5)).toBe(false);
  });

  it("is replaced by a newer move and dropped by clearAfkMove", () => {
    noteAfkMove(5);
    noteAfkMove(6);
    expect(takeAfkMove(5)).toBe(false);
    noteAfkMove(6);
    clearAfkMove();
    expect(takeAfkMove(6)).toBe(false);
  });

  it("is independent of the moderator move note", () => {
    noteAfkMove(5);
    noteVoiceMoved(5);
    expect(takeVoiceMoved(5)).toBe(true);
    expect(takeAfkMove(5)).toBe(true);
  });
});

describe("session reset", () => {
  it("forgets both notes", () => {
    noteVoiceMoved(20);
    noteAfkMove(5);

    expect(runSessionResets("user")).toEqual([]);

    expect(isVoiceMovePending()).toBe(false);
    expect(takeAfkMove(5)).toBe(false);
  });
});
