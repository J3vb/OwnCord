import { WsErrorCode } from "@lib/protocolTypes";
import { joinRefusalsCarryIds } from "@lib/net/serverCapabilities";
import { registerSessionReset } from "@lib/net/sessionRegistry";
import { voiceStore } from "@stores/voice.store";
import { clearOwedLeave } from "./leaveOwed";
// Which error frame answers the voice_join in flight. Servers echo the join's
// envelope id on every refusal, so an error for any other command (a refused
// chat_edit, a rate-limited typing frame) must not cancel the join. Older
// servers send join refusals with no id; for those only a code the join
// handler can emit counts. A server known to echo the id never gets that
// fallback: there an id-less error always answers something else.
//
// A join also waits a bounded time for its answer (a voice_token or a
// refusal). A frame lost with its socket has neither, and without the bound
// the call would read "Connecting…" until the user gave up.

/** Codes an older server's voice_join refusal can carry without an id. */
export const OLD_SERVER_JOIN_CODES: ReadonlySet<string> = Object.freeze(
  new Set([
    WsErrorCode.CHANNEL_FULL,
    WsErrorCode.VOICE_ERROR,
    WsErrorCode.FORBIDDEN,
    WsErrorCode.NOT_FOUND,
    WsErrorCode.BAD_REQUEST,
    WsErrorCode.RATE_LIMITED,
    WsErrorCode.ALREADY_JOINED,
    WsErrorCode.INTERNAL,
    WsErrorCode.TIMED_OUT,
  ]),
);

let pendingId: string | null = null;
// Whether the join in flight carried a password the user just typed.
let pendingPasswordRetry = false;

/** The refusal of the latest join, kept until the error chain has read it. */
interface Refusal {
  readonly id: string;
  readonly channelId: number | null;
  readonly passwordRetry: boolean;
}
let refusal: Refusal | null = null;

let nonRetryJoinListener: (() => void) | null = null;

// Counts every join sent, so work started for one join can tell a newer one began.
let joinCount = 0;

/** How long a join waits for its answer. The server answers in one round trip. */
export const JOIN_ANSWER_WAIT_MS = 15_000;

export interface JoinAnswerWait {
  /** False while the chat socket is between connections. */
  readonly socketSettled: () => boolean;
  /** The latest join got no answer: end it. */
  readonly onUnanswered: () => void;
}

let answerWait: JoinAnswerWait | null = null;
let answerTimer: ReturnType<typeof setTimeout> | null = null;
// The channel of the latest join while its answer is still out, else null.
let awaitedChannelId: number | null = null;

/** Who ends a join that got no answer: the voice routes, for as long as they are wired. */
export function setJoinAnswerWait(wait: JoinAnswerWait | null): void {
  answerWait = wait;
  // Unwired, nothing could end the join: drop its wait with the wiring.
  if (wait === null) settleAnswerWait();
}

function clearAnswerTimer(): void {
  if (answerTimer !== null) clearTimeout(answerTimer);
  answerTimer = null;
}

function armAnswerTimer(seq: number, channelId: number): void {
  clearAnswerTimer();
  answerTimer = setTimeout(() => {
    answerTimer = null;
    if (joinCount !== seq || awaitedChannelId !== channelId) return;
    const { currentChannelId, voiceStatus } = voiceStore.getState();
    // Left, rolled back or moved on since: nothing is waiting any more.
    if (currentChannelId !== channelId || voiceStatus !== "joining") {
      awaitedChannelId = null;
      return;
    }
    // A socket still reconnecting can carry neither the answer nor the leave.
    if (answerWait !== null && !answerWait.socketSettled()) {
      armAnswerTimer(seq, channelId);
      return;
    }
    awaitedChannelId = null;
    answerWait?.onUnanswered();
  }, JOIN_ANSWER_WAIT_MS);
}

// The server granted a join this device no longer wanted (its token arrived
// after the user had clicked another channel), so it may hold a call for this
// socket that no session here shows.
let strandedMembership = false;

