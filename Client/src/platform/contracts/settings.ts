/**
 * Settings persistence — the native surface the exported settings-backend
 * factory in `lib/profiles.ts` wraps today (`get_settings` / `save_settings`).
 * Seam: that factory is exported and already returns exactly this shape, so
 * the contract methods below have that function's exact signature — this is
 * `PersistenceBackend`'s shape, member for member (rule 4). B7-4 deletes the
 * `@lib` copy and imports this contract.
 *
 * `SettingsSnapshot`/`SettingsProfile` are re-declared, structurally
 * identical to `StoredData`/`ServerProfile` (`lib/profiles.ts`), so a legacy
 * binding of that factory type-checks against this contract with no cast.
 */

/** Re-declared, structurally identical to `ServerProfile` (`lib/profiles.ts`). */
export interface SettingsProfile {
  readonly id: string;
  readonly name: string;
  readonly host: string;
  readonly username: string;
  readonly autoConnect: boolean;
  readonly rememberPassword: boolean;
  readonly color: string;
  readonly lastConnected: string | null;
}

/** Re-declared, structurally identical to `StoredData` (`lib/profiles.ts`). */
export interface SettingsSnapshot {
  readonly schemaVersion: number;
  readonly profiles: readonly SettingsProfile[];
}

export interface SettingsStore {
  load(): Promise<SettingsSnapshot | null>;
  save(data: SettingsSnapshot): Promise<void>;
}
