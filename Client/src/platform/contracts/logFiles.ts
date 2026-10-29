/**
 * On-disk log persistence. Seam for the `logPersistence` exports
 * (`init`/`flush`/`clearPending`/`getDir` mirror `initLogPersistence`,
 * `flushLogs`, `clearPendingPersistedLogs` and `getLogDir` in
 * `lib/logPersistence.ts` exactly). `clearAll` is the no-seam half: today it
 * is the private `clearLogFiles` inside `settings/AdvancedTab.ts`, so it gets
 * a contract method now and its suite lands with the seam.
 */
export interface LogFiles {
  /** Start writing log entries to rotating on-disk files. Returns a cleanup
   *  function that stops writing and flushes what remains. */
  init(): Promise<() => void>;
  /** Force an immediate flush of any buffered entries. */
  flush(): Promise<void>;
  /** Cancel a pending flush timer and await one already in flight. */
  clearPending(): Promise<void>;
  /** The directory log files are written to, or null before `init()`. */
  getDir(): string | null;
  /** Delete every persisted log file from disk. */
  clearAll(): Promise<void>;
  /** Every persisted log file, oldest first, read verbatim — the support
   *  bundle's log half. Empty when no log directory exists yet. */
  readAll(): Promise<readonly { readonly name: string; readonly text: string }[]>;
  /**
   * The Rust log (`owncord-client.log`, plus any rotated
   * `owncord-client_<date>.log`), newest first, each tail-capped — the support
   * bundle's native-log half. Empty when the app log directory does
   * not exist yet.
   */
  readNative(): Promise<readonly { readonly name: string; readonly text: string }[]>;
  /**
   * Open the Rust log directory in the system file manager (the tray's "Open
   * log folder", for desktops with no tray). Never rejects: a native failure
   * comes back as `{ ok: false, error }` for the caller to show.
   */
  openFolder(): Promise<OpenLogFolderResult>;
}

/** Outcome of {@link LogFiles.openFolder}. */
export type OpenLogFolderResult =
  { readonly ok: true } | { readonly ok: false; readonly error: string };
