/**
 * Spoiler attachments (6.12). An attachment is a spoiler when its filename
 * starts with `SPOILER_`, Discord's convention, so no protocol or schema
 * change is needed: the server stores and returns the filename as uploaded.
 * The composer toggles the prefix before upload; the message list reads it.
 */

export const SPOILER_PREFIX = "SPOILER_";

/** Whether `filename` carries the spoiler prefix. The prefix alone, with no
 *  name after it, is not a mark. Case-sensitive, like Discord's. */
export function isSpoilerFilename(filename: string): boolean {
  return filename.length > SPOILER_PREFIX.length && filename.startsWith(SPOILER_PREFIX);
}

/** `filename` with the spoiler mark flipped: added when absent, and when
 *  present stripped exactly once (`SPOILER_SPOILER_x` becomes `SPOILER_x`). */
export function toggleSpoilerFilename(filename: string): string {
  return isSpoilerFilename(filename)
    ? filename.slice(SPOILER_PREFIX.length)
    : SPOILER_PREFIX + filename;
}
