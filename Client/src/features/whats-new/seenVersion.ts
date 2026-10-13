/**
 * Which version's notes this install last showed. A fresh install records its
 * version silently (there is nothing "new" to someone who just installed it);
 * only a later, different version counts as an update worth announcing.
 */

const SEEN_KEY = "owncord:whats-new:seen-version";

function readSeen(): string | null {
  try {
    return localStorage.getItem(SEEN_KEY);
  } catch {
    return null;
  }
}

export function markVersionSeen(version: string): void {
  try {
    localStorage.setItem(SEEN_KEY, version);
  } catch {
    // Storage unavailable: the notes may show again next start, nothing worse.
  }
}

/** True when this start is the first one on a version other than the last one
 *  seen. A first install is recorded and answers false. */
export function isNewVersion(version: string): boolean {
  const seen = readSeen();
  if (seen === null) {
    markVersionSeen(version);
    return false;
  }
  return seen !== version;
}
