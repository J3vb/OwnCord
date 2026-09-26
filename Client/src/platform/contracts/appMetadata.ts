/**
 * The app's own metadata. The one call site (`settings/LogsTab.ts`) read the
 * version inline inside a DOM builder; B7-5 lifted it in place, pinned it with
 * `appMetadata.suite.ts`, then moved it to `platform/desktop/appMetadata.ts`.
 */
export interface AppMetadata {
  getVersion(): Promise<string>;
}
