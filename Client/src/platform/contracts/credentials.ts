/**
 * Credential storage — the OS credential manager seam `lib/net/credentials.ts`
 * wraps today. Seam: `saveCredential`, `loadCredential`, `resumeSavedSession`,
 * `deleteCredential` and `loginWithSavedPassword` are exported functions
 * already, so each contract method below has that function's exact signature.
 *
 * The "not running natively" outcome is kept exactly as callers see it
 * today — `false` / `null`, never a thrown error — so a legacy binding of
 * today's functions type-checks against this contract with no cast.
 */

/**
 * What the connect page prefills for a host. It carries no secret: the session
 * token comes from `resume`, and a stored password never leaves the store.
 */
export interface SavedCredential {
  readonly username: string;
  readonly hasPassword: boolean;
}

/**
 * The answer to `resume` for a host with a saved sign-in: the token to sign in
 * with; `sign_in_needed` when the host's server no longer accepts it;
 * `certificate_unverified` when that server's certificate has to be confirmed
 * first; or `refused` while another server's session is active.
 */
export type SavedSessionResume =
  | { readonly outcome: "resumed"; readonly username: string; readonly token: string }
  | { readonly outcome: "sign_in_needed" }
  | { readonly outcome: "certificate_unverified" }
  | { readonly outcome: "refused" };

/** Re-declared, structurally identical to `SavedLoginResponse` (`lib/net/credentials.ts`). */
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
   * The saved session for `host`, or null when nothing is stored. The desktop
   * store hands the token over as stored for a server already signed in to
   * during this app run (or before the first sign-in of the run); for any
   * other saved server it first asks that server whether it still accepts the
   * token. Rejects when the store cannot be read or that server cannot be
   * asked.
   */
  resume(host: string): Promise<SavedSessionResume | null>;
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
