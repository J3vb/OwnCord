/**
 * The app's own metadata. The call site (`settings/LogsTab.ts`, since moved to
 * `settings/AboutTab.ts`) read the version inline inside a DOM builder; the
 * platform seam lifted it in place, pinned it with `appMetadata.suite.ts`, then moved it to
 * `platform/desktop/appMetadata.ts`.
 */
export interface AppMetadata {
  getVersion(): Promise<string>;
}
