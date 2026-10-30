import { vi } from "vitest";

// Factories for the `vi.mock` calls every dispatcher test file registers.
// `vi.mock` is hoisted per file, so each file keeps one call per module and
// hands the factory to this module through a dynamic import. Each test file
// has its own module graph, so the state below is per file.

/** Shared spy behind the mocked toast module. */
export const mockShowToast = vi.fn();

let lazyVoiceImportsInFlight = 0;
let sharedVoiceImport: Promise<typeof import("@lib/voice/livekitSession")> | undefined;

/** Lazy `livekitSession()` imports started and not yet settled. */
export function getLazyVoiceImportsInFlight(): number {
  return lazyVoiceImportsInFlight;
}

export function notificationsMock() {
  return {
    notifyIncomingMessage: vi.fn(),
    notifyMention: vi.fn(),
    notifyChannelActivity: vi.fn(),
    cleanupNotificationAudio: vi.fn(),
  };
}

export function livekitSessionMock() {
  return {
    handleVoiceToken: vi.fn(async () => {}),
    handleParticipantLeft: vi.fn(async () => {}),
    handleE2EEAnnounce: vi.fn(async () => {}),
    handleE2EEOffer: vi.fn(async () => {}),
    leaveVoice: vi.fn(),
    cleanupAll: vi.fn(),
    isVoiceSessionActive: vi.fn(() => false),
    isAutoReconnecting: vi.fn(() => false),
    failPendingRejoin: vi.fn(),
    setMuted: vi.fn(),
    setDeafened: vi.fn(),
    disableCamera: vi.fn(async () => {}),
    disableScreenshare: vi.fn(async () => {}),
    reconcileVideoFlags: vi.fn(),
    resendWatching: vi.fn(),
  };
}

// screenShare.ts's rollback correlation is exercised at the unit level in
// screen-share-tracks.test.ts; here only the dispatcher's own reaction to it
// is under test, so the lookup itself is mocked and controlled per test.
export function screenShareMock() {
  return {
    rollbackPendingVideo: vi.fn(() => undefined as "camera" | "screen" | undefined),
  };
}

export function toastMock() {
  return { showToast: (...args: unknown[]) => mockShowToast(...args) };
}

// The ready handler publishes our identity key. Mock the orchestrator so the
// wiring is asserted without real keygen/keyring.
export function identityMock() {
  return { ensureIdentityKeyPublished: vi.fn(async () => true) };
}

// The handlers load the voice module lazily and fire-and-forget
// (`void livekitSession().then(...)`). A dynamic import resolves through the
// module runner's RPC, so one started by a test's last dispatch can still be in
// flight when the file's environment is torn down — by then the `vi.mock`
// registry is gone and the REAL livekitSession graph loads and throws
// (CI "Client Unit Tests": `Errors 4 errors`, all tests passing).
//
// Vitest (4.1.11) also bypasses a factory mock for every dynamic import of the
// same module that starts while another is still pending, and loads the real
// graph instead. Several tests make two `livekitSession()` calls in one tick
// (a restart drop plus a kick, for one), so the wrapper shares a single
// `import()` for the whole file: every caller gets the mock, and an import
// that has not settled is counted so the afterEach can assert none are.
export function dispatchContextMock<T extends object>(actual: T): T {
  return {
    ...actual,
    livekitSession: () => {
      lazyVoiceImportsInFlight++;
      sharedVoiceImport ??= import("@lib/voice/livekitSession");
      const loading = sharedVoiceImport;
      void loading.then(
        () => {
          lazyVoiceImportsInFlight--;
        },
        () => {
          lazyVoiceImportsInFlight--;
        },
      );
      return loading;
    },
  };
}
