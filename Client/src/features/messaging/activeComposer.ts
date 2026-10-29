/**
 * The composer a "Mention" action should write into: the focused composer. The
 * channel's MessageInput claims the slot while it is mounted, and with a thread
 * panel open the thread's composer claims it too; whichever the user
 * last focused (or mounted) is the one a mention lands in, and closing it hands
 * the slot back to the one still mounted. The member menu reads it without
 * importing the composer, so the menu stays in its own lazy chunk. No imports:
 * a leaf.
 */

/** What the menu needs from a composer. */
export interface MentionTarget {
  /** Insert `@username ` at the caret; false when the composer cannot take text. */
  insertMention(username: string): boolean;
  /** Whether a mention could be inserted right now. */
  canMention(): boolean;
}

/** Every mounted composer, oldest claim first. */
const claimed: MentionTarget[] = [];
let current: MentionTarget | null = null;

/** Register `c` as the focused composer. The returned release drops only `c`'s
 *  own claim: a stale composer's destroy never evicts its replacement, and when
 *  the focused one goes, the most recent of those still mounted takes over. */
export function claimComposer(c: MentionTarget): () => void {
  claimed.push(c);
  current = c;
  return () => {
    const index = claimed.indexOf(c);
    if (index !== -1) claimed.splice(index, 1);
    if (current === c) current = claimed.at(-1) ?? null;
  };
}

/** The user moved into `c`: it is the focused composer now. Ignored once released. */
export function focusComposer(c: MentionTarget): void {
  if (claimed.includes(c)) current = c;
}

/** True when a composer is registered and can take a mention now. */
export function canMention(): boolean {
  return current !== null && current.canMention();
}

/** Insert a mention into the focused composer; false when there is none. */
export function mentionInComposer(username: string): boolean {
  return current !== null && current.insertMention(username);
}
