/**
 * B7-13 / BPR-034: one live media session at a time, across a profile switch.
 *
 * The LiveKit session is a module singleton that holds at most one room. A
 * profile switch tears it down with `cleanupAll` (MainPage.destroy calls it),
 * and the next profile's join must start from nothing: the first room is
 * disconnected before the second is built, and the liveness predicate reads
 * false in between. The harness is livekit-session.test.ts's, except that
 * every `new Room()` is a distinct object so live rooms can be counted.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// --- Mocks must be declared before imports ---

const mockVoiceState = vi.hoisted(() => ({
  localMuted: false,
  localDeafened: false,
  localServerMuted: false,
  localServerDeafened: false,
  localCamera: false,
  localScreenshare: false,
  pttGated: false,
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
}));

/** Backing cell for the mocked voice.store PTT-poller-live flag. Boxed so the
 *  hoisted mock factory can mutate it after hoisting. */
const mockPttPollingLive = vi.hoisted(() => ({ value: false }));

// Every `new Room()` gets its own object so the test can tell rooms apart
// and count the live ones.
const rooms = vi.hoisted(() => ({
  constructed: [] as Array<{ disconnect: { mock: { calls: unknown[] } } }>,
  events: [] as string[],
}));

function makeRoom() {
  const index = rooms.constructed.length;
  const room = {
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(async () => {
      rooms.events.push(`disconnect:${index}`);
    }),
    on: vi.fn().mockReturnThis(),
    off: vi.fn(),
    setE2EEEnabled: vi.fn().mockResolvedValue(undefined),
    localParticipant: {
      setMicrophoneEnabled: vi.fn().mockResolvedValue(undefined),
      setCameraEnabled: vi.fn().mockResolvedValue(undefined),
      getTrackPublication: vi.fn().mockReturnValue(undefined),
      unpublishTrack: vi.fn().mockResolvedValue(undefined),
      publishTrack: vi.fn().mockResolvedValue(undefined),
      trackPublications: new Map(),
      identity: "user-1",
    },
    remoteParticipants: new Map(),
    switchActiveDevice: vi.fn().mockResolvedValue(undefined),
    startAudio: vi.fn().mockResolvedValue(undefined),
    canPlaybackAudio: true,
    state: "connected" as string,
    name: `room-${index}`,
  };
  rooms.events.push(`construct:${index}`);
  rooms.constructed.push(room);
  return room;
}

vi.mock("livekit-client", () => ({
  // vitest 4 mocks honor construct semantics — `new` needs a real function, not an arrow.
  Room: vi.fn(function () {
    return makeRoom();
  }),
  RoomEvent: {
    TrackSubscribed: "trackSubscribed",
    TrackUnsubscribed: "trackUnsubscribed",
    Disconnected: "disconnected",
    ActiveSpeakersChanged: "activeSpeakersChanged",
    AudioPlaybackStatusChanged: "audioPlaybackStatusChanged",
    EncryptionError: "encryptionError",
    LocalTrackPublished: "localTrackPublished",
    ParticipantPermissionsChanged: "participantPermissionsChanged",
  },
  Track: {
    sourceToProto: (source: string) => (source === "microphone" ? 2 : 0),
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
    h1080fps15: { resolution: { width: 1920, height: 1080 } },
    h1080fps30: { resolution: { width: 1920, height: 1080 } },
  },
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
}));

vi.mock("@stores/voice.store", () => ({
  voiceStore: {
    getState: vi.fn(() => mockVoiceState),
    get: vi.fn(() => ({})),
    set: vi.fn(),
    subscribe: vi.fn(),
  },
  setLocalMuted: vi.fn(),
  setLocalDeafened: vi.fn(),
  setLocalCamera: vi.fn(),
  setLocalScreenshare: vi.fn(),
  setPttGated: vi.fn(),
  // The PTT-poller-live flag lives in the store (so ptt.ts can write it at
  // startup without importing the LiveKit SDK), so the mock has to carry real
  // read/write behaviour rather than a bare vi.fn — restoreLocalVoiceState
  // reads it back through isPttPollingLive().
  setPttPollingLive: vi.fn((live: boolean) => {
    mockPttPollingLive.value = live;
  }),
  isPttPollingLive: vi.fn(() => mockPttPollingLive.value),
  setSpeakers: vi.fn(),
  leaveVoiceChannel: vi.fn(),
  setListenOnly: vi.fn(),
  setVoiceStatus: vi.fn(),
  setPeerVerification: vi.fn(),
  clearPeerVerification: vi.fn(),
  clearPeerVerifications: vi.fn(),
  setLocalSessionFingerprint: vi.fn(),
  setEncryptionDegraded: vi.fn(),
}));

