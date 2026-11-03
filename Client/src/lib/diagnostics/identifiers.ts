// Stand-ins for values the event log must not hold: a device label becomes an
// 8-hex hash, a user or channel id a short pseudonym (u1, c2). The hash key and
// the pseudonym table are new each time the app starts and live in memory
// only, so two runs cannot be matched and the raw value never reaches the log.

const MAX_PSEUDONYMS = 9999;

function randomKey(): number {
  const buf = new Uint32Array(1);
  globalThis.crypto.getRandomValues(buf);
  return buf[0]!;
}

let key = randomKey();
const tables = { u: new Map<string, string>(), c: new Map<string, string>() };

/** FNV-1a over the run key and the value, as 8 hex characters. */
export function reportHash(value: string): string {
  let h = 0x811c9dc5 ^ key;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** u<n> for a user id, c<n> for a channel id; the same id gets the same one. */
export function pseudonym(kind: "u" | "c", id: string | number): string {
  const table = tables[kind];
  const raw = String(id);
  const known = table.get(raw);
  if (known !== undefined) return known;
  if (table.size >= MAX_PSEUDONYMS) return `${kind}0`;
  const next = `${kind}${table.size + 1}`;
  table.set(raw, next);
  return next;
}

/** Test seam: a fresh key and empty tables. */
export function resetIdentifiersForTests(): void {
  key = randomKey();
  tables.u.clear();
  tables.c.clear();
}
