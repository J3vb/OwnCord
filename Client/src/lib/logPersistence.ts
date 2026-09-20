// Log persistence — the app-side names for the on-disk log writer. The
// persistence session itself lives in `platform/desktop/logFiles.ts` (B7-4);
// these exports stay where their callers already import them.

import { desktop } from "../platform/desktop";

/** Cancel a pending flush timer and await one already in flight. */
export async function clearPendingPersistedLogs(): Promise<void> {
  return desktop.logFiles!.clearPending();
}

/**
 * Initialize log persistence. Call once at app startup.
 * Returns a cleanup function to remove the logger listener.
 */
export async function initLogPersistence(): Promise<() => void> {
  return desktop.logFiles!.init();
}

/**
 * Force an immediate flush of any buffered log entries.
 * Best-effort — may not complete if called during window teardown.
 */
export async function flushLogs(): Promise<void> {
  return desktop.logFiles!.flush();
}

/**
 * Get the log directory path. Production-unused but exported as the test
 * suite's observability point for persistence state.
 * @public
 */
export function getLogDir(): string | null {
  return desktop.logFiles!.getDir();
}
