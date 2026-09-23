// Echo reconciliation for the messages store: decides whether a server-sourced
// row is the echo of one of our own unreconciled optimistic sends, allowing
// for the server's sanitization — extracted from stores/messages.store.ts.
import type { Message } from "./messageModel";

const unescapeOnce = (input: string): string =>
  input
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
// Repeated rather than a single pass: a lone `replace` can in principle
// splice a fresh `<...>` out of the text either side of what it removed.
// echoNormalize's own fixpoint loop already absorbed that, so this is
// output-identical -- it just puts the repetition where a reader (and
// CodeQL's js/incomplete-multi-character-sanitization) can see it.
const stripTags = (input: string): string => {
  let out = input;
  while (out.includes("<")) {
    const next = out.replace(/<[^>]*>/g, "");
    if (next === out) break;
    out = next;
  }
  return out;
};

/**
 * Approximates one round of the server's `sanitizePass`
 * (Server/service/message.go): unescape HTML entities, strip tags (bluemonday's
 * StrictPolicy keeps only surviving text), then unescape once more. Not a
 * byte-exact port — bluemonday additionally re-escapes special characters left
 * in the surviving text on write, which this skips — but it recognizes the
 * two shapes that actually break naive byte-equality against our own echo:
 * stripped tags and unescaped entities. Only used by echoNormalize below, to
 * decide whether a replayed server echo is *our* sanitized send.
 */
function sanitizePassApprox(s: string): string {
  return unescapeOnce(stripTags(unescapeOnce(s)));
}

/**
 * Approximates the server's `sanitizeToFixpoint`: repeats sanitizePassApprox
 * until it stops changing (bounded, since real message content is short and
 * each pass only ever shrinks or holds steady). Used to normalize what the
 * user typed before comparing it against a server echo, since the server
 * sanitizes content before storing/broadcasting it — see isUnreconciledEcho.
 */
export function echoNormalize(s: string): string {
  let cur = s;
  for (let i = 0; i < 20; i++) {
    const next = sanitizePassApprox(cur);
    if (next === cur) return next;
    cur = next;
  }
  return cur;
}

/**
 * Whether `optimistic` is an unreconciled local row for the same send that
 * `candidate` (a fresh server-sourced "sent" row) represents — i.e. the
 * server did persist the send but the local row never learned that, because
 * its chat_send_ok ack was lost. Shared by addMessage's live-broadcast path
 * and setMessages' resync merge so the two never grow divergent notions of
 * "same message".
 *
 * Bounded to avoid collapsing two genuinely distinct sends that happen to
 * share text: only rows still actually awaiting reconciliation qualify —
 * "pending", or "failed" for a reason (OFFLINE) that means the send may
 * still have gone through despite the local failure. A server-rejected send
 * (SLOW_MODE/FORBIDDEN/...) is never broadcast or replayed, so no echo can
 * legitimately arrive for it; matching those would silently eat a row the
 * user still needs to retry. Beyond that, callers must consume each
 * candidate at most once (findIndex + a seen-set) so N identical pending
 * sends match N identical real messages one-to-one instead of collapsing
 * onto a single row.
 */
export function isUnreconciledEcho(optimistic: Message, candidate: Message): boolean {
  // Stable identities must never fall back to text matching: another device
  // can send identical text, and history does not carry this private receipt.
  if (optimistic.clientMessageId !== undefined) {
    return (
      optimistic.status !== "sent" &&
      optimistic.user.id === candidate.user.id &&
      optimistic.clientMessageId === candidate.clientMessageId
    );
  }
  return (
    (optimistic.status === "pending" ||
      (optimistic.status === "failed" && optimistic.errorCode === "OFFLINE")) &&
    optimistic.correlationId !== null &&
    optimistic.user.id === candidate.user.id &&
    (optimistic.content === candidate.content ||
      echoNormalize(optimistic.content) === candidate.content)
  );
}
