/**
 * The one code path for leaving the current server: the quick-switch overlay
 * and the server rail both call these.
 */

import { clearAuth } from "@stores/auth.store";
import { createProfileManager, createTauriBackend, type ServerProfile } from "@lib/profiles";
import { createLogger } from "@lib/logger";

const log = createLogger("server-switch");

export const QUICK_SWITCH_TARGET_KEY = "owncord:quick-switch-target";

/**
 * Switch to the saved server at `host`. Stores the target for the connect flow
 * to resume, then tears the session down (clears auth -> ws disconnect ->
 * navigate to connect) while keeping this server's saved sign-in (B7-13).
 */
export function switchToServer(host: string): void {
  try {
    sessionStorage.setItem(QUICK_SWITCH_TARGET_KEY, host);
  } catch (err) {
    log.warn("Could not store the switch target", err);
  }
  clearAuth("server_switch");
}

/** Open the connect page to add a server, keeping this server's saved sign-in. */
export function addServer(): void {
  clearAuth("server_switch");
}

/** The saved server profiles; an unreadable store gives none. */
export async function loadSavedServers(): Promise<readonly ServerProfile[]> {
  try {
    const manager = createProfileManager(createTauriBackend());
    await manager.loadProfiles();
    return manager.getAll();
  } catch (err) {
    log.warn("Failed to load saved servers", err);
    return [];
  }
}
