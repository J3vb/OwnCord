/**
 * Identity-key storage — the OS keyring / TOFU pin seam `lib/identity.ts`
 * wraps today. Seam: `saveIdentityKey`, `loadIdentityKey`, `deleteIdentityKey`,
 * `storeIdentityPin` and `getIdentityPin` are exported functions already, so
 * each contract method below has that function's exact signature.
 *
 * The higher-level lifecycle (`getOrCreateIdentityKeyPair`, the legacy-key
 * migration, `ensureIdentityKeyPublished`) is app logic built on top of these
 * five primitives, not itself part of the native seam — it stays in
 * `lib/identity.ts` and keeps calling this contract's methods after B7-4.
 */

/** Re-declared, structurally identical to `StoreIdentityPinResult`
 *  (`lib/identity.ts`). */
export type StoreIdentityPinResult = "stored" | "no-store" | "failed";

/** Re-declared, structurally identical to `IdentityPinLookup` (`lib/identity.ts`). */
export type IdentityPinLookup =
  | { readonly status: "pinned"; readonly pin: string }
  | { readonly status: "unpinned" }
  | { readonly status: "unavailable" };

export interface IdentityStore {
  saveKey(host: string, key: string): Promise<boolean>;
  loadKey(host: string): Promise<string | null>;
  deleteKey(host: string): Promise<boolean>;
  storePin(host: string, userId: string, pin: string): Promise<StoreIdentityPinResult>;
  getPin(host: string, userId: string): Promise<IdentityPinLookup>;
}
