// Deep equality for a message row against its refetched twin, so a history
// merge can keep the loaded row object when nothing changed.

/** Fields only a live chat_message row carries (the user's role and nickname,
 *  the echoed client_message_id); history never sends them, so their absence
 *  from a refetched row is not a change. */
const LIVE_ONLY_KEYS = new Set(["clientMessageId", "role", "display_name"]);

/** The keys of `o` that count toward sameValue. */
function present(o: Record<string, unknown>): string[] {
  return Object.keys(o).filter((k) => o[k] != null && !LIVE_ONLY_KEYS.has(k));
}

/** Deep equality over plain data; null, undefined and live-only properties
 *  count as absent and key order is ignored, so a live-built row equals its
 *  REST twin. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const x = a as Record<string, unknown>;
  const y = b as Record<string, unknown>;
  const keys = present(x);
  return keys.length === present(y).length && keys.every((k) => sameValue(x[k], y[k]));
}
