import { describe, expect, it } from "vitest";
import type { PollInfo } from "../../lib/types";
import {
  POLL_ANSWER_MAX,
  POLL_DURATIONS,
  POLL_MAX_ANSWERS,
  POLL_QUESTION_MAX,
  answerPercent,
  canEndPoll,
  checkPollDraft,
  codePointLength,
  draftAnswers,
  emptyPollDraft,
  isEnded,
  nextLabelChangeMs,
  timeLeft,
  winningAnswers,
  type PollDraft,
} from "./pollModel";

const draft = (over: Partial<PollDraft> = {}): PollDraft => ({
  ...emptyPollDraft(),
  question: "Lunch?",
  answers: [
    { text: "Pizza", emoji: "" },
    { text: "Sushi", emoji: "" },
  ],
  ...over,
});

const kinds = (d: PollDraft): string[] => checkPollDraft(d).map((p) => p.kind);

const poll = (counts: readonly number[], over: Partial<PollInfo> = {}): PollInfo => ({
  question: "q",
  answers: counts.map((_, i) => ({ answer_id: i + 1, text: `a${i + 1}`, emoji: null })),
  allow_multiselect: false,
  expires_at: "2026-10-22T12:00:00Z",
  ended: false,
  ended_at: null,
  results: {
    version: 1,
    total_voters: counts.reduce((a, b) => a + b, 0),
    counts: counts.map((count, i) => ({ answer_id: i + 1, count })),
    me: [],
  },
  ...over,
});

describe("code point counting", () => {
  it("counts a surrogate pair as one, as the server counts runes", () => {
    expect(codePointLength("a😀b")).toBe(3);
    expect("a😀b".length).toBe(4);
  });
});

describe("poll draft caps", () => {
  it("accepts a plain two-answer poll", () => {
    expect(kinds(draft())).toEqual([]);
  });

  it("holds the server's caps and durations", () => {
    expect(POLL_QUESTION_MAX).toBe(300);
    expect(POLL_ANSWER_MAX).toBe(55);
    expect(POLL_MAX_ANSWERS).toBe(10);
    expect(POLL_DURATIONS).toEqual([1, 4, 8, 24, 72, 168]);
    expect(emptyPollDraft().durationHours).toBe(24);
  });

  it("question: 0 refused, 300 accepted, 301 refused", () => {
    expect(kinds(draft({ question: "" }))).toEqual(["question-empty"]);
    expect(kinds(draft({ question: "   " }))).toEqual(["question-empty"]);
    expect(kinds(draft({ question: "q".repeat(300) }))).toEqual([]);
    expect(kinds(draft({ question: "q".repeat(301) }))).toEqual(["question-long"]);
  });

  it("counts the question in code points, so 300 emoji fit", () => {
    expect(kinds(draft({ question: "😀".repeat(300) }))).toEqual([]);
    expect(kinds(draft({ question: "😀".repeat(301) }))).toEqual(["question-long"]);
  });

  it("answers: at least two filled rows, blank rows are ignored", () => {
    const one = draft({
      answers: [
        { text: "Pizza", emoji: "" },
        { text: " ", emoji: "" },
      ],
    });
    expect(kinds(one)).toEqual(["answers-few"]);
    const none = draft({ answers: [] });
    expect(kinds(none)).toEqual(["answers-few"]);
    const padded = draft({
      answers: [
        { text: "A", emoji: "" },
        { text: "", emoji: "" },
        { text: "B", emoji: "" },
      ],
    });
    expect(kinds(padded)).toEqual([]);
  });

  it("an answer: 55 accepted, 56 refused, and the row is named", () => {
    const ok = draft({
      answers: [
        { text: "a".repeat(55), emoji: "" },
        { text: "b", emoji: "" },
      ],
    });
    expect(kinds(ok)).toEqual([]);
    const over = draft({
      answers: [
        { text: "a", emoji: "" },
        { text: "b".repeat(56), emoji: "" },
      ],
    });
    expect(checkPollDraft(over)).toEqual([{ kind: "answer-long", index: 1 }]);
  });

  it("refuses control characters in the question, an answer or an emoji", () => {
    expect(kinds(draft({ question: "a\nb" }))).toEqual(["control"]);
    const inAnswer = draft({
      answers: [
        { text: "a\tb", emoji: "" },
        { text: "c", emoji: "" },
      ],
    });
    expect(checkPollDraft(inAnswer)).toEqual([{ kind: "control", index: 0 }]);
    const inEmoji = draft({
      answers: [
        { text: "a", emoji: "\n" },
        { text: "c", emoji: "" },
      ],
    });
    expect(checkPollDraft(inEmoji)).toEqual([{ kind: "control", index: 0 }]);
  });

  it("sends trimmed answers, no blank rows, and emoji only when set", () => {
    const d = draft({
      answers: [
        { text: "  Pizza ", emoji: "🍕" },
        { text: "", emoji: "🍣" },
        { text: "Sushi", emoji: "" },
      ],
    });
    expect(draftAnswers(d)).toEqual([{ text: "Pizza", emoji: "🍕" }, { text: "Sushi" }]);
  });
});

