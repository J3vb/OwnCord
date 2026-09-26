/**
 * On-disk log persistence. Seam for the `logPersistence` exports
 * (`init`/`flush`/`clearPending`/`getDir` mirror `initLogPersistence`,
 * `flushLogs`, `clearPendingPersistedLogs` and `getLogDir` in
 * `lib/logPersistence.ts` exactly). `clearAll` is the no-seam half: today it
 * is the private `clearLogFiles` inside `settings/AdvancedTab.ts`, so it gets
 * a contract method now and its suite lands with the seam in B7-4.
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
   *  bundle's log half (B7-15c). Empty when no log directory exists yet. */
  readAll(): Promise<readonly { readonly name: string; readonly text: string }[]>;
}
