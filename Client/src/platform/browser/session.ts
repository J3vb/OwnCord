// The session token this tab is signed in with, as its socket last dialled
// it. The credential store cannot answer that: `localStorage` is shared by
// every tab of the origin, so another tab's sign-in or sign-out rewrites it
// while this tab stays signed in as before. Adapters that call the server
// outside the socket (the external-content broker) read the token here.

let held: { readonly owner: object; readonly token: string } | null = null;

/** Record `token` as this tab's session, dialled by `owner`'s socket. */
export function holdSessionToken(owner: object, token: string): void {
  held = { owner, token };
}

/** Forget the session, but only the one `owner` recorded: a newer connection
 *  that took over keeps its own. */
export function releaseSessionToken(owner: object): void {
  if (held?.owner === owner) held = null;
}

/** This tab's session token, or null while it is not signed in. */
export function sessionToken(): string | null {
  return held?.token ?? null;
}
