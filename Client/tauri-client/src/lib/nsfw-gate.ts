/**
 * Per-session acknowledgement of a channel's NSFW flag.
 *
 * The server treats `nsfw` as a label and nothing more — it stores it,
 * broadcasts it and audits an operator flipping it, but applies no content
 * behaviour of its own: no filtering, no age check, no restriction on who may
 * read or post. Everything a user experiences from the flag is decided here.
 *
 * What this client decides: the first time a session opens a flagged channel,
 * show a warning the reader must accept before its messages are rendered.
 *
 * Remembered in **sessionStorage**, deliberately, not localStorage: the promise
 * this makes is "once per session", so closing the app and coming back asks
 * again. It is a courtesy prompt, not a security control — a determined reader
 * clears the key, and the messages were never withheld by the server anyway.
 */

const STORAGE_PREFIX = "owncord:nsfw-ack:";

function storageKey(channelId: number): string {
  return `${STORAGE_PREFIX}${channelId}`;
}

/**
 * Whether this session has already accepted the warning for `channelId`.
 *
 * A sessionStorage that throws (private modes, a sandboxed webview, a disabled
 * storage partition) is read as "not acknowledged": erring toward showing the
 * prompt again is the harmless direction, where erring the other way would
 * silently drop the gate the flag exists to produce.
 */
export function isNsfwAcknowledged(channelId: number): boolean {
  try {
    return sessionStorage.getItem(storageKey(channelId)) === "1";
  } catch {
    return false;
  }
}

/** Record that this session accepted the warning for `channelId`. */
export function acknowledgeNsfw(channelId: number): void {
  try {
    sessionStorage.setItem(storageKey(channelId), "1");
  } catch {
    // Storage unavailable — the gate simply asks again next time. Nothing to
    // recover from, and failing the channel open over it would be absurd.
  }
}

/** Drop every stored acknowledgement (used by tests and by logout). */
export function clearNsfwAcknowledgements(): void {
  try {
    const keys: string[] = [];
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i);
      if (key !== null && key.startsWith(STORAGE_PREFIX)) keys.push(key);
    }
    for (const key of keys) sessionStorage.removeItem(key);
  } catch {
    // Nothing stored means nothing to clear.
  }
}

/**
 * Whether opening `channel` should show the age gate: flagged, and not yet
 * acknowledged in this session.
 */
export function nsfwGateRequired(channel: { id: number; nsfw: boolean }): boolean {
  return channel.nsfw && !isNsfwAcknowledged(channel.id);
}
