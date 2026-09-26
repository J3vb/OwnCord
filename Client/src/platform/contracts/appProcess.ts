/**
 * The app process. Added in B7-5 for the one public relaunch, the settings
 * tab's "Clear & Restart" (`settings/AdvancedTab.ts`), which has nothing to
 * do with updating: the updater's own relaunch is internal to
 * `AppUpdater.downloadAndInstallUpdate` and needs no method here. Its own
 * contract rather than an `AppUpdater` member, so a platform with a real
 * relaunch (a browser's `location.reload()`) and no updater does not have to
 * stub an updater to offer one.
 */
export interface AppProcess {
  relaunch(): Promise<void>;
}
