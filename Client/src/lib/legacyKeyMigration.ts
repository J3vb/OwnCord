// legacyKeyMigration — move a pre-scoping localStorage value to its
// host-scoped key exactly once.
//
// The client is multi-server on one localStorage and user ids are only unique
// per server, so a value saved before keys were host-scoped may reach the
// FIRST host that misses at its scoped key and no other (OC-0313, OC-0329;
// the shape channel-mutes.ts fixed for OC-0288). The legacy key is removed
// before the scoped copy is written — its bytes are then free for the copy
// and the key is closed to every later host. When the copy still fails
// (storage full to within the scoped key's extra length), the value goes back
// under the legacy key together with a claim naming the scoped key that owns
// it, and this session remembers the claim as well, so no other host reads or
// consumes it and the owner retries the copy on its next read.

const CLAIM_PREFIX = "owncord:legacy-claim:";

/** Migrations this session could not complete, by legacy key. */
const unsettled = new Map<string, { scopedKey: string; value: string }>();

/**
 * Returns the legacy value when it belongs to `scopedKey` — migrated now, or
 * retained for it after an earlier failed copy — and `null` when there is
 * none or another host owns it. Never throws: unusable storage reads as
 * `null`.
 */
export function migrateLegacyValue(legacyKey: string, scopedKey: string): string | null {
  const claimKey = CLAIM_PREFIX + legacyKey;
  try {
    const held = unsettled.get(legacyKey);
    if (held !== undefined && held.scopedKey !== scopedKey) return null;
    const claim = localStorage.getItem(claimKey);
    if (claim !== null && claim !== scopedKey) return null;

    const value = held?.value ?? localStorage.getItem(legacyKey);
    if (value === null) {
      localStorage.removeItem(claimKey);
      return null;
    }
    localStorage.removeItem(legacyKey);
    if (persist(scopedKey, value)) {
      unsettled.delete(legacyKey);
      localStorage.removeItem(claimKey);
      return value;
    }
    unsettled.set(legacyKey, { scopedKey, value });
    persist(legacyKey, value);
    persist(claimKey, scopedKey);
    return value;
  } catch {
    return null;
  }
}

function persist(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}
