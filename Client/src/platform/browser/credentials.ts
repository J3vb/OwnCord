// The browser platform's credential store (6.13c): the sign-in token in Web
// Storage, keyed by host. A kept token lives in `localStorage`; a
// session-only one in `sessionStorage`, which the browser drops with the tab.
// Each save leaves exactly one copy, `delete` removes both, and no password is
// ever stored, so there is no saved-password login.
//
// The contract's outcomes hold as on desktop: a failed write or delete answers
// `false`, an unreadable store rejects a load, and a page with no Web Storage
// answers as a host with no store (`false` / `null`).
import type { CredentialStore, SavedCredential } from "../contracts/credentials";

/** The prefix the Advanced tab's "clear storage" keeps (`AdvancedTab.ts`). */
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

export const credentials: CredentialStore = {
  async save(host, username, token, _password, _clearPassword, sessionOnly = false) {
    const target = area(sessionOnly ? "sessionStorage" : "localStorage");
    if (target === null) return false;
    const other = area(sessionOnly ? "localStorage" : "sessionStorage");
    try {
      // The other copy goes first, so a failed save never leaves two.
      other?.removeItem(keyFor(host));
      // The password argument is never written: only the token is kept.
      target.setItem(keyFor(host), JSON.stringify({ username, token }));
      return true;
    } catch {
      return false;
    }
  },

  async load(host) {
    const areas = [area("sessionStorage"), area("localStorage")];
    for (const found of areas) {
      if (found === null) continue;
      // A read that throws rejects: an unreadable store is not "nothing stored".
      const raw = found.getItem(keyFor(host));
      if (raw !== null) return parseCredential(raw);
    }
    return null;
  },

  async delete(host) {
    const areas = [area("localStorage"), area("sessionStorage")].filter(
      (found): found is Storage => found !== null,
    );
    if (areas.length === 0) return false;
    let removed = true;
    for (const found of areas) {
      try {
        found.removeItem(keyFor(host));
      } catch {
        removed = false;
      }
    }
    return removed;
  },

  loginWithSavedPassword: async () => null,
};
