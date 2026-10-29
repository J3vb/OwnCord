// Poll rules that need no DOM: the composer draft's caps, the
// percent and winner rules, whether a poll is over, who may end it, and when
// its countdown label next changes. Pure, so the dialog and the card cannot
// disagree about any of them. The caps mirror Server/service/message_poll.go,
// counted in code points after trimming, as the server counts runes after
// sanitising.
import { channelBitOrRole } from "../../lib/permissions";
import type { PollCreateAnswer, PollInfo } from "../../lib/types";

export const POLL_QUESTION_MAX = 300;
export const POLL_ANSWER_MAX = 55;
export const POLL_MIN_ANSWERS = 2;
export const POLL_MAX_ANSWERS = 10;

/** The durations the server accepts, in hours: 1 h, 4 h, 8 h, 24 h, 3 days, 1 week. */
export const POLL_DURATIONS = [1, 4, 8, 24, 72, 168] as const;
export const POLL_DEFAULT_DURATION = 24;

export interface PollDraftAnswer {
  readonly text: string;
  /** A Unicode emoji or a `:shortcode:`; "" for none. */
  readonly emoji: string;
}

export interface PollDraft {
  readonly question: string;
  readonly answers: readonly PollDraftAnswer[];
  readonly durationHours: number;
  readonly multiselect: boolean;
}

export type DraftProblemKind =
  "question-empty" | "question-long" | "answers-few" | "answer-long" | "control";

export interface DraftProblem {
  readonly kind: DraftProblemKind;
  /** The answer row the problem is on; absent for the question and for the row count. */
  readonly index?: number;
}

/** Length in code points, which is what the server counts (a surrogate pair is one). */
export function codePointLength(text: string): number {
  let n = 0;
  for (const _ of text) n++;
  return n;
}

/** Control characters and the line and paragraph separators: what the server refuses. */
const CONTROL = /[\p{Cc}\p{Zl}\p{Zp}]/u;

/** A fresh draft: two empty answers, one day, single choice. */
export function emptyPollDraft(): PollDraft {
  return {
    question: "",
    answers: [
      { text: "", emoji: "" },
      { text: "", emoji: "" },
    ],
    durationHours: POLL_DEFAULT_DURATION,
    multiselect: false,
  };
}

/** The rows that hold an answer: a blank row is ignored, as the composer ignores it. */
function filledAnswers(draft: PollDraft): readonly (PollDraftAnswer & { index: number })[] {
  return draft.answers
    .map((a, index) => ({ ...a, text: a.text.trim(), index }))
    .filter((a) => a.text !== "");
}

/** Everything that stops the draft from being posted; empty means it can be. */
export function checkPollDraft(draft: PollDraft): readonly DraftProblem[] {
  const problems: DraftProblem[] = [];
  const question = draft.question.trim();
  if (question === "") problems.push({ kind: "question-empty" });
  else if (codePointLength(question) > POLL_QUESTION_MAX) problems.push({ kind: "question-long" });
  if (CONTROL.test(question)) problems.push({ kind: "control" });
  const filled = filledAnswers(draft);
  if (filled.length < POLL_MIN_ANSWERS) problems.push({ kind: "answers-few" });
  for (const a of filled) {
    if (codePointLength(a.text) > POLL_ANSWER_MAX) {
      problems.push({ kind: "answer-long", index: a.index });
    }
    if (CONTROL.test(a.text) || CONTROL.test(a.emoji)) {
      problems.push({ kind: "control", index: a.index });
    }
  }
  return problems;
}

/** The answers as the wire carries them: trimmed, blank rows dropped, emoji only when set. */
export function draftAnswers(draft: PollDraft): readonly PollCreateAnswer[] {
  return filledAnswers(draft).map((a) =>
    a.emoji === "" ? { text: a.text } : { text: a.text, emoji: a.emoji },
  );
}

/** Percent of the poll's distinct voters who picked an answer, whole percent. */
export function answerPercent(count: number, totalVoters: number): number {
  return totalVoters <= 0 ? 0 : Math.round((count * 100) / totalVoters);
}

/** The winning answer ids: the most voted, every tied one; none while nobody voted. */
export function winningAnswers(poll: PollInfo): ReadonlySet<number> {
  let top = 0;
  for (const c of poll.results.counts) top = Math.max(top, c.count);
  if (top === 0) return new Set();
  return new Set(poll.results.counts.filter((c) => c.count === top).map((c) => c.answer_id));
}

/** Whether voting is over: ended by the server, or past `expires_at` on this clock. */
export function isEnded(poll: PollInfo, now: number): boolean {
  if (poll.ended) return true;
  const expires = Date.parse(poll.expires_at);
  return !Number.isNaN(expires) && expires <= now;
}

/** The channel facts `canEndPoll` reads. */
export interface PollEndChannel {
  readonly canDeleteOthers?: boolean | undefined;
}

/**
 * Whether End poll is offered: the author, or, outside a DM, anyone who may
 * delete others' messages in the channel. The server decides; this only keeps
 * the button off for people it would refuse.
 */
export function canEndPoll(
  authorId: number,
  currentUserId: number,
  channel: PollEndChannel | undefined,
  isDm: boolean,
): boolean {
  if (authorId === currentUserId) return true;
  return !isDm && channelBitOrRole(channel?.canDeleteOthers);
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export type TimeLeft =
  | { readonly unit: "under-a-minute" }
  | { readonly unit: "minutes" | "hours" | "days"; readonly count: number };

/** The countdown the card shows for `remainingMs` (> 0): rounded up to its unit. */
export function timeLeft(remainingMs: number): TimeLeft {
  if (remainingMs <= MINUTE) return { unit: "under-a-minute" };
  if (remainingMs <= HOUR) return { unit: "minutes", count: Math.ceil(remainingMs / MINUTE) };
  if (remainingMs <= DAY) return { unit: "hours", count: Math.ceil(remainingMs / HOUR) };
  return { unit: "days", count: Math.ceil(remainingMs / DAY) };
}

/**
 * Milliseconds until `timeLeft` next gives a different label, which is when the
 * card's one timer should fire. At expiry it is the end itself; null once the
 * poll has expired. Never below 1, so a re-arm cannot spin.
 */
export function nextLabelChangeMs(now: number, expiresAt: string): number | null {
  const expires = Date.parse(expiresAt);
  if (Number.isNaN(expires)) return null;
  const remaining = expires - now;
  if (remaining <= 0) return null;
  const unit =
    remaining <= MINUTE ? remaining : remaining <= HOUR ? MINUTE : remaining <= DAY ? HOUR : DAY;
  // The label for k units holds while remaining is in ((k-1)*unit, k*unit].
  const k = Math.ceil(remaining / unit);
  return Math.max(1, remaining - (k - 1) * unit);
}
