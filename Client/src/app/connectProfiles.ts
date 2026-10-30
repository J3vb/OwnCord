// The connect page's saved-server helpers: the profile list it shows, the
// persisted-save with its failure notice, the auto-login mutation that drops an
// orphaned token, and the auto-save of a profile after a login. Moved out of
// main.ts verbatim; the only edits are that `profileManager` and the connect
// page's owner arrive through createConnectProfiles(). Nothing here runs at
// import time.

import { deleteCredential } from "@lib/net/credentials";
import { createLogger } from "@lib/logger";
import type { ProfileManager } from "@lib/presence/profiles";
import type { SessionScope } from "@lib/net/sessionScope";
import { setTransientError } from "@stores/ui.store";
import { connectText } from "../i18n/connect";

const log = createLogger("main");

type ProfileList = readonly {
  name: string;
  host: string;
  id?: string;
  username?: string;
  synthetic?: boolean;
}[];

/**
 * Returns [getProfileList, persistProfiles, mutateAutoLogin, ensureProfileExists]
 * as a tuple, not an object: object keys survive minification, and this runs
 * in the startup chunk.
 */
export function createConnectProfiles(
  profileManager: ProfileManager,
  pageOwner: SessionScope,
): readonly [
  () => ProfileList,
  () => void,
  (mutate: () => void, skipHost?: string) => void,
  (host: string, username: string, rememberPassword: boolean, autoConnect: boolean) => void,
] {
  // Helper to get the profile list for the ConnectPage
  function getProfileList(): ProfileList {
    const saved = profileManager.getAll();
    if (saved.length > 0) return saved;
    // Fallback: show a default local server entry
    return [{ name: connectText("profiles.defaultName"), host: "localhost:8443", synthetic: true }];
  }

  // Persist a profile mutation, surfacing a failure instead of letting it
  // silently revert on next launch: profiles.ts awaits invoke("save_settings"),
  // which rejects when the store write fails (read-only file, disk full),
  // and `void`-ing that rejection at each call site (as this used to) left
  // the in-memory store as the only record of the change.
  function persistProfiles(): void {
    void profileManager.saveProfiles().catch(() => {
      setTransientError(connectText("profiles.saveFailed"));
    });
  }

  // Stay signed in is the only reason an auto-connect-only profile holds a
  // token. When a change moves auto-connect off such a profile and nothing
  // else on that host keeps a sign-in (neither flag on any profile there),
  // the token would sit in the credential store with both flags off, so it
  // goes. `skipHost` is the host of a login in flight, whose own save/delete
  // already decides its credential.
  function mutateAutoLogin(mutate: () => void, skipHost?: string): void {
    const heldBefore = new Set(
      profileManager
        .getAll()
        .filter((p) => p.autoConnect)
        .map((p) => p.host),
    );
    mutate();
    const after = profileManager.getAll();
    for (const host of heldBefore) {
      if (host === skipHost) continue;
      if (after.some((p) => p.host === host && (p.autoConnect || p.rememberPassword))) continue;
      void (async () => {
        const removed = await deleteCredential(host);
        if (!removed && pageOwner.isCurrent()) {
          log.warn("Credential delete failed — the saved sign-in is still stored", { host });
          setTransientError(connectText("session.passwordRemoveFailed"));
        }
      })();
    }
  }

  // Auto-save a profile for a host after successful login (if not already saved)
  function ensureProfileExists(
    host: string,
    username: string,
    rememberPassword: boolean,
    autoConnect: boolean,
  ): void {
    const existing = profileManager.getAll().find((p) => p.host === host);
    if (existing) {
      // Update username, rememberPassword preference, and lastConnected
      profileManager.updateProfile(existing.id, { username, rememberPassword });
      profileManager.setLastConnected(existing.id);
    } else {
      const created = profileManager.addProfile({
        name: host.split(":")[0] ?? host,
        host,
        username,
        autoConnect: false,
        rememberPassword,
        color: "#5865F2",
      });
      profileManager.setLastConnected(created.id);
    }

    // Re-find: the profile may have just been created above.
    const profile = profileManager.getAll().find((p) => p.host === host);
    if (profile) {
      if (autoConnect) {
        mutateAutoLogin(() => profileManager.setAutoLogin(profile.id), host);
      } else if (profile.autoConnect) {
        // Only clear when this profile is the current holder — setAutoLogin(null)
        // clears auto-login on every profile, not just this one.
        mutateAutoLogin(() => profileManager.setAutoLogin(null), host);
      }
    }
    persistProfiles();
  }
  return [getProfileList, persistProfiles, mutateAutoLogin, ensureProfileExists];
}
