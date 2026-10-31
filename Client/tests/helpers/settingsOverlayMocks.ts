import { vi } from "vitest";

export const mockAppVersion = vi.fn();

// Mock stores
export const mockSetTheme = vi.fn();

export const mockUiState = {
  settingsOpen: false,
  settingsTab: null as "Safety" | "Notifications" | "Keybinds" | null,
  settingsTabSeq: 0,
};

export const uiSubscriptions = {
  all: [] as Array<{ sel: (s: Record<string, unknown>) => unknown; listener: () => void }>,
};

// Held in a mutable object (rather than baked into the factory literal) so
// individual tests can simulate the store having a display_name set — e.g.
// to reproduce the header/username desync in OC-0188.
export const mockAuthState = {
  user: {
    id: 1,
    username: "testuser",
    totp_enabled: false,
    display_name: null as string | null,
  },
};

export function newAppVersionMock() {
  return {
    readAppVersion: mockAppVersion,
  };
}

// Mock logger
export function loggerMock() {
  return {
    createLogger: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
    getLogBuffer: () => [],
    clearLogBuffer: vi.fn(),
    addLogListener: () => () => {},
    setLogLevel: vi.fn(),
  };
}

export function uiStoreMock() {
  return {
    uiStore: {
      getState: () => mockUiState,
      subscribe: () => () => {},
      subscribeSelector: vi.fn(
        (sel: (s: Record<string, unknown>) => unknown, listener: () => void) => {
          uiSubscriptions.all.push({ sel, listener });
          return () => {};
        },
      ),
    },
    setTheme: (...args: unknown[]) => mockSetTheme(...args),
  };
}

export function voiceLivekitSessionMock() {
  return {
    switchInputDevice: vi.fn().mockResolvedValue(undefined),
    switchOutputDevice: vi.fn().mockResolvedValue(undefined),
    setVoiceSensitivity: vi.fn(),
    setInputVolume: vi.fn(),
    setOutputVolume: vi.fn(),
    reapplyAudioProcessing: vi.fn().mockResolvedValue(undefined),
    getSessionDebugInfo: vi.fn().mockReturnValue({}),
  };
}

export function authStoreMock() {
  return {
    authStore: {
      getState: () => mockAuthState,
      subscribeSelector: vi.fn(() => () => {}),
    },
    updateUser: vi.fn(),
  };
}
