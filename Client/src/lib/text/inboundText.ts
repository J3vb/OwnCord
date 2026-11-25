/**
 * The ceiling on message text the client holds and parses. The server stores
 * at most 4000 code points per message (Server/service/message.go's
 * maxMessageLen, also applied to imports; forwards copy a stored text and
 * system rows are short), which is at most 8000 UTF-16 units. The ceiling is
 * four times that, so text a server stores is never touched, while a longer
 * one is cut before the markdown tokeniser and the content patterns see it.
 */
export const MAX_INBOUND_TEXT_UNITS = 32_000;

/** `text`, or its first MAX_INBOUND_TEXT_UNITS units plus an ellipsis, never
 *  splitting a surrogate pair. Returns the same value when it fits, and a
 *  value that is not a string as it came (the callers' own checks own it). */
export function boundInboundText(text: string): string {
  const value: unknown = text;
  if (typeof value !== "string" || value.length <= MAX_INBOUND_TEXT_UNITS) return text;
  let end = MAX_INBOUND_TEXT_UNITS;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return `${text.slice(0, end)}…`;
}
