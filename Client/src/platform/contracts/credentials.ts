/**
 * Credential storage — the OS credential manager seam `lib/credentials.ts`
 * wraps today. Seam: `saveCredential`, `loadCredential`, `deleteCredential`
 * and `loginWithSavedPassword` are exported functions already, so each
 * contract method below has that function's exact signature.
 *
 * The "not running natively" outcome is kept exactly as callers see it
 * today — `false` / `null`, never a thrown error — so a legacy binding of
 * today's functions type-checks against this contract with no cast.
 */

/** Re-declared, structurally identical to `SavedCredential` (`lib/credentials.ts`). */
export interface SavedCredential {
  readonly username: string;
  readonly token: string;
  readonly hasPassword: boolean;
}

/** Re-declared, structurally identical to `SavedLoginResponse` (`lib/credentials.ts`). */
export interface SavedLoginResponse {
  readonly status: number;
  readonly body: string;
}

export interface CredentialStore {
  /**
   * `sessionOnly` asks a store that can tell the difference to keep
   * the credential for this browsing session only, not across restarts;
   * omitted, it keeps the credential where it already is. The desktop store
   * has one kind of storage and ignores it; no caller passes it yet.
   */
  save(
    host: string,
    username: string,
    token: string,
    password?: string,
    clearPassword?: boolean,
    sessionOnly?: boolean,
  ): Promise<boolean>;
  load(host: string): Promise<SavedCredential | null>;
  /**
   * `token` names the token the caller is signing out or was refused.
   * A store that can hold several copies (the browser's two Web Storage areas,
   * shared with other tabs) removes only a copy holding that token, so a
   * different token another tab saved survives. Omitted, every copy goes. The
   * desktop store holds one credential per host and ignores it.
   */
  delete(host: string, token?: string): Promise<boolean>;
  loginWithSavedPassword(host: string, username: string): Promise<SavedLoginResponse | null>;
}
