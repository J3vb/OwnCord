import { vi } from "vitest";

export const mockVoiceState = {
  localMuted: false,
  localDeafened: false,
  localServerMuted: false,
  localServerDeafened: false,
  localCamera: false,
  localScreenshare: false,
  pttGated: false,
  // The AFK channel is listen-only: no microphone is published there.
  inAfkChannel: false,
  // OC-0009: the real store's currentChannelId is set by joinVoiceChannel()
  // before the voice_join/voice_token round trip that produces the token a
  // test then hands to handleVoiceToken — default it to the channel id used
  // by the overwhelming majority of existing calls (1) so those tests don't
  // each need to restate it; tests that exercise a different channel (or the
  // "already left" guard itself) set this explicitly.
  currentChannelId: 1 as number | null,
  // OC-0438: per-channel voice_config (quality bitrate etc.) as delivered by
  // the server's voice_config event. Empty by default; tests exercising the
  // audio-bitrate publish path populate an entry for the channel under test.
  voiceConfigs: new Map<number, { bitrate: number }>(),
  voiceStatus: "idle",
  // The roster the reconnect loop reads to tell whether the server still
  // holds our membership. Reset per test to one that lists everyone
  // everywhere; tests of a released membership replace it.
  voiceUsers: new Map() as { get(channelId: number): { has(userId: number): boolean } | undefined },
};

/** Listeners livekitSession registers with the mocked voice.store at import. */
export const pttPollingListeners = ((): Array<() => void> => [])();

/** Backing cell for the mocked voice.store PTT-poller-live flag. Boxed so the
 *  hoisted mock factory can mutate it after hoisting. */
const mockPttPollingLive = { value: false };

export const mockRoom = {
  connect: vi.fn().mockResolvedValue(undefined),
  disconnect: vi.fn().mockResolvedValue(undefined),
  on: vi.fn().mockReturnThis(),
  off: vi.fn(),
  setE2EEEnabled: vi.fn().mockResolvedValue(undefined),
  localParticipant: {
    setMicrophoneEnabled: vi.fn().mockResolvedValue(undefined),
    setCameraEnabled: vi.fn().mockResolvedValue(undefined),
    getTrackPublication: vi.fn().mockReturnValue(undefined),
    unpublishTrack: vi.fn().mockResolvedValue(undefined),
    publishTrack: vi.fn().mockResolvedValue(undefined),
    createTracks: vi.fn().mockResolvedValue([]),
    trackPublications: new Map(),
    identity: "user-1",
  },
  remoteParticipants: new Map(),
  switchActiveDevice: vi.fn().mockResolvedValue(undefined),
  startAudio: vi.fn().mockResolvedValue(undefined),
  canPlaybackAudio: true,
  state: "connected" as string,
  name: "test-room",
};

export const mockInvoke = vi.fn((cmd: string, _payload?: unknown) => {
  if (cmd === "start_livekit_proxy") return Promise.resolve({ port: 7881, token: "tun" });
  if (cmd === "stop_livekit_proxy") return Promise.resolve();
  return Promise.resolve();
});

export const { mockLoadPref, mockSavePref } = {
  mockLoadPref: vi.fn((_key: string, defaultVal: unknown) => defaultVal),
  mockSavePref: vi.fn(),
};

export const mockShowActionToast = vi.fn();

export const mockKeyPair = {
  publicKey: { type: "public" } as unknown as CryptoKey,
  privateKey: { type: "private" } as unknown as CryptoKey,
};

export const mockIdentityKeyPair = {
  publicKey: { type: "id-public" } as unknown as CryptoKey,
  privateKey: { type: "id-private" } as unknown as CryptoKey,
};

// Stub Worker for E2EE web worker (not available in Node/vitest). Instances
// carry a terminate() mock so worker-lifecycle assertions can observe teardown.
globalThis.Worker = vi.fn(function (this: { terminate: () => void }) {
  this.terminate = vi.fn();
}) as unknown as typeof Worker;

export function livekitClientMock() {
  return {
    // installLivekitLogging runs when livekitSession loads.
    LogLevel: { warn: 3, error: 4 },
    setLogLevel: vi.fn(),
    setLogExtension: vi.fn(),
    AudioPresets: { musicHighQualityStereo: { maxBitrate: 128_000 } },
    // vitest 4 mocks honor construct semantics — `new` needs a real function, not an arrow.
    Room: vi.fn(function () {
      return mockRoom;
    }),
    RoomEvent: {
      TrackSubscribed: "trackSubscribed",
      TrackUnsubscribed: "trackUnsubscribed",
      Disconnected: "disconnected",
      Reconnecting: "reconnecting",
      SignalReconnecting: "signalReconnecting",
      Reconnected: "reconnected",
      ActiveSpeakersChanged: "activeSpeakersChanged",
      AudioPlaybackStatusChanged: "audioPlaybackStatusChanged",
      EncryptionError: "encryptionError",
      LocalTrackPublished: "localTrackPublished",
      ParticipantPermissionsChanged: "participantPermissionsChanged",
    },
    Track: {
      sourceToProto: (source: string) =>
        ({ camera: 1, microphone: 2, screenShare: 3 })[source] ?? 0,
      Source: {
        Microphone: "microphone",
        Camera: "camera",
        ScreenShare: "screenShare",
        ScreenShareAudio: "screenShareAudio",
      },
      Kind: { Audio: "audio", Video: "video" },
    },
    VideoPresets: {
      h360: { resolution: { width: 640, height: 360 } },
      h720: { resolution: { width: 1280, height: 720 } },
      h1080: { resolution: { width: 1920, height: 1080 } },
    },
    ScreenSharePresets: {
      h720fps5: { resolution: { width: 1280, height: 720 } },
      h720fps30: { resolution: { width: 1280, height: 720 } },
      h1080fps30: { resolution: { width: 1920, height: 1080 } },
    },
    VideoPreset: vi.fn(),
    DisconnectReason: { CLIENT_INITIATED: 0 },
    // vitest 4 mocks honor construct semantics — `new` needs a real function, not an arrow.
    ExternalE2EEKeyProvider: vi.fn(function () {
      return {
        setKey: vi.fn(),
        getKeys: vi.fn().mockReturnValue([]),
        removeAllListeners: vi.fn(),
      };
    }),
    createLocalVideoTrack: vi.fn(async () => ({
      kind: "video",
      mediaStreamTrack: new MediaStreamTrack(),
    })),
    createLocalScreenTracks: vi.fn(async () => [
      { kind: "video", mediaStreamTrack: new MediaStreamTrack() },
    ]),
  };
}