describe("percent and winners", () => {
  it("rounds to a whole percent of distinct voters", () => {
    expect(answerPercent(1, 3)).toBe(33);
    expect(answerPercent(2, 3)).toBe(67);
    expect(answerPercent(1, 8)).toBe(13);
  });

  it("is zero with no voters, and may sum past 100 on a multiple-choice poll", () => {
    expect(answerPercent(0, 0)).toBe(0);
    expect(answerPercent(3, 4) + answerPercent(4, 4)).toBe(175);
  });

  it("marks the top answer, or every tied one, and none at zero votes", () => {
    expect([...winningAnswers(poll([1, 3, 2]))]).toEqual([2]);
    expect([...winningAnswers(poll([3, 1, 3]))]).toEqual([1, 3]);
    expect(winningAnswers(poll([0, 0])).size).toBe(0);
  });
});

describe("isEnded", () => {
  const now = Date.parse("2026-10-22T12:00:00Z");
  it("is ended when the server says so", () => {
    expect(isEnded(poll([0, 0], { ended: true }), now - 1_000_000)).toBe(true);
  });
  it("is ended from expires_at on, on this clock", () => {
    expect(isEnded(poll([0, 0]), now - 1)).toBe(false);
    expect(isEnded(poll([0, 0]), now)).toBe(true);
    expect(isEnded(poll([0, 0]), now + 1)).toBe(true);
  });
  it("treats an unreadable expiry as open", () => {
    expect(isEnded(poll([0, 0], { expires_at: "nope" }), now)).toBe(false);
  });
});

describe("canEndPoll", () => {
  it("lets the author end it, in a channel or a DM", () => {
    expect(canEndPoll(1, 1, { canDeleteOthers: false }, false)).toBe(true);
    expect(canEndPoll(1, 1, undefined, true)).toBe(true);
  });
  it("lets a moderator end someone else's in a channel only", () => {
    expect(canEndPoll(1, 2, { canDeleteOthers: true }, false)).toBe(true);
    expect(canEndPoll(1, 2, { canDeleteOthers: true }, true)).toBe(false);
  });
  it("refuses a member who cannot delete others' messages", () => {
    expect(canEndPoll(1, 2, { canDeleteOthers: false }, false)).toBe(false);
  });
});

describe("countdown", () => {
  const MIN = 60_000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;
  it("rounds up to its unit", () => {
    expect(timeLeft(30_000)).toEqual({ unit: "under-a-minute" });
    expect(timeLeft(MIN)).toEqual({ unit: "under-a-minute" });
    expect(timeLeft(MIN + 1)).toEqual({ unit: "minutes", count: 2 });
    expect(timeLeft(HOUR)).toEqual({ unit: "minutes", count: 60 });
    expect(timeLeft(HOUR + 1)).toEqual({ unit: "hours", count: 2 });
    expect(timeLeft(3 * HOUR - 5)).toEqual({ unit: "hours", count: 3 });
    expect(timeLeft(DAY)).toEqual({ unit: "hours", count: 24 });
    expect(timeLeft(DAY + 1)).toEqual({ unit: "days", count: 2 });
    expect(timeLeft(7 * DAY)).toEqual({ unit: "days", count: 7 });
  });

  const expires = "2026-10-22T12:00:00Z";
  const end = Date.parse(expires);

  it("is null once the poll has expired or the expiry is unreadable", () => {
    expect(nextLabelChangeMs(end, expires)).toBeNull();
    expect(nextLabelChangeMs(end + 5, expires)).toBeNull();
    expect(nextLabelChangeMs(end, "nope")).toBeNull();
  });

  it("under a minute it waits for the end itself", () => {
    expect(nextLabelChangeMs(end - 20_000, expires)).toBe(20_000);
  });

  it("waits until the label's unit rolls over", () => {
    // 2 h 30 min left reads "3 hours" and turns "2 hours" in 30 min.
    expect(nextLabelChangeMs(end - 2.5 * HOUR, expires)).toBe(0.5 * HOUR);
    // Exactly 3 h left reads "3 hours" and turns "2 hours" in an hour.
    expect(nextLabelChangeMs(end - 3 * HOUR, expires)).toBe(HOUR);
    // 90 s left reads "2 minutes" and turns "under a minute" in 30 s.
    expect(nextLabelChangeMs(end - 90_000, expires)).toBe(30_000);
    // 3 d 6 h left reads "4 days" and turns "3 days" in 6 h.
    expect(nextLabelChangeMs(end - (3 * DAY + 6 * HOUR), expires)).toBe(6 * HOUR);
  });

  it("the label really changes at the time it names", () => {
    for (const left of [2.5 * HOUR, 90_000, 3 * DAY + 6 * HOUR, 45 * MIN + 1]) {
      const wait = nextLabelChangeMs(end - left, expires)!;
      expect(timeLeft(left - wait)).not.toEqual(timeLeft(left));
      expect(timeLeft(left - wait + 1)).toEqual(timeLeft(left));
    }
  });

  it("never asks for less than a millisecond", () => {
    expect(nextLabelChangeMs(end - 0.4, expires)).toBe(1);
  });
});
