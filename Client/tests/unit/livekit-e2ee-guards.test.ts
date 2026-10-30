import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Behaviour of E2EEManager's session, announce, rotation and teardown guards,
// driven through the manager with the crypto and stores mocked. The protocol
// as a whole is covered end to end in livekit-session.test.ts and the module
// surface in livekit-e2ee.test.ts; this file pins the individual decisions:
// which attempt owns the state when an async step resumes, what each log line
// records, and what a teardown leaves behind.

const mockSetKey = vi.hoisted(() => vi.fn());

vi.mock("livekit-client", () => ({
  ExternalE2EEKeyProvider: vi.fn(function () {
    return { setKey: mockSetKey, getKeys: vi.fn().mockReturnValue([]) };
  }),
}));

const OWN_PUB = "bW9ja2VwaGVtZXJhbA==";
const mockKeyPair = vi.hoisted(() => ({
  publicKey: { type: "public" } as unknown as CryptoKey,
  privateKey: { type: "private" } as unknown as CryptoKey,
}));
const mockIdentityKeyPair = vi.hoisted(() => ({
  publicKey: { type: "id-public" } as unknown as CryptoKey,
  privateKey: { type: "id-private" } as unknown as CryptoKey,
}));

vi.mock("@lib/net/e2eeCrypto", () => ({
  generateECDHKeyPair: vi.fn(async () => mockKeyPair),
  exportPublicKey: vi.fn(async (key: { b64?: string }) => key.b64 ?? "bW9ja2VwaGVtZXJhbA=="),
  importPublicKey: vi.fn(async (b64: string) => ({ type: "peer", b64 }) as unknown as CryptoKey),
  generateRoomKey: vi.fn(() => new Uint8Array(32)),
  roomKeyToBase64: vi.fn(() => "mock-room-key-base64"),
  wrapRoomKey: vi.fn(async () => ({ encryptedKey: "enc", iv: "iv" })),
  unwrapRoomKey: vi.fn(async () => ({ roomKey: new Uint8Array(32), epoch: 0 })),
  signEphemeralKey: vi.fn(async () => "mock-signature"),
  verifyEphemeralKeySignature: vi.fn(async () => true),
  importIdentityPublicKey: vi.fn(
    async () => ({ type: "id-public-imported" }) as unknown as CryptoKey,
  ),
  computeKeyFingerprint: vi.fn(async () => "AB12 CD34 EF56 7890"),
  computeRawKeyFingerprint: vi.fn(async () => "5E55 1234 5678 9ABC"),
}));

vi.mock("@lib/net/identity", () => ({
  getOrCreateIdentityKeyPair: vi.fn(async () => mockIdentityKeyPair),
  getIdentityPin: vi.fn(async () => ({ status: "unpinned" })),
  storeIdentityPin: vi.fn(async () => "stored"),
}));

const auth = vi.hoisted(() => ({ id: 1 }));
vi.mock("@stores/auth.store", () => ({
  authStore: { getState: vi.fn(() => ({ user: { id: auth.id } })) },
}));

// No member publishes an identity key, so every announce is a legacy one:
// accepted, shown as unverified.
vi.mock("@stores/members.store", () => ({
  membersStore: { getState: vi.fn(() => ({ members: new Map() })) },
  memberDisplayName: (m: { username?: string }) => m.username ?? "",
}));

const mockVoiceState = vi.hoisted(() => ({
  voiceUsers: new Map<number, Map<number, unknown>>(),
}));
vi.mock("@stores/voice.store", () => ({
  voiceStore: { getState: vi.fn(() => mockVoiceState) },
  setPeerVerification: vi.fn(),
  clearPeerVerification: vi.fn(),
  clearPeerVerifications: vi.fn(),
  setLocalSessionFingerprint: vi.fn(),
  setLocalSafetyNumber: vi.fn(),
}));

const log = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));
const tagged = vi.hoisted(() => [] as Array<{ tag: string; message: unknown }>);
vi.mock("@lib/logger", () => ({
  createLogger: (tag: string) => {
    const level =
      (fn: (...args: unknown[]) => void) =>
      (...args: unknown[]) => {
        tagged.push({ tag, message: args[0] });
        fn(...args);
      };
    return {
      debug: level((...a) => log.debug(...a)),
      info: level((...a) => log.info(...a)),
      warn: level((...a) => log.warn(...a)),
      error: level((...a) => log.error(...a)),
    };
  },
}));

vi.mock("@lib/voice/voiceJoinTrace", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@lib/voice/voiceJoinTrace")>()),
  markJoinMilestone: vi.fn(),
}));

import { E2EEManager } from "../../src/lib/voice/livekitE2EE";
import { markJoinMilestone } from "@lib/voice/voiceJoinTrace";
import { clearPeerVerification, clearPeerVerifications } from "@stores/voice.store";
import {
  computeRawKeyFingerprint,
  exportPublicKey,
  generateECDHKeyPair,
  importPublicKey,
  signEphemeralKey,
  wrapRoomKey,
} from "@lib/net/e2eeCrypto";
import { getIdentityPin, getOrCreateIdentityKeyPair, storeIdentityPin } from "@lib/net/identity";

const SELF = 1;
const CHANNEL = 7;

const pk = (n: number | string): string => btoa(`peer-key-${n}`);

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  const d = {} as { promise: Promise<T>; resolve: (value: T) => void };
  d.promise = new Promise<T>((resolve) => {
    d.resolve = resolve;
  });
  return d;
}

function newPair(label: string): CryptoKeyPair {
  return {
    publicKey: { type: "public", b64: pk(label) } as unknown as CryptoKey,
    privateKey: { type: "private", label } as unknown as CryptoKey,
  };
}

interface Internals {
  _peerGenerations: Map<number, number>;
  _retiredPeerKeys: Map<number, Set<string>>;
  _peerOfferEpochs: Map<number, number>;
  _blockedAnnounces: Map<number, { publicKeyBase64: string }>;
  _peers: { keyChangedPeers: Map<number, string>; announcedIdentityKeys: Map<number, string> };
  _offers: {
    sendOfferPaced(
      target: number,
      key: string,
      iv: string,
      isStale?: () => boolean,
    ): Promise<boolean>;
  };
  _e2eeEpoch: number;
  _ecdhKeyPair: CryptoKeyPair | null;
  _roomKey: Uint8Array | null;
  _isKeyHolder: boolean;
  _roomKeyResolver: (() => void) | null;
  _roomKeyRejector: ((err: Error) => void) | null;
}
const internals = (m: E2EEManager): Internals => m as unknown as Internals;