export function voiceStoreMock() {
  return {
    voiceStore: {
      getState: vi.fn(() => mockVoiceState),
      get: vi.fn(() => ({})),
      set: vi.fn(),
      subscribe: vi.fn(),
      subscribeSelector: vi.fn(() => () => {}),
    },
    setLocalMuted: vi.fn(),
    setLocalDeafened: vi.fn(),
    setLocalCamera: vi.fn(),
    setLocalScreenshare: vi.fn(),
    bumpLocalShareRev: vi.fn(),
    setPttGated: vi.fn(),
    // The PTT-poller-live flag lives in the store (so ptt.ts can write it at
    // startup without importing the LiveKit SDK), so the mock has to carry real
    // read/write behaviour rather than a bare vi.fn — restoreLocalVoiceState
    // reads it back through isPttPollingLive().
    setPttPollingLive: vi.fn((live: boolean) => {
      mockPttPollingLive.value = live;
    }),
    isPttPollingLive: vi.fn(() => mockPttPollingLive.value),
    onPttPollingLiveChange: vi.fn((listener: () => void) => {
      pttPollingListeners.push(listener);
      return () => {};
    }),
    setSpeakers: vi.fn(),
    leaveVoiceChannel: vi.fn(),
    setListenOnly: vi.fn(),
    setShareDenied: vi.fn(),
    setLocalGateSpeaking: vi.fn(),
    restateSelfVoiceState: vi.fn(),
    setVoiceStatus: vi.fn(),
    setPeerVerification: vi.fn(),
    clearPeerVerification: vi.fn(),
    clearPeerVerifications: vi.fn(),
    setLocalSessionFingerprint: vi.fn(),
    setLocalSafetyNumber: vi.fn(),
    setEncryptionDegraded: vi.fn(),
  };
}

export function apiCoreMock() {
  return {
    invoke: (cmd: string, payload?: unknown) => mockInvoke(cmd, payload),
  };
}

export async function prefsPreferencesMock(importOriginal: <T>() => Promise<T>) {
  return {
    ...(await importOriginal<typeof import("@lib/prefs/preferences")>()),
    loadPref: (key: string, defaultVal: unknown) => mockLoadPref(key, defaultVal),
    savePref: (key: string, val: unknown) => mockSavePref(key, val),
  };
}

export { loggerMock } from "./loggerMock";

export function uiToastMock() {
  return {
    showToast: vi.fn(),
    showActionToast: mockShowActionToast,
  };
}

export function voiceNoiseSuppressionMock() {
  return {
    createRNNoiseProcessor: vi.fn(),
  };
}

export function netE2eeCryptoMock() {
  return {
    generateECDHKeyPair: vi.fn(async () => mockKeyPair),
    exportPublicKey: vi.fn(async () => "bW9ja2VwaGVtZXJhbA=="),
    importPublicKey: vi.fn(async () => ({ type: "public" }) as unknown as CryptoKey),
    generateRoomKey: vi.fn(() => new Uint8Array(32)),
    roomKeyToBase64: vi.fn(() => "mock-room-key-base64"),
    wrapRoomKey: vi.fn(async () => ({ encryptedKey: "enc", iv: "iv" })),
    unwrapRoomKey: vi.fn(async () => ({ roomKey: new Uint8Array(32), epoch: 0 })),
    // F3 TOFU identity signing/verification
    signEphemeralKey: vi.fn(async () => "mock-signature"),
    verifyEphemeralKeySignature: vi.fn(async () => true),
    importIdentityPublicKey: vi.fn(
      async () => ({ type: "id-public-imported" }) as unknown as CryptoKey,
    ),
    computeKeyFingerprint: vi.fn(async () => "AB12 CD34 EF56 7890"),
    computeRawKeyFingerprint: vi.fn(async () => "5E55 1234 5678 9ABC"),
  };
}

// F3 TOFU: identity keyring + peer pin store (Tauri-backed; mocked here).
export function netIdentityMock() {
  return {
    getOrCreateIdentityKeyPair: vi.fn(async () => mockIdentityKeyPair),
    getIdentityPin: vi.fn(async () => ({ status: "unpinned" })),
    storeIdentityPin: vi.fn(async () => true),
  };
}
