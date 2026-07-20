// updater.ts — Client auto-update service.
// Uses custom Tauri commands that build the updater with a dynamic server URL
// at runtime (required because OwnCord is self-hosted).

import { invoke } from "@tauri-apps/api/core";
import { relaunch } from "@tauri-apps/plugin-process";
import { createLogger } from "@lib/logger";

const log = createLogger("updater");

export interface UpdateCheckResult {
  readonly available: boolean;
  readonly version: string | null;
  readonly body: string | null;
}

/** Download progress reported by the Rust updater during install. */
export interface DownloadProgress {
  readonly received: number;
  readonly total: number | null;
}

/** Check if a newer client version is available on the connected server. */
export async function checkForUpdate(serverUrl: string): Promise<UpdateCheckResult> {
  try {
    const result = await invoke<UpdateCheckResult>("check_client_update", {
      serverUrl,
    });
    if (result.available) {
      log.info("Update available", { version: result.version });
    } else {
      log.debug("No update available");
    }
    return result;
  } catch (err) {
    log.error("Update check failed", { error: String(err) });
    return { available: false, version: null, body: null };
  }
}

/**
 * Download and install a pending update, then relaunch the app.
 * `onProgress`, when given, is fed the Rust updater's `update-progress` events
 * so the caller can show download progress instead of a hung spinner.
 */
export async function downloadAndInstallUpdate(
  serverUrl: string,
  onProgress?: (progress: DownloadProgress) => void,
): Promise<void> {
  log.info("Downloading and installing update...");
  let unlisten: (() => void) | undefined;
  if (onProgress !== undefined) {
    const { listen } = await import("@tauri-apps/api/event");
    unlisten = await listen<DownloadProgress>("update-progress", (event) => {
      onProgress({ received: event.payload.received, total: event.payload.total ?? null });
    });
  }
  try {
    await invoke("download_and_install_update", { serverUrl });
  } finally {
    unlisten?.();
  }
  log.info("Update installed, relaunching...");
  await relaunch();
}