type Ws = { send: ReturnType<typeof vi.fn>; getState?: () => string };
const managers: E2EEManager[] = [];

interface CreateOptions {
  channel?: number | null;
  ws?: Ws;
  host?: string | null;
  onRoomKeyInstalled?: () => void;
}

function create(options: CreateOptions = {}): {
  mgr: E2EEManager;
  ws: Ws;
} {
  const ws: Ws = options.ws ?? { send: vi.fn(), getState: () => "connected" };
  const mgr = new E2EEManager({
    getWs: () => ws as never,
    getServerHost: () => (options.host === undefined ? "localhost:7880" : options.host),
    getCurrentChannelId: () => (options.channel === undefined ? 1 : options.channel),
    onRoomKeyInstalled: options.onRoomKeyInstalled,
  });
  managers.push(mgr);
  return { mgr, ws };
}

function sends(ws: Ws, type: string): Array<{ type: string; payload: Record<string, unknown> }> {
  return ws.send.mock.calls
    .map((c) => c[0] as { type: string; payload: Record<string, unknown> })
    .filter((m) => m.type === type);
}

/** A manager that has joined as the key holder and announced. */
async function holder(
  options: Parameters<typeof create>[0] = {},
): Promise<ReturnType<typeof create>> {
  const made = create(options);
  expect(await made.mgr.setupKeyExchange(true, CHANNEL)).toBe(true);
  return made;
}

/** A manager that joined as a non-holder and has the holder's key. */
async function joinedAsNonHolder(options: Parameters<typeof create>[0] = {}) {
  const made = create(options);
  await made.mgr.handleAnnounce(42, pk(42));
  const joined = made.mgr.setupKeyExchange(false, CHANNEL);
  await vi.waitFor(() => expect(sends(made.ws, "voice_e2ee_announce")).toHaveLength(1));
  await made.mgr.handleOffer(42, "enc", "iv");
  expect(await joined).toBe(true);
  return made;
}

beforeEach(() => {
  vi.clearAllMocks();
  auth.id = SELF;
  mockVoiceState.voiceUsers.clear();
  mockSetKey.mockReset();
});

afterEach(() => {
  for (const mgr of managers.splice(0)) mgr.clearState();
  vi.useRealTimers();
});

describe("announces held for a queued join", () => {
  it("replace an older queued announce of the same peers and keep the others", async () => {
    const { mgr } = create();
    await mgr.handleAnnounce(41, pk("old41"));
    await mgr.handleAnnounce(43, pk(43));
    mgr.holdAnnouncesForQueuedJoin(CHANNEL);
    await mgr.handleAnnounce(41, pk("new41"));
    await mgr.handleAnnounce(44, pk(44));
    expect(log.info).toHaveBeenCalledWith("E2EE: held announce for the queued join", {
      userId: 41,
    });
    expect(mgr.pendingAnnounces.map((p) => p.userId)).toEqual([41, 43]);

    expect(await mgr.setupKeyExchange(true, CHANNEL)).toBe(true);

    expect(vi.mocked(importPublicKey).mock.calls.map(([k]) => k)).toEqual([
      pk(43),
      pk("new41"),
      pk(44),
    ]);
    expect([...mgr.peerPublicKeys.keys()].sort()).toEqual([41, 43, 44]);
    expect(log.info).toHaveBeenCalledWith("E2EE: drained queued announce", { userId: 43 });
  });
});

describe("setupKeyExchange ownership", () => {
  it("names the channel when a teardown lands during keypair generation, and writes nothing", async () => {
    const { mgr, ws } = create();
    const generated = deferred<CryptoKeyPair>();
    vi.mocked(generateECDHKeyPair).mockReturnValueOnce(generated.promise);
    const setup = mgr.setupKeyExchange(true, CHANNEL);
    mgr.clearState();
    generated.resolve(mockKeyPair);

    expect(await setup).toBe(false);
    expect(log.warn).toHaveBeenCalledWith(
      "E2EE: setup superseded during keypair generation — aborting",
      { channelId: CHANNEL },
    );
    expect(ws.send).not.toHaveBeenCalled();
    expect(mockSetKey).not.toHaveBeenCalled();
  });

  it("starts a new attempt from empty peer, retired-key, offer-epoch and verification state", async () => {
    const { mgr } = await holder();
    await mgr.handleAnnounce(42, pk("a"));
    await mgr.handleAnnounce(42, pk("b"));
    internals(mgr)._peerOfferEpochs.set(42, 5);
    expect(internals(mgr)._retiredPeerKeys.get(42)?.has(pk("a"))).toBe(true);
    vi.mocked(clearPeerVerifications).mockClear();

    expect(await mgr.setupKeyExchange(true, CHANNEL)).toBe(true);

    expect(mgr.peerPublicKeys.size).toBe(0);
    expect(internals(mgr)._retiredPeerKeys.size).toBe(0);
    expect(internals(mgr)._peerOfferEpochs.size).toBe(0);
    expect(clearPeerVerifications).toHaveBeenCalledTimes(1);
  });

  it("names the channel when a teardown lands before the key-holder setup, and sends nothing", async () => {
    const { mgr, ws } = create();
    const exported = deferred<string>();
    vi.mocked(exportPublicKey).mockReturnValueOnce(exported.promise);
    const setup = mgr.setupKeyExchange(true, CHANNEL);
    await vi.waitFor(() => expect(exportPublicKey).toHaveBeenCalled());
    mgr.clearState();
    exported.resolve(OWN_PUB);

    expect(await setup).toBe(false);
    expect(log.warn).toHaveBeenCalledWith(
      "E2EE: setup superseded before key-holder setup — aborting",
      { channelId: CHANNEL },
    );
    expect(internals(mgr)._isKeyHolder).toBe(false);
    expect(mockSetKey).not.toHaveBeenCalled();
    expect(ws.send).not.toHaveBeenCalled();
  });

  it("stops at once when a teardown lands while the room key is being installed", async () => {
    const { mgr, ws } = create();
    const installed = deferred();
    mockSetKey.mockReturnValueOnce(installed.promise);
    const setup = mgr.setupKeyExchange(true, CHANNEL);
    await vi.waitFor(() => expect(mockSetKey).toHaveBeenCalled());
    mgr.clearState();
    installed.resolve();

    expect(await setup).toBe(false);
    expect(log.info).not.toHaveBeenCalledWith("E2EE: key holder — generated room key", {
      channelId: CHANNEL,
    });
    expect(log.warn).not.toHaveBeenCalledWith(
      "E2EE: setup superseded before keypair publish — aborting",
      expect.anything(),
    );
    expect(ws.send).not.toHaveBeenCalled();
  });

  it("records the key it generated as holder", async () => {
    await holder();
    expect(log.info).toHaveBeenCalledWith("E2EE: key holder — generated room key", {
      channelId: CHANNEL,
    });
  });

  it("does not publish its keypair when a teardown lands right after the room key is installed", async () => {
    const { mgr, ws } = create();
    vi.mocked(markJoinMilestone).mockImplementationOnce((milestone) => {
      if (milestone === "e2ee room key generated") mgr.clearState();
    });

    expect(await mgr.setupKeyExchange(true, CHANNEL)).toBe(false);

    expect(log.warn).toHaveBeenCalledWith(
      "E2EE: setup superseded before keypair publish — aborting",
      { channelId: CHANNEL },
    );
    expect(internals(mgr)._ecdhKeyPair).toBeNull();
    expect(ws.send).not.toHaveBeenCalled();
  });
});

