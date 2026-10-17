// emojiRecent — the persisted "recently used" emoji list. A leaf module so the
// message list (quick reactions) can read it without pulling the picker, which
// loads on first use, into the main-page chunk.

import { resolveEmoji } from "@stores/emoji.store";

const MAX_RECENT = 20;
const RECENT_KEY = "owncord:recent-emoji";

// ---------------------------------------------------------------------------
// Recent emoji persistence
// ---------------------------------------------------------------------------

/**
 * What is actually on disk: parsed, type-checked, capped. No display
 * filtering — this is the list the write path must preserve.
 */
function readStoredRecent(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((e): e is string => typeof e === "string");
  } catch {
    return [];
  }
}

/**
 * What the picker should show, which is a strict subset of what is stored.
 *
 * Display only — never feed this back into `localStorage` (OC-0363). The
 * recent list is a single key shared by every server this client connects to,
 * so a `:shortcode:` that does not resolve *here* is routinely alive on
 * another server, or alive on this one a moment later once `GET /emoji`
 * lands, or after a failed fetch is retried. Persisting the filtered list
 * turns "do not show this" into "delete this", for every server at once.
 */
export function getRecentEmoji(): string[] {
  try {
    // A `:shortcode:`-shaped entry is only meaningful when it still resolves
    // on *this* server: a custom emoji clicked on one server would otherwise
    // leak as dead literal text into every other server's picker, and a
    // deleted emoji would do the same on its own server forever after. Plain
    // unicode entries (no colons) are never shortcode-shaped and pass through
    // untouched (OC-0308).
    return readStoredRecent()
      .filter((e) => !(e.startsWith(":") && e.endsWith(":")) || resolveEmoji(e) !== null)
      .slice(0, MAX_RECENT);
  } catch {
    // resolveEmoji reads the emoji store. A throw here used to be swallowed by
    // the reader's own try/catch and degrade to an empty Recent row; without
    // this it would propagate out of createEmojiPicker and take the composer's
    // emoji button and the reaction picker down with it.
    return [];
  }
}

export function addRecentEmoji(emoji: string): void {
  const recent = readStoredRecent().filter((e) => e !== emoji);
  recent.unshift(emoji);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(recent.slice(0, MAX_RECENT)));
  } catch {
    // localStorage full or unavailable — ignore
  }
}
