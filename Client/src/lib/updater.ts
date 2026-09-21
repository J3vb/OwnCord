// updater.ts — Client auto-update service.
// Uses custom Tauri commands that build the updater with a dynamic server URL
// at runtime (required because OwnCord is self-hosted).
//
// The install itself — its native commands, the app-wide install state and
// the install guard — is `platform/desktop/updater.ts` (B7-5); these exports
// stay where their callers already import them.

import { desktop } from "../platform/desktop";

export interface UpdateCheckResult {
  readonly available: boolean;
  readonly version: string | null;
  readonly body: string | null;
  /** This install cannot update itself at all — see `cannot_self_update` in
   *  `src-tauri/src/update_commands.rs`. `available: false` then says nothing
   *  about whether a newer version exists. */
  readonly manual_upgrade: boolean;
}

/** Download progress reported by the Rust updater during install. */
export interface DownloadProgress {
  readonly received: number;
  readonly total: number | null;
}

export type UpdateInstallState =
  | { readonly status: "idle" }
  | { readonly status: "downloading"; readonly progress: DownloadProgress | null }
  | { readonly status: "restarting" }
  | { readonly status: "failed"; readonly restartRequired: boolean };

/** Observe the app-wide install, including when its original page has closed. */
export function subscribeToUpdateInstall(
  listener: (state: UpdateInstallState) => void,
): () => void {
  return desktop.updater!.subscribeToInstall(listener);
}

/** Check if a newer client version is available on the connected server. */
export async function checkForUpdate(serverUrl: string): Promise<UpdateCheckResult> {
  return desktop.updater!.checkForUpdate(serverUrl);
}

/**
 * Download and install a pending update, then relaunch the app.
 * All callers join the same operation, even across page changes.
 */
export function downloadAndInstallUpdate(serverUrl: string): Promise<void> {
  return desktop.updater!.downloadAndInstallUpdate(serverUrl);
}
