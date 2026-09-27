/**
 * The app process. Added in B7-5 for the one public relaunch, the settings
 * tab's "Clear & Restart" (`settings/AdvancedTab.ts`), which has nothing to
 * do with updating: the updater's own relaunch is internal to
 * `AppUpdater.downloadAndInstallUpdate` and needs no method here. Its own
 * contract rather than an `AppUpdater` member, so a platform with a real
 * relaunch (a browser's `location.reload()`) and no updater does not have to
 * stub an updater to offer one.
 *
 * `reportReady` tells the native host the first page has rendered; the Rust
 * side logs a warning when it never arrives (a blank window).
 */
export interface AppProcess {
  relaunch(): Promise<void>;
  reportReady(): Promise<void>;
}
