// Log persistence — writes client logs to rotating JSONL files on disk.
//
// Uses Tauri's FS plugin to write to the app log directory.
// Files: {appLogDir}/client-logs/YYYY-MM-DD.jsonl
// Rotation: keeps the most recent MAX_LOG_FILES days of logs.

import { appLogDir, join } from "@tauri-apps/api/path";
import {
  mkdir,
  writeTextFile,
  readDir,
  remove,
  exists,
  readTextFile,
} from "@tauri-apps/plugin-fs";
import { type LogEntry, addLogListener, createLogger } from "./logger";

const log = createLogger("logPersistence");
const MAX_LOG_FILES = 5;
const LOG_SUBDIR = "client-logs";

let logDir: string | null = null;
let currentDate: string | null = null;
let buffer: string[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let initialized = false;

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

  try {
    const filePath = logFilePath(logDir, currentDate!);
    await writeTextFile(filePath, lines, { append: true });
  } catch (err) {
    // Log persistence failure shouldn't crash the app.
    log.error("flush failed", err);
  }
}

/** Schedule a flush after a short debounce. */
function scheduleFlush(): void {
  if (flushTimer !== null) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushBuffer();
  }, 2000);
}

/** Remove log files older than MAX_LOG_FILES days. */
async function rotateOldFiles(): Promise<void> {
  if (!logDir) return;
  try {
    const entries = await readDir(logDir);
    const jsonlFiles = entries
      .filter(
        (e) =>
          e.name?.endsWith(".jsonl") && !e.isDirectory,
      )
      .map((e) => e.name!)
      .sort();

    if (jsonlFiles.length > MAX_LOG_FILES) {
      const toRemove = jsonlFiles.slice(
        0,
        jsonlFiles.length - MAX_LOG_FILES,
      );
      for (const file of toRemove) {
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
  buffer.push(JSON.stringify(entry));
  scheduleFlush();
}

/**
 * Initialize log persistence. Call once at app startup.
 * Sets up a listener on the logger that writes entries to disk.
 * Returns a cleanup function to remove the listener.
 */
export async function initLogPersistence(): Promise<() => void> {
  if (initialized) return () => {};

  try {
    const baseDir = await appLogDir();
    logDir = await join(baseDir, LOG_SUBDIR);

    const dirExists = await exists(logDir);
    if (!dirExists) {
      await mkdir(logDir, { recursive: true });
    }

    currentDate = today();
    initialized = true;

    const removeListener = addLogListener(onLogEntry);

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
 * since Tauri IPC is async and the WebView may be destroyed first.
 */
export async function flushLogs(): Promise<void> {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  await flushBuffer();
}

/**
 * Get the log directory path (for use in debug bundle export).
 * Returns null if persistence hasn't been initialized.
 */
export function getLogDir(): string | null {
  return logDir;
}

/**
 * Read all persisted log files and return their combined content.
 * Intended for on-demand export only (reads all files into memory).
 */
export async function readAllPersistedLogs(): Promise<string> {
  if (!logDir) return "";
  try {
    const entries = await readDir(logDir);
    const jsonlFiles = entries
      .filter(
        (e) =>
          e.name?.endsWith(".jsonl") && !e.isDirectory,
      )
      .map((e) => e.name!)
      .sort();

    const parts: string[] = [];
    for (const file of jsonlFiles) {
      const content = await readTextFile(`${logDir}/${file}`);
      parts.push(content);
    }
    return parts.join("");
  } catch (err) {
    log.warn("readAllPersistedLogs failed", err);
    return "";
  }
}
