import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../lib/e2eeCrypto", () => ({
  wrapRoomKey: vi.fn(async (_priv: unknown, _peer: unknown, key: Uint8Array, epoch: number) => ({
    encryptedKey: `enc:${key[0]}@${epoch}`,
    iv: "iv",
  })),
  unwrapRoomKey: vi.fn(),
}));
vi.mock("../../lib/logger", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { wrapRoomKey, unwrapRoomKey } from "../../lib/e2eeCrypto";
import { E2EEOffer } from "./e2eeOffer";

const HOLDER = 1;
const KEYPAIR = { privateKey: "priv", publicKey: "pub" } as unknown as CryptoKeyPair;
const PEER_KEY = "peer-key" as unknown as CryptoKey;

function setup() {
  const state = {
    current: true,
    announceChain: Promise.resolve(),
    peers: new Map<number, CryptoKey>([[HOLDER, PEER_KEY]]),
    keypair: KEYPAIR as CryptoKeyPair | null,
    epoch: 0,
    offerEpochs: new Map<number, number>(),
    roomKey: null as Uint8Array | null,
    keyHolder: false,
    resolver: null as (() => void) | null,
    rejector: null as ((err: Error) => void) | null,
  };
  const ws = { send: vi.fn() };
  const host = {
    getWs: () => ws as never,
    getAnnounceChain: () => state.announceChain,
    peerAttemptIsCurrent: () => () => state.current,
    getPeerPublicKeys: () => state.peers,
    getEcdhKeyPair: () => state.keypair,
    getEpoch: () => state.epoch,
    getPeerOfferEpochs: () => state.offerEpochs,
    getRoomKey: () => state.roomKey,
    setRoomKey: (key: Uint8Array | null) => {
      state.roomKey = key;
    },
    applyRoomKey: vi.fn(async (_key: Uint8Array, _isCurrent: () => boolean) => true),
    isKeyHolder: () => state.keyHolder,
    setKeyHolder: (value: boolean) => {
      state.keyHolder = value;
    },
    clearKeyRotationTimer: vi.fn(),
    getRoomKeyResolver: () => state.resolver,
    setRoomKeyResolver: (r: (() => void) | null) => {
      state.resolver = r;
    },
    getRoomKeyRejector: () => state.rejector,
    setRoomKeyRejector: (r: ((err: Error) => void) | null) => {
      state.rejector = r;
    },
  };
  return { state, ws, host, offers: new E2EEOffer(host) };
}

function deferred<T>() {
  const d = {} as { promise: Promise<T>; resolve: (value: T) => void };
  d.promise = new Promise<T>((resolve) => {
    d.resolve = resolve;
  });
  return d;
}

function sent(ws: { send: ReturnType<typeof vi.fn> }) {
  return ws.send.mock.calls.map((c) => c[0].payload);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(unwrapRoomKey).mockResolvedValue({ roomKey: new Uint8Array([7]), epoch: 3 });
});

