/**
 * No-seam: the one call site (`settings/LogsTab.ts:135-137`) reads the
 * version inline inside a DOM builder — there is no exported function to
 * bind a legacy suite against yet. The suite lands with the seam in B7-5.
 */
export interface AppMetadata {
  getVersion(): Promise<string>;
}
