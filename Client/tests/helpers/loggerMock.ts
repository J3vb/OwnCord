import { vi, type Mock } from "vitest";

export interface LoggerMockOptions {
  /** The `error` spy every logger returned by `createLogger` shares. */
  readonly error?: Mock;
  /** Also stub the log-buffer exports of `@lib/logger` (buffer, listeners, level). */
  readonly buffer?: boolean;
  /** Replace `createLogger` itself, for a suite that inspects the loggers it hands out. */
  readonly createLogger?: (tag: string) => unknown;
}

/** The module factory body for `vi.mock("@lib/logger", ...)`: silent loggers by default. */
export function loggerMock(options: LoggerMockOptions = {}) {
  const base = {
    createLogger:
      options.createLogger ??
      (() => ({
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: options.error ?? vi.fn(),
      })),
  };
  if (!options.buffer) return base;
  return {
    ...base,
    getLogBuffer: () => [],
    clearLogBuffer: vi.fn(),
    addLogListener: () => () => {},
    setLogLevel: vi.fn(),
  };
}
