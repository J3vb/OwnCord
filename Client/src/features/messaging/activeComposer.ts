/**
 * The composer a "Mention" action should write into. MessageInput claims the
 * slot while it is mounted; the member menu reads it without importing the
 * composer, so the menu stays in its own lazy chunk. No imports: a leaf.
 */

/** What the menu needs from a composer. */
export interface MentionTarget {
  /** Insert `@username ` at the caret; false when the composer cannot take text. */
  insertMention(username: string): boolean;
  /** Whether a mention could be inserted right now. */
  canMention(): boolean;
}

let current: MentionTarget | null = null;

/** Register `c` as the active composer. The returned release clears the slot
 *  only while `c` is still the registered one, so a stale composer's destroy
 *  never evicts its replacement. */
export function claimComposer(c: MentionTarget): () => void {
  current = c;
  return () => {
    if (current === c) current = null;
  };
}

/** True when a composer is registered and can take a mention now. */
export function canMention(): boolean {
  return current !== null && current.canMention();
}

/** Insert a mention into the active composer; false when there is none. */
export function mentionInComposer(username: string): boolean {
  return current !== null && current.insertMention(username);
}
