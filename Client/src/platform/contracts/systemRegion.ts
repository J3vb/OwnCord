/**
 * The OS regional format, for date order and the default clock. The webview
 * only knows the display language, which on Windows is not the region the
 * user picked for dates. `null` where the host cannot say (the browser,
 * Android, macOS), and dates keep following the display language.
 */
export interface SystemRegion {
  /** The region as a BCP 47 tag ("nl-BE"), or null when unknown. */
  localeTag(): Promise<string | null>;
}
