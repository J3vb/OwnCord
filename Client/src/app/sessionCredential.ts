// The credential write that follows a session start: keep, replace or remove
// the stored sign-in according to the user's remember choices. Moved out of
// startSession (session.ts) with its order and ownership checks unchanged.

import { saveCredential, deleteCredential } from "@lib/net/credentials";
import { createLogger } from "@lib/logger";
import type { SessionScope } from "@lib/net/sessionScope";
import { setTransientError } from "@stores/ui.store";
import { connectText } from "../i18n/connect";

const log = createLogger("main");

/**
 * Persist or remove the credential for a session just started, per the user's
 * remember choices. Synchronous up to its own awaits; the ownership check sits
 * in the same step as each warning it guards.
 */
export function persistSessionCredential(
  owner: SessionScope,
  login: { host: string; username: string; token: string; password: string | undefined },
  choice: { rememberPassword: boolean; rememberIsUserChoice: boolean; autoConnect: boolean },
  keepToken: boolean,
): void {
  const { host, username, token, password } = login;
  const { rememberPassword, rememberIsUserChoice, autoConnect } = choice;
  if (!keepToken && rememberIsUserChoice) {
    void (async () => {
      // The store holds one credential per host (`login_account(host) =
      // host`), and `save_credential` already overwrites it with no
      // username check — a remembered login by a second account on this
      // host would have clobbered it anyway. The stored username is a
      // stale copy, not an account identity, so guarding the delete on it
      // can't protect a second account; it can only leave the password the
      // user just declined sitting on disk. Delete unconditionally for the
      // host. Cost: if two accounts share a host, opting out as one
      // removes the credential the other saved.
      //
      // A failed delete leaves that password on disk. Silence there would
      // tell the user the opt-out took effect when it did not, so it is
      // surfaced the same way a failed save is.
      const removed = await deleteCredential(host);
      if (!removed && owner.isCurrent()) {
        log.warn("Credential delete failed — the saved password is still stored", {
          host,
        });
        setTransientError(connectText("session.passwordRemoveFailed"));
      }
    })();
  }
  if (keepToken) {
    // Auto connect without Remember: keep the token only. A user's own login
    // also erases any password saved under an earlier Remember opt-in
    // (clearPassword); a stored-token resume never clears anything.
    const clearPassword = !rememberPassword && rememberIsUserChoice;
    // The user's own login decides where a portal token lives; a resume says
    // nothing, so the token stays in the area it was read from.
    const savedPassword = rememberPassword ? password : undefined;
    (__OWNCORD_WEB__
      ? saveCredential(
          host,
          username,
          token,
          savedPassword,
          clearPassword,
          rememberIsUserChoice ? !autoConnect : undefined,
        )
      : saveCredential(host, username, token, savedPassword, clearPassword)
    )
      .then((ok) => {
        if (!ok && owner.isCurrent()) {
          log.warn("Credential save failed — auto-login will not work for this server");
          setTransientError(connectText("session.credentialsSaveFailed"));
        }
      })
      .catch(() => {
        // saveCredential already catches internally; this is defence-in-depth
      });
  }
}
