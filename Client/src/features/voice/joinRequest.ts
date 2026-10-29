import { WsErrorCode } from "@lib/protocolTypes";
// Which error frame answers the voice_join in flight. Servers echo the join's
// envelope id on every refusal, so an error for any other command (a refused
// chat_edit, a rate-limited typing frame) must not cancel the join. Older
// servers send join refusals with no id; for those only a code the join
// handler can emit counts.

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

/**
 * Records the envelope id of the voice_join just sent; a newer join replaces an
 * older one. `passwordRetry` marks the user's retry with a typed password.
 */
export function noteJoinSent(id: string | undefined, passwordRetry = false): void {
  pendingId = id ?? null;
  pendingPasswordRetry = id !== undefined && passwordRetry;
  refusal = null;
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
  if (id === undefined) return OLD_SERVER_JOIN_CODES.has(code);
  if (pendingId === null || id !== pendingId) return false;
  refusal = { id, channelId, passwordRetry: pendingPasswordRetry };
  pendingId = null;
  pendingPasswordRetry = false;
  return true;
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

/** Test seam: forget the pending join. */
export function resetJoinRequest(): void {
  pendingId = null;
  pendingPasswordRetry = false;
  refusal = null;
}