describe("draining queued announces", () => {
  async function blockedDrain(queued: number[]) {
    const made = create();
    for (const id of queued) await made.mgr.handleAnnounce(id, pk(id));
    const pin = deferred<{ status: "unpinned" }>();
    vi.mocked(getIdentityPin).mockReturnValueOnce(pin.promise);
    const setup = made.mgr.setupKeyExchange(true, 1);
    await vi.waitFor(() => expect(getIdentityPin).toHaveBeenCalled());
    return { ...made, pin, setup };
  }

  it("abandons the drain when the session keypair is swapped while one announce is verified", async () => {
    const { mgr, pin, setup } = await blockedDrain([42, 43]);
    vi.mocked(generateECDHKeyPair).mockResolvedValueOnce(newPair("reconnect"));
    await mgr.reannounceForReconnect();
    pin.resolve({ status: "unpinned" });

    expect(await setup).toBe(false);
    expect(mgr.peerPublicKeys.has(43)).toBe(false);
  });

  it("reports a swapped keypair after the last queued announce", async () => {
    const { mgr, pin, setup } = await blockedDrain([42]);
    vi.mocked(generateECDHKeyPair).mockResolvedValueOnce(newPair("reconnect"));
    await mgr.reannounceForReconnect();
    pin.resolve({ status: "unpinned" });

    expect(await setup).toBe(false);
  });

  it("reports a teardown after the last queued announce even when a newer attempt holds the same keypair", async () => {
    const { mgr, pin, setup } = await blockedDrain([42]);
    mgr.clearState();
    // The newer attempt publishes the very same keypair object.
    expect(await mgr.setupKeyExchange(true, 1)).toBe(true);
    pin.resolve({ status: "unpinned" });

    expect(await setup).toBe(false);
  });

  it("skips a queued announce whose peer left before its turn", async () => {
    const { mgr, pin, setup } = await blockedDrain([42, 43]);
    await mgr.handleParticipantLeft(43);
    pin.resolve({ status: "unpinned" });

    expect(await setup).toBe(true);
    expect(mgr.peerPublicKeys.has(42)).toBe(true);
    expect(mgr.peerPublicKeys.has(43)).toBe(false);
  });
});

