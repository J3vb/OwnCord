import { vi } from "vitest";
import { withOverrides } from "./voiceSessionMock";

/**
 * Shared mock state and module factories for the Push-to-Talk service suites.
 * Call the factories synchronously from `vi.mock`, through a namespace import
 * placed before the module under test.
 */

export const mockInvoke = vi.fn();
export const mockListen = vi.fn();

export const testPrefs = new Map<string, unknown>();

/** What the mocked voice store reports. */
export const pttState = {
  currentChannelId: null as number | null,
  localMuted: false,
  localDeafened: false,
  pttGated: false,
  pollingLive: false,
};

/** livekitSession.setPttGated: closes/opens the mic processor's gate and writes
 *  the store's pttGated (the real session does both; the mock mirrors the store
 *  write so later reads of pttGated see it). */
export const mockSetPttGated = vi.fn((gated: boolean) => {
  pttState.pttGated = gated;
});
export const mockSetMuted = vi.fn();
export const mockSetPttPollingLive = vi.fn((live: boolean) => {
  pttState.pollingLive = live;
});

export function tauriCoreMock() {
  return { invoke: (...args: unknown[]) => mockInvoke(...args) };
}

export function tauriEventMock() {
  return { listen: (...args: unknown[]) => mockListen(...args) };
}

export function preferencesMock() {
  return {
    loadPref: (key: string, fallback: unknown) => testPrefs.get(key) ?? fallback,
    savePref: (key: string, value: unknown) => {
      testPrefs.set(key, value);
    },
  };
}

export function voiceStoreMock() {
  return {
    voiceStore: {
      getState: () => ({
        currentChannelId: pttState.currentChannelId,
        localMuted: pttState.localMuted,
        localDeafened: pttState.localDeafened,
        pttGated: pttState.pttGated,
      }),
    },
    setPttPollingLive: (live: boolean) => mockSetPttPollingLive(live),
    isPttPollingLive: () => pttState.pollingLive,
  };
}

/** PTT only ever calls setPttGated; setMuted is mocked so tests can assert it is
 *  never touched (PTT no longer uses mute). */
export function livekitSessionMock() {
  return withOverrides({
    setPttGated: (gated: boolean) => mockSetPttGated(gated),
    setMuted: (muted: boolean) => mockSetMuted(muted),
  });
}

/** Reset all mock state between tests. */
export function resetAll(): void {
  testPrefs.clear();
  pttState.currentChannelId = null;
  pttState.localMuted = false;
  pttState.localDeafened = false;
  pttState.pttGated = false;
  pttState.pollingLive = false;
  mockSetPttGated.mockReset();
  mockSetPttGated.mockImplementation((gated: boolean) => {
    pttState.pttGated = gated;
  });
  mockSetMuted.mockReset();
  mockSetPttPollingLive.mockReset();
  mockSetPttPollingLive.mockImplementation((live: boolean) => {
    pttState.pollingLive = live;
  });
  mockInvoke.mockReset();
  mockListen.mockReset();
  // Default: key polling is supported and every other command resolves with
  // undefined; listen resolves with a no-op unlistener
  mockInvoke.mockImplementation((cmd: string) =>
    Promise.resolve(cmd === "ptt_polling_supported" ? true : undefined),
  );
  mockListen.mockResolvedValue(() => {});
}
