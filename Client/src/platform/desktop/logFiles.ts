// Log persistence — writes client logs to rotating JSONL files on disk.
//
// Uses the native FS surface to write to the app log directory.
// Files: {appLogDir}/client-logs/YYYY-MM-DD.jsonl
// Rotation: keeps the most recent MAX_LOG_FILES days of logs.
//
// Lifted from `lib/logPersistence.ts` (B7-4), verbatim save for the addition
// of `clearAll`, which was the private `clearLogFiles` in
// `settings/AdvancedTab.ts`. The module-level state is the persistence
// session: this module owns it, and `lib/logPersistence.ts` only re-exports
// the four names its callers already use.
import { appLogDir, join } from "@tauri-apps/api/path";
import { mkdir, writeTextFile, readDir, readTextFile, remove, exists } from "@tauri-apps/plugin-fs";
import { type LogEntry, addLogListener, createLogger, getLogBuffer } from "@lib/logger";
import type { LogFiles } from "../contracts/logFiles";

const log = createLogger("logPersistence");
const MAX_LOG_FILES = 5;
const LOG_SUBDIR = "client-logs";

let logDir: string | null = null;
let currentDate: string | null = null;
let buffer: string[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let initialized = false;
let activeFlush: Promise<void> | null = null;

export async function clearPendingPersistedLogs(): Promise<void> {
  buffer = [];
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (activeFlush !== null) {
    await activeFlush;
  }
}

/** Get today's date as YYYY-MM-DD. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Resolve the full path for a given date's log file. */
function logFilePath(dir: string, date: string): string {
  return `${dir}/${date}.jsonl`;
}

/** Flush buffered log lines to disk. */
async function flushBuffer(): Promise<void> {
  if (buffer.length === 0 || !logDir) return;

  const date = today();
  if (date !== currentDate) {
    currentDate = date;
    await rotateOldFiles();
  }

  const lines = buffer.join("\n") + "\n";
  buffer = [];

  const flushPromise = (async () => {
    try {
      const filePath = logFilePath(logDir, date);
      await writeTextFile(filePath, lines, { append: true });
    } catch (err) {
      // Log persistence failure shouldn't crash the app.
      log.error("flush failed", err);
    }
  })();

  activeFlush = flushPromise;
  try {
    await flushPromise;
  } finally {
    if (activeFlush === flushPromise) {
      activeFlush = null;
    }
  }
}

/** Schedule a flush after a short debounce. */
function scheduleFlush(): void {
  if (flushTimer !== null) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushBuffer();
  }, 2000);
}

/** Remove log files older than MAX_LOG_FILES days. */
async function rotateOldFiles(): Promise<void> {
  if (!logDir) return;
  try {
    const entries = await readDir(logDir);
    const jsonlFiles = entries
      .filter((e) => e.name?.endsWith(".jsonl") && !e.isDirectory)
      .map((e) => e.name)
      .toSorted((a, b) => a.localeCompare(b));

    if (jsonlFiles.length > MAX_LOG_FILES) {
      const toRemove = jsonlFiles.slice(0, jsonlFiles.length - MAX_LOG_FILES);
      for (const file of toRemove) {
        // oxlint-disable-next-line no-await-in-loop -- sequential file deletion to avoid overwhelming the filesystem
        await remove(`${logDir}/${file}`);
      }
    }
  } catch (err) {
    log.warn("rotation failed", err);
  }
}

/** Handle a log entry by serializing it and buffering for disk write. */
function onLogEntry(entry: LogEntry): void {
  if (!initialized) return;
  // Break the self-sustaining loop: a persistently failing flush logs
  // through this module's own logger (flush failed / rotation failed),
  // which would otherwise re-enter here and re-arm scheduleFlush every 2s
  // forever. The entry still reaches console/the in-memory ring buffer —
  // it just never gets queued for its own persistence.
  if (entry.component === "logPersistence") return;
  buffer.push(JSON.stringify(entry));
  scheduleFlush();
}

/**
 * Initialize log persistence. Call once at app startup.
 * Sets up a listener on the logger that writes entries to disk.
 * Returns a cleanup function to remove the listener.
 */
async function init(): Promise<() => void> {
  if (initialized) return () => {};

  try {
    const baseDir = await appLogDir();
    logDir = await join(baseDir, LOG_SUBDIR);

    const dirExists = await exists(logDir);
    if (!dirExists) {
      await mkdir(logDir, { recursive: true });
    }

    currentDate = today();
    // Rotate at startup too: flushBuffer only rotates when the calendar date
    // changes mid-session, so a session that starts and ends on the same day
    // (the common case for a daily-launched desktop app) would otherwise
    // never rotate at all. rotateOldFiles() swallows its own errors, so a
    // failing readDir here cannot break init.
    await rotateOldFiles();
    initialized = true;

    // Persist entries logged before this listener attached (the bootstrap
    // window) so a startup-time problem lands on disk, not just in the
    // in-memory ring. Runs synchronously right before addLogListener, so there
    // is no gap and no double-capture.
    for (const entry of getLogBuffer()) {
      buffer.push(JSON.stringify(entry));
    }

    const removeListener = addLogListener(onLogEntry);
    if (buffer.length > 0) {
      scheduleFlush();
    }

    return () => {
      removeListener(); // stop receiving new entries first
      initialized = false;
      if (flushTimer !== null) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      // Final flush — best-effort. Log a warning if it fails.
      flushBuffer().catch((err) => {
        log.warn("Final flush failed during cleanup", err);
      });
    };
  } catch (err) {
    log.error("init failed", err);
    return () => {};
  }
}

/**
 * Force an immediate flush of any buffered log entries.
 * Best-effort — may not complete if called during window teardown
 * since the native IPC is async and the WebView may be destroyed first.
 */
async function flush(): Promise<void> {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  await flushBuffer();
}

function isMissingPathError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /not found|no such file|cannot find the path|os error 2|enoent/i.test(message);
}

/** Delete every persisted log file from disk. */
async function clearAll(): Promise<void> {
  try {
    await clearPendingPersistedLogs();
    const baseDir = await appLogDir();
    const dir = await join(baseDir, LOG_SUBDIR);
    const entries = await readDir(dir);
    for (const entry of entries) {
      if (entry.name?.endsWith(".jsonl") && !entry.isDirectory) {
        // oxlint-disable-next-line no-await-in-loop -- sequential file deletion to avoid overwhelming the filesystem
        await remove(`${dir}/${entry.name}`);
      }
    }
  } catch (err) {
    if (isMissingPathError(err)) {
      return;
    }
    throw err;
  }
}

/** Every persisted log file, oldest first, read verbatim. */
async function readAll(): Promise<{ name: string; text: string }[]> {
  await flush();
  try {
    const dir = await join(await appLogDir(), LOG_SUBDIR);
    const names = (await readDir(dir))
      .filter((e) => e.name?.endsWith(".jsonl") && !e.isDirectory)
      .map((e) => e.name)
      .toSorted((a, b) => a.localeCompare(b));
    const files = [];
    for (const name of names) {
      // oxlint-disable-next-line no-await-in-loop -- at most MAX_LOG_FILES reads, kept in order
      files.push({ name, text: await readTextFile(`${dir}/${name}`) });
    }
    return files;
  } catch (err) {
    if (isMissingPathError(err)) return [];
    throw err;
  }
}

export const logFiles: LogFiles = {
  init,
  flush,
  clearPending: clearPendingPersistedLogs,
  /**
   * The log directory path. Production-unused but exported as the test
   * suite's observability point for persistence state.
   */
  getDir: () => logDir,
  clearAll,
  readAll,
};
