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
  save(
    host: string,
    username: string,
    token: string,
    password?: string,
    clearPassword?: boolean,
  ): Promise<boolean>;
  load(host: string): Promise<SavedCredential | null>;
  delete(host: string): Promise<boolean>;
  loginWithSavedPassword(host: string, username: string): Promise<SavedLoginResponse | null>;
}
