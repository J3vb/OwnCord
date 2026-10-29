/**
 * Auto-update and autostart. Seam for `AppUpdater` — `checkForUpdate`,
 * `downloadAndInstallUpdate` and `subscribeToUpdateInstall` are exported
 * functions in `lib/updater.ts` already, so each contract method below has
 * that function's exact signature (progress is still delivered through a
 * subscribed listener, not a return value). Both halves live in
 * `platform/desktop` since the platform seam (`updater.ts`, `autostart.ts`); the
 * `lib/updater.ts` names stay as their callers' imports. `Autostart` was
 * inline in the private `buildAutostartRow` (`settings/AdvancedTab.ts`), which
 * keeps the toggle's read-back race guard. The updater's relaunch after an
 * install is internal to `downloadAndInstallUpdate`; the one public relaunch
 * is `AppProcess` (`appProcess.ts`).
 */

/** Re-declared, structurally identical to `UpdateCheckResult` (`lib/updater.ts`). */
export interface UpdateCheckResult {
  readonly available: boolean;
  readonly version: string | null;
  readonly body: string | null;
  readonly manual_upgrade: boolean;
  /** With `manual_upgrade`: a .deb install that can update itself got no offer
   *  from the server, which is not proof it cannot be updated. */
  readonly unconfirmed?: boolean;
  /** The check itself could not complete (network, feed error): `available: false`
   *  then says nothing about whether a newer version exists. */
  readonly failed?: boolean;
}

/** Re-declared, structurally identical to `DownloadProgress` (`lib/updater.ts`). */
export interface DownloadProgress {
  readonly received: number;
  readonly total: number | null;
}

/** Re-declared, structurally identical to `UpdateFailureReason` (`lib/updater.ts`). */
export type UpdateFailureReason = "cancelled" | "not-authorized";

/** Re-declared, structurally identical to `UpdateInstallState` (`lib/updater.ts`). */
export type UpdateInstallState =
  | { readonly status: "idle" }
  | { readonly status: "downloading"; readonly progress: DownloadProgress | null }
  | { readonly status: "installing" }
  | { readonly status: "restarting" }
  | {
      readonly status: "failed";
      readonly restartRequired: boolean;
      /** Why a .deb install did not run, when the system password prompt was
       *  dismissed or could not authorize. Absent for every other failure. */
      readonly reason?: UpdateFailureReason;
    };

export interface AppUpdater {
  /** Whether this platform can do this at all. False on the web build, where a
   *  Settings control for it is not drawn rather than drawn to fail. */
  readonly available: boolean;
  checkForUpdate(serverUrl: string): Promise<UpdateCheckResult>;
  downloadAndInstallUpdate(serverUrl: string): Promise<void>;
  subscribeToInstall(listener: (state: UpdateInstallState) => void): () => void;
}

export interface Autostart {
  /** Whether this platform can do this at all. False on the web build, where a
   *  Settings control for it is not drawn rather than drawn to fail. */
  readonly available: boolean;
  isEnabled(): Promise<boolean>;
  enable(): Promise<void>;
  disable(): Promise<void>;
}