describe("waiting for the key holder's offer", () => {
  it("re-announces after 10 s and gives up 5 s later, naming the channel", async () => {
    vi.useFakeTimers();
    const { mgr, ws } = create();
    const setup = mgr.setupKeyExchange(false, CHANNEL);
    await vi.advanceTimersByTimeAsync(0);
    expect(log.info).toHaveBeenCalledWith("E2EE: waiting for room key from key holder", {
      channelId: CHANNEL,
    });
    expect(sends(ws, "voice_e2ee_announce")).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(9_999);
    expect(sends(ws, "voice_e2ee_announce")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(log.warn).toHaveBeenCalledWith(
      "E2EE: first key exchange attempt timed out, re-announcing",
      { channelId: CHANNEL },
    );
    expect(sends(ws, "voice_e2ee_announce")).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(await setup).toBe(false);
    expect(log.error).toHaveBeenCalledWith(
      "E2EE: key exchange timed out after retry — disconnecting",
      { channelId: CHANNEL },
    );
    expect(internals(mgr)._roomKeyResolver).toBeNull();
    expect(internals(mgr)._roomKeyRejector).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops without re-announcing when the session is cleared while waiting", async () => {
    const { mgr, ws } = create();
    const setup = mgr.setupKeyExchange(false, CHANNEL);
    await vi.waitFor(() => expect(sends(ws, "voice_e2ee_announce")).toHaveLength(1));
    mgr.clearState();

    expect(await setup).toBe(false);
    expect(log.warn).toHaveBeenCalledWith(
      "E2EE: key exchange aborted (session cleared or superseded)",
      { channelId: CHANNEL },
    );
    expect(sends(ws, "voice_e2ee_announce")).toHaveLength(1);
  });

  it("leaves no timeout pending once the offer arrives", async () => {
    vi.useFakeTimers();
    await joinedAsNonHolder();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("reannounceForReconnect", () => {
  it("names the abandoned attempt when a teardown lands during keypair generation", async () => {
    const { mgr, ws } = await holder();
    ws.send.mockClear();
    const generated = deferred<CryptoKeyPair>();
    vi.mocked(generateECDHKeyPair).mockReturnValueOnce(generated.promise);
    const attempt = mgr.reannounceForReconnect();
    mgr.clearState();
    generated.resolve(newPair("late"));
    await attempt;

    expect(log.warn).toHaveBeenCalledWith(
      "E2EE: reconnect re-announce superseded before keypair publish — aborting",
    );
    expect(ws.send).not.toHaveBeenCalled();
    expect(internals(mgr)._ecdhKeyPair).toBeNull();
  });

  it("adopts the new keypair and announces when the socket does not report a state", async () => {
    const { mgr, ws } = await holder({ ws: { send: vi.fn() } });
    ws.send.mockClear();
    const pair = newPair("fresh");
    vi.mocked(generateECDHKeyPair).mockResolvedValueOnce(pair);

    await mgr.reannounceForReconnect();

    expect(internals(mgr)._ecdhKeyPair).toBe(pair);
    expect(sends(ws, "voice_e2ee_announce")).toHaveLength(1);
    expect(sends(ws, "voice_e2ee_announce")[0]?.payload.public_key).toBe(pk("fresh"));
  });

  it("keeps the current keypair and re-applies the room key when the socket is not connected", async () => {
    const state = { value: "connected" };
    const { mgr, ws } = await holder({ ws: { send: vi.fn(), getState: () => state.value } });
    ws.send.mockClear();
    mockSetKey.mockClear();
    state.value = "reconnecting";
    vi.mocked(generateECDHKeyPair).mockResolvedValueOnce(newPair("unused"));

    await mgr.reannounceForReconnect();

    expect(log.warn).toHaveBeenCalledWith(
      "E2EE: reconnect re-announce skipped — WS not connected, keeping current keypair",
    );
    expect(internals(mgr)._ecdhKeyPair).toBe(mockKeyPair);
    expect(ws.send).not.toHaveBeenCalled();
    expect(mockSetKey).toHaveBeenCalledTimes(1);
    expect(mockSetKey).toHaveBeenCalledWith("mock-room-key-base64");
  });

  it("does not re-apply a room key that a newer session replaced while the socket was down", async () => {
    const state = { value: "connected" };
    const { mgr } = await holder({ ws: { send: vi.fn(), getState: () => state.value } });
    mockSetKey.mockClear();
    state.value = "reconnecting";
    const installing = deferred();
    mockSetKey.mockReturnValueOnce(installing.promise);

    const attempt = mgr.reannounceForReconnect();
    await vi.waitFor(() => expect(mockSetKey).toHaveBeenCalledTimes(1));
    mgr.clearState();
    const newer = mgr.setupKeyExchange(true, CHANNEL); // the newer session installs its own key
    await vi.waitFor(() => expect(internals(mgr)._roomKey).not.toBeNull());
    installing.resolve();
    await Promise.all([attempt, newer]);

    // One write for the interrupted re-apply, one for the newer session; none more.
    expect(mockSetKey).toHaveBeenCalledTimes(2);
  });

  it("sends nothing when a teardown lands while the room key is re-applied", async () => {
    const { mgr, ws } = await holder();
    ws.send.mockClear();
    mockSetKey.mockClear();
    const installing = deferred();
    mockSetKey.mockReturnValueOnce(installing.promise);
    const attempt = mgr.reannounceForReconnect();
    await vi.waitFor(() => expect(mockSetKey).toHaveBeenCalled());
    vi.mocked(exportPublicKey).mockClear();
    mgr.clearState();
    installing.resolve();
    await attempt;

    expect(exportPublicKey).not.toHaveBeenCalled();
    expect(ws.send).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalledWith(
      "E2EE: reconnect re-announce superseded before send — discarding stray announce",
    );
  });

  it("does not count a write for a keypair that a newer re-announce replaced as installed", async () => {
    const installed = vi.fn();
    const { mgr } = await holder({ onRoomKeyInstalled: installed });
    installed.mockClear();
    mockSetKey.mockClear();
    const first = deferred();
    mockSetKey.mockReturnValueOnce(first.promise);
    vi.mocked(generateECDHKeyPair)
      .mockResolvedValueOnce(newPair("one"))
      .mockResolvedValueOnce(newPair("two"));

    const attemptOne = mgr.reannounceForReconnect();
    await vi.waitFor(() => expect(mockSetKey).toHaveBeenCalledTimes(1));
    const attemptTwo = mgr.reannounceForReconnect();
    first.resolve();
    await Promise.all([attemptOne, attemptTwo]);

    // The first attempt's write landed after its keypair was replaced: only
    // the second attempt's write is reported as installed.
    expect(mockSetKey).toHaveBeenCalledTimes(2);
    expect(installed).toHaveBeenCalledTimes(1);
  });

  it("discards the announce when a teardown lands while it is being signed", async () => {
    const { mgr, ws } = await holder();
    ws.send.mockClear();
    const signed = deferred<string>();
    vi.mocked(signEphemeralKey).mockReturnValueOnce(signed.promise);
    const attempt = mgr.reannounceForReconnect();
    await vi.waitFor(() => expect(signEphemeralKey).toHaveBeenCalledTimes(2));
    mgr.clearState();
    signed.resolve("late-signature");
    await attempt;

    expect(log.warn).toHaveBeenCalledWith(
      "E2EE: reconnect re-announce superseded before send — discarding stray announce",
    );
    expect(ws.send).not.toHaveBeenCalled();
  });

  describe("confirming a re-applied key", () => {
    it("re-announces and says so once, 5 s after a non-holder's re-announce when no offer replaced the key", async () => {
      vi.useFakeTimers();
      const { mgr, ws } = await joinedAsNonHolder();
      ws.send.mockClear();
      await mgr.reannounceForReconnect();
      expect(sends(ws, "voice_e2ee_announce")).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(1);

      await vi.advanceTimersByTimeAsync(4_999);
      expect(sends(ws, "voice_e2ee_announce")).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);

      expect(log.error).toHaveBeenCalledWith(
        "E2EE: room key not reconfirmed after reconnect — may be stale, re-announcing",
        { channelId: CHANNEL },
      );
      expect(sends(ws, "voice_e2ee_announce")).toHaveLength(2);
    });

    it("keeps one pending check when the re-announce runs again", async () => {
      vi.useFakeTimers();
      const { mgr } = await joinedAsNonHolder();
      await mgr.reannounceForReconnect();
      await mgr.reannounceForReconnect();
      expect(vi.getTimerCount()).toBe(1);
    });

    it("stays quiet when a newer re-announce has replaced the keypair the check was armed for", async () => {
      vi.useFakeTimers();
      const { mgr, ws } = await joinedAsNonHolder();
      await mgr.reannounceForReconnect();
      ws.send.mockClear();
      const installing = deferred();
      mockSetKey.mockReturnValueOnce(installing.promise);
      vi.mocked(generateECDHKeyPair).mockResolvedValueOnce(newPair("newer"));
      const newer = mgr.reannounceForReconnect(); // adopts its keypair, then waits on the write

      await vi.advanceTimersByTimeAsync(5_000);
      expect(log.error).not.toHaveBeenCalledWith(
        "E2EE: room key not reconfirmed after reconnect — may be stale, re-announcing",
        expect.anything(),
      );
      expect(ws.send).not.toHaveBeenCalled();
      installing.resolve();
      await newer;
    });

    it("is cancelled by a teardown", async () => {
      vi.useFakeTimers();
      const { mgr } = await joinedAsNonHolder();
      await mgr.reannounceForReconnect();
      expect(vi.getTimerCount()).toBe(1);
      mgr.clearState();
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});

describe("identity key and re-pinning", () => {
  it("reloads the identity key after it is cleared and not before", async () => {
    const { mgr } = await holder();
    expect(getOrCreateIdentityKeyPair).toHaveBeenCalledTimes(1);
    mgr.clearState();
    await mgr.setupKeyExchange(true, CHANNEL);
    expect(getOrCreateIdentityKeyPair).toHaveBeenCalledTimes(1);

    mgr.clearIdentityKeyPair();
    mgr.clearState();
    await mgr.setupKeyExchange(true, CHANNEL);
    expect(getOrCreateIdentityKeyPair).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["there is no server host", { host: null }, "key"],
    ["there is no verified key", {}, ""],
  ])("refuses a re-pin when %s", async (_label, options, key) => {
    const { mgr } = create(options);
    await expect(mgr.rePinPeerIdentity(42, key)).resolves.toBe(false);
    expect(log.warn).toHaveBeenCalledWith(
      "E2EE: cannot re-pin peer without a host and the verified identity key",
      { userId: 42 },
    );
    expect(storeIdentityPin).not.toHaveBeenCalled();
  });

  it("keeps the mismatch block and says so when the pin cannot be stored", async () => {
    const { mgr } = await holder();
    internals(mgr)._blockedAnnounces.set(42, { publicKeyBase64: pk(42) });
    vi.mocked(storeIdentityPin).mockResolvedValueOnce("failed");

    await expect(mgr.rePinPeerIdentity(42, "id-key")).resolves.toBe(false);

    expect(log.error).toHaveBeenCalledWith(
      "E2EE: failed to persist re-pinned identity key — mismatch block kept",
      { userId: 42 },
    );
    expect(internals(mgr)._blockedAnnounces.has(42)).toBe(true);
    expect(clearPeerVerification).not.toHaveBeenCalled();
  });

  it("replays the blocked announce after a successful re-pin and forgets the block", async () => {
    const { mgr } = await holder();
    internals(mgr)._blockedAnnounces.set(42, { publicKeyBase64: pk(42) });

    await expect(mgr.rePinPeerIdentity(42, "id-key")).resolves.toBe(true);

    expect(storeIdentityPin).toHaveBeenCalledWith("localhost:7880", "42", "id-key");
    expect(internals(mgr)._blockedAnnounces.has(42)).toBe(false);
    expect(log.info).toHaveBeenCalledWith(
      "E2EE: replaying blocked announce after re-pin (TOFU recovery)",
      { userId: 42 },
    );
    expect(mgr.peerPublicKeys.has(42)).toBe(true);
    expect(clearPeerVerification).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith("E2EE: re-pinned peer identity key (TOFU recovery)", {
      userId: 42,
    });
  });

  it("clears the peer's verification after a re-pin with nothing to replay", async () => {
    const { mgr } = await holder();
    await expect(mgr.rePinPeerIdentity(42, "id-key")).resolves.toBe(true);
    expect(clearPeerVerification).toHaveBeenCalledWith(42);
    expect(mgr.peerPublicKeys.has(42)).toBe(false);
    expect(log.info).toHaveBeenCalledWith("E2EE: re-pinned peer identity key (TOFU recovery)", {
      userId: 42,
    });
  });
});

describe("handleAnnounce", () => {
  it("queues an announce that arrives before the keypair exists", async () => {
    const { mgr } = create();
    await mgr.handleAnnounce(42, pk(42));
    expect(log.info).toHaveBeenCalledWith("E2EE: queued announce (keypair not ready)", {
      userId: 42,
    });
  });

  it("records a new peer key, a repeated one and a changed one", async () => {
    const { mgr } = await holder();
    await mgr.handleAnnounce(42, pk("a"));
    expect(log.info).toHaveBeenCalledWith("E2EE: received peer public key", { userId: 42 });

    await mgr.handleAnnounce(42, pk("a"));
    expect(log.debug).toHaveBeenCalledWith(
      "E2EE: duplicate announce — will re-send offer if key holder",
      { userId: 42 },
    );

    await mgr.handleAnnounce(42, pk("b"));
    expect(log.warn).toHaveBeenCalledWith("E2EE: peer public key changed (reconnect?)", {
      userId: 42,
    });
    expect(internals(mgr)._retiredPeerKeys.get(42)?.has(pk("a"))).toBe(true);
  });

  it("rejects a replay of a key the peer was moved off, naming the peer", async () => {
    const { mgr } = await holder();
    await mgr.handleAnnounce(42, pk("a"));
    await mgr.handleAnnounce(42, pk("b"));
    await mgr.handleAnnounce(42, pk("a"));

    expect(log.error).toHaveBeenCalledWith(
      "E2EE: rejecting replayed peer key announce (previously retired)",
      { userId: 42 },
    );
    expect(await exportPublicKey(mgr.peerPublicKeys.get(42) as CryptoKey)).toBe(pk("b"));
  });

  it("skips an announce whose peer left before the announces ahead of it finished", async () => {
    const { mgr } = await holder();
    const pin = deferred<{ status: "unpinned" }>();
    vi.mocked(getIdentityPin).mockReturnValueOnce(pin.promise);
    const first = mgr.handleAnnounce(42, pk(42));
    const second = mgr.handleAnnounce(43, pk(43));
    await vi.waitFor(() => expect(getIdentityPin).toHaveBeenCalledTimes(1));
    await mgr.handleParticipantLeft(43);
    pin.resolve({ status: "unpinned" });
    await Promise.all([first, second]);

    expect(getIdentityPin).toHaveBeenCalledTimes(1);
    expect(mgr.peerPublicKeys.has(43)).toBe(false);
  });

  it("discards an announce whose peer left while its fingerprint was computed", async () => {
    const { mgr } = await holder();
    const fingerprint = deferred<string>();
    vi.mocked(computeRawKeyFingerprint).mockReturnValueOnce(fingerprint.promise);
    const announce = mgr.handleAnnounce(42, pk(42));
    await vi.waitFor(() => expect(computeRawKeyFingerprint).toHaveBeenCalledTimes(2));
    internals(mgr)._peerGenerations.set(42, 9);
    fingerprint.resolve("FF00");
    await announce;

    expect(log.info).toHaveBeenCalledWith(
      "E2EE: discarding stale announce (session torn down during verify)",
      { userId: 42 },
    );
    expect(mgr.peerPublicKeys.has(42)).toBe(false);
  });

  it("discards an announce whose peer left while its key was imported", async () => {
    const { mgr } = await holder();
    const imported = deferred<CryptoKey>();
    vi.mocked(importPublicKey).mockReturnValueOnce(imported.promise);
    const announce = mgr.handleAnnounce(42, pk(42));
    await vi.waitFor(() => expect(importPublicKey).toHaveBeenCalled());
    internals(mgr)._peerGenerations.set(42, 9);
    imported.resolve({ type: "peer", b64: pk(42) } as unknown as CryptoKey);
    await announce;

    expect(log.info).toHaveBeenCalledWith(
      "E2EE: discarding stale announce (session torn down during key import)",
      { userId: 42 },
    );
    expect(mgr.peerPublicKeys.has(42)).toBe(false);
  });

  it("logs the error behind an announce it could not handle and keeps handling later ones", async () => {
    const { mgr, ws } = await holder();
    const failure = new Error("wrap failed");
    vi.mocked(wrapRoomKey).mockRejectedValueOnce(failure);
    await mgr.handleAnnounce(42, pk(42));
    expect(log.error).toHaveBeenCalledWith("E2EE: failed to handle announce", failure);

    await mgr.handleAnnounce(43, pk(43));
    expect(sends(ws, "voice_e2ee_offer").map((m) => m.payload.target_user_id)).toEqual([43]);
  });
});

describe("a key holder meeting an announcing peer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("stands down for a peer with a lower user id: no offer, no rotation timer", async () => {
    auth.id = 5;
    const { mgr, ws } = await holder();
    expect(vi.getTimerCount()).toBe(1);

    await mgr.handleAnnounce(3, pk(3));

    expect(internals(mgr)._isKeyHolder).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(log.info).toHaveBeenCalledWith(
      "E2EE: stood down as key holder — announcing peer has a lower user id",
      { userId: 3, myUserId: 5 },
    );
    expect(wrapRoomKey).not.toHaveBeenCalled();
    expect(sends(ws, "voice_e2ee_offer")).toHaveLength(0);
    expect(mgr.peerPublicKeys.has(3)).toBe(true);
  });

  it.each([
    ["a higher user id", 7],
    ["its own user id from another device", 5],
  ])("keeps the role and sends an offer to a peer with %s", async (_label, peerId) => {
    auth.id = 5;
    const { mgr, ws } = await holder();

    await mgr.handleAnnounce(peerId, pk(peerId));

    expect(internals(mgr)._isKeyHolder).toBe(true);
    expect(vi.getTimerCount()).toBe(1);
    expect(sends(ws, "voice_e2ee_offer").map((m) => m.payload.target_user_id)).toEqual([peerId]);
    expect(log.info).toHaveBeenCalledWith("E2EE: sent room key offer to peer", { userId: peerId });
    expect(log.info).not.toHaveBeenCalledWith(
      expect.stringContaining("stood down"),
      expect.anything(),
    );
  });

  it("does not stand down when it is no longer the holder", async () => {
    auth.id = 5;
    const { mgr } = await holder();
    internals(mgr)._isKeyHolder = false;

    await mgr.handleAnnounce(3, pk(3));

    expect(log.info).not.toHaveBeenCalledWith(
      expect.stringContaining("stood down"),
      expect.anything(),
    );
    expect(wrapRoomKey).not.toHaveBeenCalled();
  });

  it("discards an offer wrapped before a rotation, recording both epochs", async () => {
    const { mgr, ws } = await holder();
    const wrapped = deferred<{ encryptedKey: string; iv: string }>();
    vi.mocked(wrapRoomKey).mockReturnValueOnce(wrapped.promise);
    const announce = mgr.handleAnnounce(42, pk(42));
    await vi.waitFor(() => expect(wrapRoomKey).toHaveBeenCalled());
    internals(mgr)._e2eeEpoch = 2;
    wrapped.resolve({ encryptedKey: "enc", iv: "iv" });
    await announce;

    expect(sends(ws, "voice_e2ee_offer")).toHaveLength(0);
    expect(log.info).toHaveBeenCalledWith(
      "E2EE: discarding stale announce-offer (epoch or keypair changed during wrap)",
      { userId: 42, epochBefore: 1, epochNow: 2 },
    );
  });

  describe("when the offer has to wait for the send budget", () => {
    async function announceDuringPause(change?: (mgr: E2EEManager) => void) {
      const { mgr, ws } = await holder();
      const offers = internals(mgr)._offers;
      for (let i = 0; i < 60; i++) void offers.sendOfferPaced(100 + i, "enc", "iv");
      expect(sends(ws, "voice_e2ee_offer")).toHaveLength(60);
      const announce = mgr.handleAnnounce(42, pk(42));
      await vi.advanceTimersByTimeAsync(10);
      change?.(mgr);
      await vi.advanceTimersByTimeAsync(1_100);
      await announce;
      return { mgr, ws };
    }

    it("sends it when nothing changed", async () => {
      const { ws } = await announceDuringPause();
      expect(sends(ws, "voice_e2ee_offer")).toHaveLength(61);
      expect(log.info).toHaveBeenCalledWith("E2EE: sent room key offer to peer", { userId: 42 });
    });

    it.each([
      ["the peer left", (mgr: E2EEManager) => internals(mgr)._peerGenerations.set(42, 9), 1],
      ["a rotation advanced the epoch", (mgr: E2EEManager) => (internals(mgr)._e2eeEpoch = 2), 2],
      [
        "the keypair was swapped",
        (mgr: E2EEManager) => (internals(mgr)._ecdhKeyPair = newPair("swap")),
        1,
      ],
    ])("withholds it when %s during the wait", async (_label, change, epochNow) => {
      const { ws } = await announceDuringPause(change);
      expect(sends(ws, "voice_e2ee_offer")).toHaveLength(60);
      expect(log.info).toHaveBeenCalledWith(
        "E2EE: discarding stale announce-offer (epoch or keypair changed during pacing pause)",
        { userId: 42, epochBefore: 1, epochNow },
      );
      expect(log.info).not.toHaveBeenCalledWith("E2EE: sent room key offer to peer", {
        userId: 42,
      });
    });
  });
});

describe("handleOffer wiring", () => {
  it("wakes the waiting join and clears both of its handlers", async () => {
    const { mgr } = await holder();
    await mgr.handleAnnounce(42, pk(42));
    const resolver = vi.fn();
    internals(mgr)._roomKeyResolver = resolver;
    internals(mgr)._roomKeyRejector = vi.fn();
    internals(mgr)._isKeyHolder = false;

    await mgr.handleOffer(42, "enc", "iv");

    expect(resolver).toHaveBeenCalledTimes(1);
    expect(internals(mgr)._roomKeyResolver).toBeNull();
    expect(internals(mgr)._roomKeyRejector).toBeNull();
  });
});

describe("handleParticipantLeft", () => {
  it("forgets everything held for the peer and counts each departure", async () => {
    const { mgr } = create({ channel: null });
    await mgr.handleAnnounce(42, pk(42));
    await mgr.handleAnnounce(43, pk(43));
    internals(mgr)._blockedAnnounces.set(42, { publicKeyBase64: pk(42) });
    internals(mgr)._peerOfferEpochs.set(42, 3);
    internals(mgr)._peers.announcedIdentityKeys.set(42, "id");

    await mgr.handleParticipantLeft(42);

    expect(mgr.pendingAnnounces.map((p) => p.userId)).toEqual([43]);
    expect(internals(mgr)._blockedAnnounces.has(42)).toBe(false);
    expect(internals(mgr)._peerOfferEpochs.has(42)).toBe(false);
    expect(mgr.peerAnnouncedIdentityKey(42)).toBeNull();
    expect(clearPeerVerification).toHaveBeenCalledWith(42);
    expect(internals(mgr)._peerGenerations.get(42)).toBe(1);

    await mgr.handleParticipantLeft(42);
    expect(internals(mgr)._peerGenerations.get(42)).toBe(2);
  });

  it("elects nobody when no channel is known", async () => {
    const { mgr } = create({ channel: null });
    await mgr.handleParticipantLeft(42);
    expect(internals(mgr)._isKeyHolder).toBe(false);
    expect(mgr.epoch).toBe(0);
  });

  it("retires the departed peer's key once", async () => {
    const { mgr } = await holder();
    await mgr.handleAnnounce(42, pk(42));
    await mgr.handleParticipantLeft(42);
    expect(internals(mgr)._retiredPeerKeys.get(42)).toEqual(new Set([pk(42)]));
  });

  it("does not retire a key for a departure that a repeated leave superseded", async () => {
    const { mgr } = await holder();
    await mgr.handleAnnounce(42, pk(42));
    const exported = deferred<string>();
    vi.mocked(exportPublicKey).mockReturnValueOnce(exported.promise);

    const first = mgr.handleParticipantLeft(42);
    const second = mgr.handleParticipantLeft(42);
    exported.resolve("departing-key");
    await Promise.all([first, second]);

    expect(internals(mgr)._retiredPeerKeys.get(42)).toBeUndefined();
  });

  it("elects nobody when neither we nor the roster know a user id", async () => {
    auth.id = 0;
    const { mgr } = await holder();
    await mgr.handleAnnounce(42, pk(42));
    expect(mgr.epoch).toBe(1);

    await mgr.handleParticipantLeft(42);

    expect(mgr.epoch).toBe(1);
  });

  it("defers a re-election behind a rotation already in flight", async () => {
    const { mgr } = create();
    mgr.rotatingKey = true;

    await mgr.handleParticipantLeft(42);

    expect(mgr.rotationPending).toBe(true);
    expect(internals(mgr)._isKeyHolder).toBe(true);
    expect(mgr.epoch).toBe(0);
    expect(log.warn).toHaveBeenCalledWith(
      "E2EE: key rotation already in progress — deferring re-election as holder",
      { userId: 42, channelId: 1 },
    );
  });

  describe("when the lowest remaining user id is ours", () => {
    async function electedHolder() {
      const made = await holder();
      await made.mgr.handleAnnounce(42, pk(42));
      await made.mgr.handleAnnounce(43, pk(43));
      internals(made.mgr)._isKeyHolder = false; // someone else held the key until now
      made.ws.send.mockClear();
      vi.mocked(wrapRoomKey).mockClear();
      return made;
    }

    it("rotates the key, offers it to every remaining peer and records each step", async () => {
      const { mgr, ws } = await electedHolder();

      await mgr.handleParticipantLeft(42);

      expect(log.info).toHaveBeenCalledWith("E2EE: became key holder after participant left", {
        userId: 42,
        channelId: CHANNEL,
      });
      expect(log.info).toHaveBeenCalledWith("E2EE: rotated room key", {
        channelId: CHANNEL,
        epoch: 2,
      });
      expect(sends(ws, "voice_e2ee_offer").map((m) => m.payload.target_user_id)).toEqual([43]);
      expect(log.info).toHaveBeenCalledWith("E2EE: distributed rotated key to peers", {
        peerCount: 1,
      });
      expect(log.info).not.toHaveBeenCalledWith(
        "E2EE: sent rotated key to late-arriving peers",
        expect.anything(),
      );
      expect(wrapRoomKey).toHaveBeenCalledTimes(1);
      expect(mgr.rotatingKey).toBe(false);
    });

    it("also offers the key to a peer that arrived during the rotation, and only to that peer", async () => {
      const { mgr, ws } = await electedHolder();
      vi.mocked(wrapRoomKey).mockImplementationOnce(async () => {
        mgr.peerPublicKeys.set(44, { type: "peer", b64: pk(44) } as unknown as CryptoKey);
        return { encryptedKey: "enc", iv: "iv" };
      });

      await mgr.handleParticipantLeft(42);

      expect(sends(ws, "voice_e2ee_offer").map((m) => m.payload.target_user_id)).toEqual([43, 44]);
      expect(wrapRoomKey).toHaveBeenCalledTimes(2);
      expect(log.info).toHaveBeenCalledWith("E2EE: sent rotated key to late-arriving peers", {
        peerCount: 1,
      });
    });

    it.each([
      [
        "the keypair was swapped",
        (mgr: E2EEManager) => {
          internals(mgr)._ecdhKeyPair = newPair("swap");
        },
      ],
      [
        "the room key was replaced",
        (mgr: E2EEManager) => {
          internals(mgr)._roomKey = new Uint8Array(32);
        },
      ],
    ])("sends nothing to a late arrival when %s during the rotation", async (_label, change) => {
      const { mgr, ws } = await electedHolder();
      vi.mocked(wrapRoomKey).mockImplementationOnce(async () => {
        mgr.peerPublicKeys.set(44, { type: "peer", b64: pk(44) } as unknown as CryptoKey);
        change(mgr);
        return { encryptedKey: "enc", iv: "iv" };
      });

      await mgr.handleParticipantLeft(42);

      expect(sends(ws, "voice_e2ee_offer")).toHaveLength(0);
      expect(wrapRoomKey).toHaveBeenCalledTimes(1);
      expect(log.info).not.toHaveBeenCalledWith(
        "E2EE: sent rotated key to late-arriving peers",
        expect.anything(),
      );
    });

    it("logs a rotation that fails and releases the rotation flag", async () => {
      const { mgr } = await electedHolder();
      const failure = new Error("provider down");
      mockSetKey.mockRejectedValueOnce(failure);

      await mgr.handleParticipantLeft(42);

      expect(log.error).toHaveBeenCalledWith("E2EE: failed to rotate room key", failure);
      expect(mgr.rotatingKey).toBe(false);
    });

    it("leaves a newer session's rotation flag alone when a teardown lands mid-rotation", async () => {
      const { mgr } = await electedHolder();
      const installing = deferred();
      mockSetKey.mockReturnValueOnce(installing.promise);

      const leave = mgr.handleParticipantLeft(42);
      await vi.waitFor(() => expect(mockSetKey).toHaveBeenCalledTimes(2));
      mgr.clearState();
      mgr.rotatingKey = true; // the newer session's own rotation
      installing.resolve();
      await leave;

      expect(mgr.rotatingKey).toBe(true);
    });
  });
});

describe("clearState", () => {
  it("empties every per-session table and the stored verifications", async () => {
    const { mgr } = await holder();
    await mgr.handleAnnounce(42, pk("a"));
    await mgr.handleAnnounce(42, pk("b"));
    await mgr.handleParticipantLeft(43);
    internals(mgr)._peerOfferEpochs.set(42, 5);
    internals(mgr)._blockedAnnounces.set(42, { publicKeyBase64: pk(42) });
    internals(mgr)._peers.keyChangedPeers.set(42, "id");
    internals(mgr)._peers.announcedIdentityKeys.set(42, "id");
    vi.mocked(clearPeerVerifications).mockClear();

    mgr.clearState();

    expect(mgr.peerPublicKeys.size).toBe(0);
    expect(internals(mgr)._peerGenerations.size).toBe(0);
    expect(internals(mgr)._retiredPeerKeys.size).toBe(0);
    expect(internals(mgr)._peerOfferEpochs.size).toBe(0);
    expect(internals(mgr)._blockedAnnounces.size).toBe(0);
    expect(internals(mgr)._peers.keyChangedPeers.size).toBe(0);
    expect(internals(mgr)._peers.announcedIdentityKeys.size).toBe(0);
    expect(clearPeerVerifications).toHaveBeenCalledTimes(1);
    expect(mgr.epoch).toBe(0);
  });

  it("stops the rotation timer", async () => {
    vi.useFakeTimers();
    const { mgr } = await holder();
    expect(vi.getTimerCount()).toBe(1);
    mgr.clearState();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("gives the next session a fresh offer send budget", async () => {
    vi.useFakeTimers();
    const { mgr } = await holder();
    const offers = internals(mgr)._offers;
    for (let i = 0; i < 60; i++) void offers.sendOfferPaced(100 + i, "enc", "iv");

    mgr.clearState();

    // A spent budget would make this wait out the window, and then report the
    // stale check; a fresh one sends at once.
    let settled: boolean | null = null;
    void offers
      .sendOfferPaced(200, "enc", "iv", () => true)
      .then((sent) => {
        settled = sent;
      });
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(settled).toBe(true);
  });

  it("tells a join that is still waiting for the key that the session ended", () => {
    const { mgr } = create();
    const rejector = vi.fn();
    internals(mgr)._roomKeyRejector = rejector;

    mgr.clearState();

    expect(rejector).toHaveBeenCalledWith(new Error("Voice session ended"));
    expect(internals(mgr)._roomKeyRejector).toBeNull();
    expect(internals(mgr)._roomKeyResolver).toBeNull();
  });
});

describe("room key installs and log tags", () => {
  it("reports every installed room key to the session facade", async () => {
    const installed = vi.fn();
    const { mgr } = await holder({ onRoomKeyInstalled: installed });
    expect(installed).toHaveBeenCalledTimes(1);

    await mgr.handleAnnounce(42, pk(42));
    internals(mgr)._isKeyHolder = false;
    await mgr.handleOffer(42, "enc", "iv");
    expect(installed).toHaveBeenCalledTimes(2);
  });

  it("stops the rotation timer of a holder that accepts the elected holder's offer", async () => {
    vi.useFakeTimers();
    const { mgr } = await holder();
    await mgr.handleAnnounce(42, pk(42));
    expect(vi.getTimerCount()).toBe(1);

    await mgr.handleOffer(42, "enc", "iv");

    expect(internals(mgr)._isKeyHolder).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("logs under the shared E2EE tag", async () => {
    const { mgr } = create();
    await mgr.handleAnnounce(42, pk(42));
    const entry = tagged.find((t) => t.message === "E2EE: queued announce (keypair not ready)");
    expect(entry?.tag).toBe("livekitE2EE");
  });

  it("elects nobody while our own user id is unknown, even if the roster lists id 0", async () => {
    auth.id = 0;
    mockVoiceState.voiceUsers.set(CHANNEL, new Map([[0, {}]]));
    const { mgr } = create({ channel: CHANNEL });

    await mgr.handleParticipantLeft(42);

    expect(internals(mgr)._isKeyHolder).toBe(false);
    expect(mgr.epoch).toBe(0);
  });
});
