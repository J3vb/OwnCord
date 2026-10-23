// The browser platform's credential store (6.13c): the sign-in token in Web
// Storage, keyed by host. A kept token lives in `localStorage`; a
// session-only one in `sessionStorage`, which the browser drops with the tab.
// A save that does not say which keeps the token where it already is (kept,
// when it is nowhere yet), so a refresh never moves it.
//
// Tabs share `localStorage`, so one tab must not destroy a token another tab
// saved. The rules (6.13e review):
//  - A save that names its area (an explicit sign-in) writes that area and
//    removes the other area's copy: a fresh sign-in supersedes this browser's
//    earlier one, so one copy is left.
//  - A save that does not say (a resume, a profile re-save) writes only the
//    area the token lives in and never removes the other area's copy.
//  - `delete(host)` removes both copies; `delete(host, token)` removes a copy
//    only while it still holds that token, so a sign-out or a refused token in
//    one tab leaves a different token another tab saved.
// No password is ever stored, so there is no saved-password login.
//
// The contract's outcomes hold as on desktop: a failed write or delete answers
// `false`, an unreadable store rejects a load, and a page with no Web Storage
// answers as a host with no store (`false` / `null`).
import type { CredentialStore, SavedCredential } from "../contracts/credentials";

/** The prefix the Advanced tab keeps when it clears localStorage
 *  (`clearLocalStoragePreservingUserData`, `AdvancedTab.ts`). */
const KEY_PREFIX = "owncord:credential:";

type AreaName = "localStorage" | "sessionStorage";

function keyFor(host: string): string {
  return `${KEY_PREFIX}${host}`;
}

/** The named storage area, or null when the page has none or may not use it. */
function area(name: AreaName): Storage | null {
  try {
    const found: Storage | undefined = globalThis[name];
    return found ?? null;
  } catch {
    return null;
  }
}

/** The stored record as a credential, or null when it is not one. */
function parseCredential(raw: string): SavedCredential | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  if (!("username" in parsed) || !("token" in parsed)) return null;
  const { username, token } = parsed;
  if (typeof username !== "string" || typeof token !== "string") return null;
  return { username, token, hasPassword: false };
}

/** True when this tab already holds the host's token session-only. */
function heldForSession(host: string): boolean {
  try {
    return (area("sessionStorage")?.getItem(keyFor(host)) ?? null) !== null;
  } catch {
    return false;
  }
}

export const credentials: CredentialStore = {
  async save(host, username, token, _password, _clearPassword, sessionOnlyArg) {
    const sessionOnly = sessionOnlyArg ?? heldForSession(host);
    const target = area(sessionOnly ? "sessionStorage" : "localStorage");
    if (target === null) return false;
    // A save that does not say (a resume, a profile re-save) rewrites the token
    // where it already is and never touches the other area: that copy may be a
    // different token another tab saved.
    const other =
      sessionOnlyArg === undefined ? null : area(sessionOnly ? "localStorage" : "sessionStorage");
    try {
      // The new token goes in first, so a write that throws (quota, Safari
      // private mode) leaves the old sign-in where it was. The password
      // argument is never written: only the token is kept.
      target.setItem(keyFor(host), JSON.stringify({ username, token }));
    } catch {
      return false;
    }
    try {
      other?.removeItem(keyFor(host));
    } catch {
      // The new token is saved. A leftover copy is the older token; the
      // auth_error compare-and-delete drops it once the server rejects it.
    }
    return true;
  },

  async load(host) {
    const areas = [area("sessionStorage"), area("localStorage")];
    for (const found of areas) {
      if (found === null) continue;
      // A read that throws rejects: an unreadable store is not "nothing stored".
      const raw = found.getItem(keyFor(host));
      const parsed = raw === null ? null : parseCredential(raw);
      // A record that is not a credential does not hide a good one.
      if (parsed !== null) return parsed;
    }
    return null;
  },

  async delete(host, token) {
    const areas = [area("localStorage"), area("sessionStorage")].filter(
      (found): found is Storage => found !== null,
    );
    if (areas.length === 0) return false;
    let removed = true;
    for (const found of areas) {
      try {
        if (token !== undefined) {
          // Only the caller's own token: localStorage is shared with every
          // other tab of this origin, so a different one is not ours to drop.
          const raw = found.getItem(keyFor(host));
          const stored = raw === null ? null : parseCredential(raw);
          if (stored?.token !== token) continue;
        }
        found.removeItem(keyFor(host));
      } catch {
        removed = false;
      }
    }
    return removed;
  },

  loginWithSavedPassword: async () => null,
};