describe("E2EEOffer.handleOffer", () => {
  it("applies the unwrapped key, records the epoch and wakes the waiting join", async () => {
    const { state, host, offers } = setup();
    const resolver = vi.fn();
    state.resolver = resolver;
    state.rejector = vi.fn();
    await offers.handleOffer(HOLDER, "enc", "iv");
    expect(state.roomKey).toEqual(new Uint8Array([7]));
    expect(host.applyRoomKey).toHaveBeenCalledWith(state.roomKey, expect.any(Function));
    expect(state.offerEpochs.get(HOLDER)).toBe(3);
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(state.resolver).toBeNull();
    expect(state.rejector).toBeNull();
  });

  it("stands down a stale key holder that accepts the elected holder's offer", async () => {
    const { state, host, offers } = setup();
    state.keyHolder = true;
    await offers.handleOffer(HOLDER, "enc", "iv");
    expect(state.keyHolder).toBe(false);
    expect(host.clearKeyRotationTimer).toHaveBeenCalledTimes(1);
  });

  it("ignores an offer from an unknown peer or without a keypair", async () => {
    const { state, offers } = setup();
    await offers.handleOffer(99, "enc", "iv");
    state.keypair = null;
    await offers.handleOffer(HOLDER, "enc", "iv");
    expect(unwrapRoomKey).not.toHaveBeenCalled();
    expect(state.roomKey).toBeNull();
  });

  it("discards an offer below the sender's epoch high-water mark", async () => {
    const { state, offers } = setup();
    state.offerEpochs.set(HOLDER, 4);
    await offers.handleOffer(HOLDER, "enc", "iv");
    expect(state.roomKey).toBeNull();
    expect(state.offerEpochs.get(HOLDER)).toBe(4);
  });

  it("accepts an offer at the high-water mark", async () => {
    const { state, offers } = setup();
    state.offerEpochs.set(HOLDER, 3);
    await offers.handleOffer(HOLDER, "enc", "iv");
    expect(state.roomKey).toEqual(new Uint8Array([7]));
  });

  it("applies a legacy offer with no epoch without recording a mark", async () => {
    vi.mocked(unwrapRoomKey).mockResolvedValueOnce({ roomKey: new Uint8Array([8]), epoch: null });
    const { state, offers } = setup();
    await offers.handleOffer(HOLDER, "enc", "iv");
    expect(state.roomKey).toEqual(new Uint8Array([8]));
    expect(state.offerEpochs.has(HOLDER)).toBe(false);
  });

  it.each([
    ["a rotation advanced the epoch", (s: ReturnType<typeof setup>["state"]) => s.epoch++],
    [
      "the session keypair was replaced",
      (s: ReturnType<typeof setup>["state"]) => (s.keypair = { ...KEYPAIR }),
    ],
    ["the attempt was superseded", (s: ReturnType<typeof setup>["state"]) => (s.current = false)],
  ])("discards the unwrapped key when %s during unwrap", async (_label, change) => {
    const { state, offers } = setup();
    vi.mocked(unwrapRoomKey).mockImplementationOnce(async () => {
      change(state);
      return { roomKey: new Uint8Array([7]), epoch: 3 };
    });
    await offers.handleOffer(HOLDER, "enc", "iv");
    expect(state.roomKey).toBeNull();
  });

  it("leaves the join waiter alone when superseded during the provider write", async () => {
    const { state, host, offers } = setup();
    const resolver = vi.fn();
    state.resolver = resolver;
    state.keyHolder = true;
    host.applyRoomKey.mockImplementationOnce(async () => {
      state.keypair = { ...KEYPAIR };
      return true;
    });
    await offers.handleOffer(HOLDER, "enc", "iv");
    expect(resolver).not.toHaveBeenCalled();
    expect(state.keyHolder).toBe(true);
  });

  it("stops when the provider write reports the key superseded", async () => {
    const { state, host, offers } = setup();
    const resolver = vi.fn();
    state.resolver = resolver;
    host.applyRoomKey.mockResolvedValueOnce(false);
    await offers.handleOffer(HOLDER, "enc", "iv");
    expect(resolver).not.toHaveBeenCalled();
  });

  it("rejects the waiting join on a decrypt failure, only while current", async () => {
    vi.mocked(unwrapRoomKey).mockRejectedValue(new Error("bad offer"));
    const { state, offers } = setup();
    const rejector = vi.fn();
    state.rejector = rejector;
    state.current = false;
    await offers.handleOffer(HOLDER, "enc", "iv");
    expect(rejector).not.toHaveBeenCalled();
    state.current = true;
    await offers.handleOffer(HOLDER, "enc", "iv");
    expect(rejector).toHaveBeenCalledWith(new Error("bad offer"));
    expect(state.rejector).toBeNull();
  });

  it("waits behind the announces dispatched before it (OC-0002)", async () => {
    const { state, offers } = setup();
    const announce = deferred<void>();
    state.announceChain = announce.promise;
    state.peers.clear(); // the sender's announce has not applied yet
    const offer = offers.handleOffer(HOLDER, "enc", "iv");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(unwrapRoomKey).not.toHaveBeenCalled();
    state.peers.set(HOLDER, PEER_KEY);
    announce.resolve();
    await offer;
    expect(state.roomKey).toEqual(new Uint8Array([7]));
  });

  it("applies offers strictly in delivery order", async () => {
    const { state, offers } = setup();
    const firstUnwrap = deferred<{ roomKey: Uint8Array; epoch: number }>();
    vi.mocked(unwrapRoomKey)
      .mockReturnValueOnce(firstUnwrap.promise)
      .mockResolvedValueOnce({ roomKey: new Uint8Array([2]), epoch: 2 });
    const first = offers.handleOffer(HOLDER, "a", "iv");
    const second = offers.handleOffer(HOLDER, "b", "iv");
    await vi.waitFor(() => expect(unwrapRoomKey).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The second offer has not started while the first is still unwrapping.
    expect(unwrapRoomKey).toHaveBeenCalledTimes(1);
    firstUnwrap.resolve({ roomKey: new Uint8Array([1]), epoch: 1 });
    await Promise.all([first, second]);
    expect(state.roomKey).toEqual(new Uint8Array([2]));
  });

  it("drops an offer whose sender left before its turn", async () => {
    const { state, offers } = setup();
    state.current = false;
    await offers.handleOffer(HOLDER, "enc", "iv");
    expect(unwrapRoomKey).not.toHaveBeenCalled();
  });
});

describe("E2EEOffer sending", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sendOfferPaced sends a voice_e2ee_offer", async () => {
    const { ws, offers } = setup();
    await expect(offers.sendOfferPaced(5, "enc", "iv")).resolves.toBe(true);
    expect(ws.send).toHaveBeenCalledWith({
      type: "voice_e2ee_offer",
      payload: { target_user_id: 5, encrypted_key: "enc", iv: "iv" },
    });
  });

  it("paces past 60 sends per window and re-checks staleness after the wait", async () => {
    vi.useFakeTimers();
    const { ws, offers } = setup();
    for (let i = 0; i < 60; i++) void offers.sendOfferPaced(i, "enc", "iv");
    expect(ws.send).toHaveBeenCalledTimes(60);
    const stale = offers.sendOfferPaced(60, "enc", "iv", () => true);
    const fresh = offers.sendOfferPaced(61, "enc", "iv", () => false);
    await vi.advanceTimersByTimeAsync(1_099);
    expect(ws.send).toHaveBeenCalledTimes(60);
    await vi.advanceTimersByTimeAsync(1);
    await expect(stale).resolves.toBe(false);
    await expect(fresh).resolves.toBe(true);
    expect(ws.send).toHaveBeenCalledTimes(61);
  });

  it("clearState resets the shared send budget", async () => {
    vi.useFakeTimers();
    const { ws, offers } = setup();
    for (let i = 0; i < 60; i++) void offers.sendOfferPaced(i, "enc", "iv");
    offers.clearState();
    await offers.sendOfferPaced(60, "enc", "iv");
    expect(ws.send).toHaveBeenCalledTimes(61);
  });

  it("distributeRoomKey wraps the key at the current epoch for each peer", async () => {
    const { state, ws, offers } = setup();
    const key = new Uint8Array([4]);
    state.roomKey = key;
    state.epoch = 2;
    await offers.distributeRoomKey(KEYPAIR, key, [
      [5, PEER_KEY],
      [6, PEER_KEY],
    ]);
    expect(sent(ws)).toEqual([
      { target_user_id: 5, encrypted_key: "enc:4@2", iv: "iv" },
      { target_user_id: 6, encrypted_key: "enc:4@2", iv: "iv" },
    ]);
  });

  it("distributeRoomKey stops once the room key or keypair changes", async () => {
    const { state, ws, offers } = setup();
    const key = new Uint8Array([4]);
    state.roomKey = key;
    vi.mocked(wrapRoomKey).mockImplementationOnce(async () => {
      state.roomKey = new Uint8Array([5]); // rotated during the first wrap
      return { encryptedKey: "stale", iv: "iv" };
    });
    await offers.distributeRoomKey(KEYPAIR, key, [
      [5, PEER_KEY],
      [6, PEER_KEY],
    ]);
    expect(ws.send).not.toHaveBeenCalled();
    state.roomKey = key;
    state.keypair = null;
    await offers.distributeRoomKey(KEYPAIR, key, [[5, PEER_KEY]]);
    expect(wrapRoomKey).toHaveBeenCalledTimes(1);
  });
});
