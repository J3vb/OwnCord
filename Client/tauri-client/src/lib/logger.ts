// Step 1.12 — Structured client-side logger

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  readonly timestamp: string;
  readonly level: LogLevel;
  readonly component: string;
  readonly message: string;
  readonly data?: unknown;
}

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const MAX_LOG_BUFFER = 500;
const logBuffer: LogEntry[] = [];

let currentLevel: LogLevel = "debug";
const listeners: Array<(entry: LogEntry) => void> = [];

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[currentLevel];
}

/** Convert Error objects (and nested ones) into serializable form.
 *  Error.message and Error.stack don't appear in JSON.stringify by default. */
function serializeData(data: unknown): unknown {
  if (data instanceof Error) {
    return { error: data.message, stack: data.stack };
  }
  if (typeof data === "object" && data !== null) {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      result[key] = value instanceof Error
        ? { error: value.message, stack: value.stack }
        : value;
    }
    return result;
  }
  return data;
}

function createEntry(
  level: LogLevel,
  component: string,
  message: string,
  data?: unknown,
): LogEntry {
  return {
    timestamp: new Date().toISOString(),
    level,
    component,
    message,
    data: data !== undefined ? serializeData(data) : undefined,
  };
}

function emit(entry: LogEntry): void {
  // Store in circular buffer
  logBuffer.push(entry);
  if (logBuffer.length > MAX_LOG_BUFFER) {
    logBuffer.shift();
  }

  // Console output
  const prefix = `[${entry.timestamp}] [${entry.level.toUpperCase()}] [${entry.component}]`;
  switch (entry.level) {
    case "debug":
      console.debug(prefix, entry.message, entry.data ?? "");
      break;
    case "info":
      console.info(prefix, entry.message, entry.data ?? "");
      break;
    case "warn":
      console.warn(prefix, entry.message, entry.data ?? "");
      break;
    case "error":
      console.error(prefix, entry.message, entry.data ?? "");
      break;
  }

  // Notify listeners
  for (const listener of listeners) {
    listener(entry);
  }
}

/**
 * Create a scoped logger for a specific component.
 */
export function createLogger(component: string) {
  return {
    debug(message: string, data?: unknown): void {
      if (shouldLog("debug")) emit(createEntry("debug", component, message, data));
    },
    info(message: string, data?: unknown): void {
      if (shouldLog("info")) emit(createEntry("info", component, message, data));
    },
    warn(message: string, data?: unknown): void {
      if (shouldLog("warn")) emit(createEntry("warn", component, message, data));
    },
    error(message: string, data?: unknown): void {
      if (shouldLog("error")) emit(createEntry("error", component, message, data));
    },
  };
}

/**
 * Set the minimum log level. Messages below this level are silenced.
 */
export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

/**
 * Add a listener for log entries (e.g., to write to file via Tauri).
 */
export function addLogListener(listener: (entry: LogEntry) => void): () => void {
  listeners.push(listener);
  return () => {
    const idx = listeners.indexOf(listener);
    if (idx >= 0) listeners.splice(idx, 1);
  };
}

/**
 * Get a snapshot of the in-memory log buffer (most recent MAX_LOG_BUFFER entries).
 */
export function getLogBuffer(): readonly LogEntry[] {
  return logBuffer;
}

/**
 * Clear the log buffer.
 */
export function clearLogBuffer(): void {
  logBuffer.length = 0;
}
