import { vi } from "vitest";

// vi.hoisted ensures testPrefs is available when vi.mock factory runs
export const { testPrefs } = {
  testPrefs: new Map<string, unknown>(),
};

// Track whether the tauri notification mock should throw
export const { shouldTauriNotifThrow } = {
  shouldTauriNotifThrow: { value: false },
};

// The shared notification mock. The native path now shows a *message*
// notification through the host's `notify_message` command (so a click can
// open the message), and the plugin's `sendNotification` is only reached when
// that command is unavailable — so the mocked invoker forwards to it, and the
// existing title/body assertions keep observing the same call.
export const { sendNotificationMock } = { sendNotificationMock: vi.fn() };

// Mock AudioContext for notification sound tests
export const mockOscillator = {
  connect: vi.fn(),
  frequency: {
    setValueAtTime: vi.fn(),
  },
  start: vi.fn(),
  stop: vi.fn(),
};

export const mockGain = {
  connect: vi.fn(),
  gain: {
    setValueAtTime: vi.fn(),
    exponentialRampToValueAtTime: vi.fn(),
  },
};

export class MockAudioContext {
  readonly currentTime = 0;
  readonly destination = {};
  createOscillator() {
    return mockOscillator;
  }
  createGain() {
    return mockGain;
  }
  close() {
    return Promise.resolve();
  }
}

// Set up AudioContext mock globally
(globalThis as Record<string, unknown>).AudioContext = MockAudioContext;

// Mock the preference store shared by the settings panel and lib modules
export async function prefsPreferencesMock(importOriginal: <T>() => Promise<T>) {
  return {
    ...(await importOriginal<typeof import("../../src/lib/prefs/preferences")>()),
    STORAGE_PREFIX: "owncord:settings:",
    loadPref: (key: string, fallback: unknown) => testPrefs.get(key) ?? fallback,
    savePref: (key: string, value: unknown) => testPrefs.set(key, value),
  };
}

// Mock livekitSession (imported transitively by auth.store)
export function voiceLivekitSessionMock() {
  return {
    leaveVoice: vi.fn(),
    switchInputDevice: vi.fn(),
    switchOutputDevice: vi.fn(),
    setVoiceSensitivity: vi.fn(),
    setInputVolume: vi.fn(),
    setOutputVolume: vi.fn(),
    getSessionDebugInfo: vi.fn().mockReturnValue({}),
  };
}

// Mock Tauri notification plugin (not available in test env)
export function pluginNotificationMock() {
  return {
    isPermissionGranted: vi.fn(() => {
      if (shouldTauriNotifThrow.value) throw new Error("Tauri not available");
      return Promise.resolve(true);
    }),
    requestPermission: vi.fn().mockResolvedValue("granted"),
    sendNotification: sendNotificationMock,
  };
}

// Mock the Tauri core invoker: `notify_message` records the same title/body a
// `sendNotification` call used to.
export function apiCoreMock() {
  return {
    invoke: vi.fn((cmd: string, args: { title: string; body: string }) => {
      if (cmd === "notify_message") sendNotificationMock({ title: args.title, body: args.body });
      return Promise.resolve();
    }),
  };
}

// Mock the Tauri event API: no native host in the test env, so a subscription
// simply never delivers.
export function apiEventMock() {
  return {
    listen: vi.fn().mockResolvedValue(() => {}),
  };
}

// Mock Tauri window API
export function apiWindowMock() {
  return {
    getCurrentWindow: vi.fn().mockReturnValue({
      requestUserAttention: vi.fn().mockResolvedValue(undefined),
    }),
  };
}