const mockInvoke = vi.hoisted(() =>
  vi.fn((cmd: string, _payload?: unknown) => {
    if (cmd === "start_livekit_proxy") return Promise.resolve(7881);
    if (cmd === "stop_livekit_proxy") return Promise.resolve();
    return Promise.resolve();
  }),
);

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, payload?: unknown) => mockInvoke(cmd, payload),
}));

const { mockLoadPref, mockSavePref } = vi.hoisted(() => ({
  mockLoadPref: vi.fn((_key: string, defaultVal: unknown) => defaultVal),
  mockSavePref: vi.fn(),
}));

vi.mock("@components/settings/helpers", () => ({
  loadPref: (key: string, defaultVal: unknown) => mockLoadPref(key, defaultVal),
  savePref: (key: string, val: unknown) => mockSavePref(key, val),
}));

vi.mock("@lib/logger", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock("@lib/noise-suppression", () => ({
  createRNNoiseProcessor: vi.fn(),
}));

const mockKeyPair = vi.hoisted(() => ({
  publicKey: { type: "public" } as unknown as CryptoKey,
  privateKey: { type: "private" } as unknown as CryptoKey,
}));

const mockIdentityKeyPair = vi.hoisted(() => ({
  publicKey: { type: "id-public" } as unknown as CryptoKey,
  privateKey: { type: "id-private" } as unknown as CryptoKey,
}));

vi.mock("@lib/e2eeCrypto", () => ({
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
}));

// F3 TOFU: identity keyring + peer pin store (Tauri-backed; mocked here).
vi.mock("@lib/identity", () => ({
  getOrCreateIdentityKeyPair: vi.fn(async () => mockIdentityKeyPair),
  getIdentityPin: vi.fn(async () => ({ status: "unpinned" })),
  storeIdentityPin: vi.fn(async () => true),
}));

// Stub Worker for E2EE web worker (not available in Node/vitest). Instances
// carry a terminate() mock so worker-lifecycle assertions can observe teardown.
globalThis.Worker = vi.fn(function (this: { terminate: () => void }) {
  this.terminate = vi.fn();
}) as unknown as typeof Worker;

// Now import
import {
  cleanupAll,
  getRoomForStats,
  handleVoiceToken,
  isVoiceSessionActive,
  setServerHost,
  setWsClient,
} from "../../src/lib/livekitSession";

/** Rooms built and not yet disconnected. */
function liveRooms(): number {
  return rooms.constructed.filter((room) => room.disconnect.mock.calls.length === 0).length;
}

describe("one live media session across a profile switch (B7-13)", () => {
  beforeEach(() => {
    rooms.constructed.length = 0;
    rooms.events.length = 0;
    mockVoiceState.currentChannelId = 1;
  });

  it("disconnects the first profile's room before the next profile's room exists", async () => {
    setServerHost("localhost:7880");
    setWsClient({ send: vi.fn() } as any);
    await handleVoiceToken("token-a", "/livekit", 1, "ws://localhost:7880", true);

    expect(isVoiceSessionActive()).toBe(true);
    expect(liveRooms()).toBe(1);
    const roomA = getRoomForStats();
    expect(roomA).toBe(rooms.constructed[0]);

    // The switch: MainPage.destroy's deep teardown.
    cleanupAll();
    await vi.waitFor(() => expect(liveRooms()).toBe(0));
    expect(isVoiceSessionActive()).toBe(false);
    expect(getRoomForStats()).toBeNull();

    setServerHost("localhost:7881");
    setWsClient({ send: vi.fn() } as any);
    await handleVoiceToken("token-b", "/livekit", 1, "ws://localhost:7881", true);

    expect(isVoiceSessionActive()).toBe(true);
    expect(liveRooms()).toBe(1);
    expect(getRoomForStats()).toBe(rooms.constructed[1]);
    expect(rooms.events).toEqual(["construct:0", "disconnect:0", "construct:1"]);

    cleanupAll();
    await vi.waitFor(() => expect(liveRooms()).toBe(0));
  });
});
