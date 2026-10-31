import { vi } from "vitest";
import { loggerMock as sharedLoggerMock } from "./loggerMock";

export const prefs = new Map<string, unknown>();

export const logs = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

export function prefsPreferencesMock() {
  return {
    loadPref: (key: string, fallback: unknown) => (prefs.has(key) ? prefs.get(key) : fallback),
    savePref: (key: string, value: unknown) => prefs.set(key, value),
  };
}

export function loggerMock() {
  return sharedLoggerMock({ createLogger: () => logs });
}
