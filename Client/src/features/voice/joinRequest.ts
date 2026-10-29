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

/** Records the envelope id of the voice_join just sent; a newer join replaces an older one. */
export function noteJoinSent(id: string | undefined): void {
  pendingId = id ?? null;
}

/**
 * True when this error refuses the pending join. An id must match the latest
 * join (an earlier, superseded join's refusal does not count) and is consumed
 * on a match; an id-less error counts only for a join code.
 */
export function takeJoinRefusal(code: string, id: string | undefined): boolean {
  if (id === undefined) return OLD_SERVER_JOIN_CODES.has(code);
  if (pendingId === null || id !== pendingId) return false;
  pendingId = null;
  return true;
}

/** Test seam: forget the pending join. */
export function resetJoinRequest(): void {
  pendingId = null;
}
