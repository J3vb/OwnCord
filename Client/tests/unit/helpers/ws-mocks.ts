import { vi } from "vitest";

/**
 * Shared Tauri mocks for the ws client test files (ws-*.test.ts).
 *
 * vi.mock() is hoisted per test file, so each split file must call
 * vi.mock("@tauri-apps/api/core") / vi.mock("@tauri-apps/api/event") itself
 * with sync factories that resolve to the handles exported from this module:
 *
 *   import * as wsMocks from "./helpers/ws-mocks";
 *   vi.mock("@tauri-apps/api/core", () => wsMocks.tauriCoreMock());
 *   vi.mock("@tauri-apps/api/event", () => wsMocks.tauriEventMock());
 */

/** Registry of handlers registered through the mocked Tauri listen(). */
export const eventHandlers = new Map<string, Array<(e: { payload: unknown }) => void>>();

export const mockInvoke = vi.fn();

export const mockListen = vi.fn(
  async (event: string, handler: (e: { payload: unknown }) => void) => {
    if (!eventHandlers.has(event)) eventHandlers.set(event, []);
    eventHandlers.get(event)!.push(handler);
    return () => {
      const arr = eventHandlers.get(event);
      if (arr) {
        const idx = arr.indexOf(handler);
        if (idx >= 0) arr.splice(idx, 1);
      }
    };
  },
);

// Mock crypto.randomUUID
vi.stubGlobal("crypto", {
  randomUUID: () => "test-uuid-1234",
});

// Suppress console output
vi.spyOn(console, "debug").mockImplementation(() => {});
vi.spyOn(console, "info").mockImplementation(() => {});

export function tauriCoreMock(): { invoke: typeof mockInvoke } {
  return { invoke: mockInvoke };
}

export function tauriEventMock(): { listen: typeof mockListen } {
  return { listen: mockListen };
}

/** Simulate Tauri emitting an event to JS */
export function emitTauriEvent(event: string, payload: unknown): void {
  const handlers = eventHandlers.get(event);
  if (handlers) {
    for (const h of handlers) {
      h({ payload });
    }
  }
}