/** A token for a channel the user already clicked away from was let pass. */
export function noteTokenIgnored(): void {
  strandedMembership = true;
}

/** The server's membership is accounted for again: a token was taken up. */
export function noteTokenAccepted(): void {
  strandedMembership = false;
}

/** Whether a let-pass token may have left a membership behind; read once. */
export function takeStrandedMembership(): boolean {
  const stranded = strandedMembership;
  strandedMembership = false;
  return stranded;
}

/** A voice_token for `channelId` arrived: the join for that channel is answered. */
export function noteJoinAnswered(channelId: number): void {
  if (awaitedChannelId !== channelId) return;
  awaitedChannelId = null;
  clearAnswerTimer();
}

/** How many joins have been sent; compare two reads to see whether a newer join started. */
export function joinSequence(): number {
  return joinCount;
}

/**
 * Runs whenever a join other than a typed-password retry starts: whatever that
 * join is for, a password dialog still open is about an older attempt. The one
 * listener is the lazily loaded password prompt, which sets it as it loads.
 */
export function onNonRetryJoin(listener: () => void): void {
  nonRetryJoinListener = listener;
}

/**
 * Records the envelope id of the voice_join just sent; a newer join replaces an
 * older one. `passwordRetry` marks the user's retry with a typed password.
 */
export function noteJoinSent(id: string | undefined, passwordRetry = false): void {
  if (!passwordRetry) nonRetryJoinListener?.();
  // Even a join dropped on a down socket: the server's resume check ends a
  // membership that never reaches the SFU.
  clearOwedLeave();
  joinCount += 1;
  pendingId = id ?? null;
  pendingPasswordRetry = id !== undefined && passwordRetry;
  refusal = null;
  // Every caller records the join in the store before it sends the frame.
  awaitedChannelId = voiceStore.getState().currentChannelId;
  if (awaitedChannelId === null) clearAnswerTimer();
  else armAnswerTimer(joinCount, awaitedChannelId);
}

/**
 * True when this error refuses the pending join. An id must match the latest
 * join (an earlier, superseded join's refusal does not count) and is consumed
 * on a match; an id-less error counts only for a join code.
 */
export function takeJoinRefusal(
  code: string,
  id: string | undefined,
  channelId: number | null = null,
): boolean {
  if (id === undefined) {
    if (joinRefusalsCarryIds() || !OLD_SERVER_JOIN_CODES.has(code)) return false;
    settleAnswerWait();
    return true;
  }
  if (pendingId === null || id !== pendingId) return false;
  refusal = { id, channelId, passwordRetry: pendingPasswordRetry };
  pendingId = null;
  pendingPasswordRetry = false;
  settleAnswerWait();
  return true;
}

function settleAnswerWait(): void {
  awaitedChannelId = null;
  clearAnswerTimer();
}

/** True when the refusal of join `id` (already taken) answered a typed password. */
export function refusalWasPasswordRetry(id: string | undefined): boolean {
  return id !== undefined && refusal?.id === id && refusal.passwordRetry;
}

/**
 * The channel and kind of the join whose refusal `takeJoinRefusal` accepted for
 * `id`, once. Null for any other id: an error answering another command, or a
 * join since superseded.
 */
export function takeRefusedJoin(
  id: string | undefined,
): { readonly channelId: number | null; readonly passwordRetry: boolean } | null {
  if (id === undefined || refusal === null || refusal.id !== id) return null;
  const taken = refusal;
  refusal = null;
  return { channelId: taken.channelId, passwordRetry: taken.passwordRetry };
}

/** Forget the pending join: the session ended (and the tests' seam). */
export function resetJoinRequest(): void {
  pendingId = null;
  pendingPasswordRetry = false;
  refusal = null;
  strandedMembership = false;
  settleAnswerWait();
}

// App-lifetime: a session that ended has no join left to wait for.
void registerSessionReset("voice:join-request", resetJoinRequest, { phase: "cache" });
