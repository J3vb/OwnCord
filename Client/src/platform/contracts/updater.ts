/**
 * Auto-update and autostart. Seam for `AppUpdater` — `checkForUpdate`,
 * `downloadAndInstallUpdate` and `subscribeToUpdateInstall` are exported
 * functions in `lib/updater.ts` already, so each contract method below has
 * that function's exact signature (progress is still delivered through a
 * subscribed listener, not a return value). `Autostart` is no-seam: today it
 * is inline dynamic-import calls inside the private `buildAutostartRow`
 * (`settings/AdvancedTab.ts`) — its suite lands with the seam in B7-5.
 */

/** Re-declared, structurally identical to `UpdateCheckResult` (`lib/updater.ts`). */
export interface UpdateCheckResult {
  readonly available: boolean;
  readonly version: string | null;
  readonly body: string | null;
  readonly manual_upgrade: boolean;
}

/** Re-declared, structurally identical to `DownloadProgress` (`lib/updater.ts`). */
export interface DownloadProgress {
  readonly received: number;
  readonly total: number | null;
}

/** Re-declared, structurally identical to `UpdateInstallState` (`lib/updater.ts`). */
export type UpdateInstallState =
  | { readonly status: "idle" }
  | { readonly status: "downloading"; readonly progress: DownloadProgress | null }
  | { readonly status: "restarting" }
  | { readonly status: "failed"; readonly restartRequired: boolean };

export interface AppUpdater {
  checkForUpdate(serverUrl: string): Promise<UpdateCheckResult>;
  downloadAndInstallUpdate(serverUrl: string): Promise<void>;
  subscribeToInstall(listener: (state: UpdateInstallState) => void): () => void;
}

export interface Autostart {
  isEnabled(): Promise<boolean>;
  enable(): Promise<void>;
  disable(): Promise<void>;
}
