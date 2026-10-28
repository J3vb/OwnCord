// Records the entries the app logger emits while a test runs, so a test can
// assert the component, message and structured data of a log line instead of
// scraping console output. The suite keeps the logger at "warn"; recording
// lowers it to "debug" for the test (console.debug/info output is muted) and
// puts everything back when the test ends.
import { afterEach, vi } from "vitest";
import { addLogListener, setLogLevel, type LogEntry } from "../../src/lib/logger";

export interface LogCapture {
  readonly entries: readonly LogEntry[];
  /** The entries whose message is exactly `message`. */
  find(message: string): LogEntry[];
}

const undo: Array<() => void> = [];

afterEach(() => {
  for (const restore of undo.splice(0).reverse()) restore();
});

/** Start recording; the recording stops by itself when the test ends. */
export function captureLogs(): LogCapture {
  const entries: LogEntry[] = [];
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
  setLogLevel("debug");
  const stop = addLogListener((entry) => entries.push(entry));
  undo.push(() => {
    stop();
    setLogLevel("warn");
    info.mockRestore();
    debug.mockRestore();
  });
  return {
    entries,
    find: (message) => entries.filter((entry) => entry.message === message),
  };
}
