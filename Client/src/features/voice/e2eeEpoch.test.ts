import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../lib/e2eeCrypto", () => ({
  generateRoomKey: vi.fn(() => new Uint8Array([9])),
}));
const log = vi.hoisted(() => ({
  tags: [] as string[],
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));
vi.mock("../../lib/logger", () => ({
  createLogger: (tag: string) => {
    log.tags.push(tag);
    return log;
  },
}));

import { E2EEEpoch } from "./e2eeEpoch";

const KEYPAIR = { privateKey: "priv", publicKey: "pub" } as unknown as CryptoKeyPair;
const ROTATION_MS = 5 * 60 * 1000;

function setup() {
  const state = {
    keyHolder: true,
    channelId: 1 as number | null,
    currentChannelId: null as number | null,
    generation: 0,
    keypair: KEYPAIR as CryptoKeyPair | null,
    peers: new Map<number, CryptoKey>([[2, "peer" as unknown as CryptoKey]]),
  };
  const host = {
    isKeyHolder: () => state.keyHolder,
    getChannelId: () => state.channelId,
    getCurrentChannelId: () => state.currentChannelId,
    getSessionGeneration: () => state.generation,
    getEcdhKeyPair: () => state.keypair,
    getPeerPublicKeys: () => state.peers,
    applyRoomKey: vi.fn(async (_roomKey: Uint8Array) => true),
    distributeRoomKey: vi.fn(
      async (_k: CryptoKeyPair, _r: Uint8Array, _p: Iterable<[number, CryptoKey]>) => {},
    ),
  };
  return { state, host, epoch: new E2EEEpoch(host) };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("E2EEEpoch state", () => {
  it("starts at epoch 0 with no room key, flags down and no high-water marks", () => {
    const { epoch } = setup();
    expect(epoch.epoch).toBe(0);
    expect(epoch.roomKey).toBeNull();
    expect(epoch.rotatingKey).toBe(false);
    expect(epoch.rotationPending).toBe(false);
    expect(epoch.peerOfferEpochs.size).toBe(0);
  });

  it("exposes its fields for the manager to write", () => {
    const { epoch } = setup();
    const key = new Uint8Array([1]);
    epoch.roomKey = key;
    epoch.epoch = 4;
    epoch.rotatingKey = true;
    epoch.rotationPending = true;
    expect([epoch.roomKey, epoch.epoch, epoch.rotatingKey, epoch.rotationPending]).toEqual([
      key,
      4,
      true,
      true,
    ]);
  });
});

describe("rotateRoomKey", () => {
  it("advances the epoch and installs a fresh key", async () => {
    const { epoch, host } = setup();
    const key = await epoch.rotateRoomKey();
    expect(key).toEqual(new Uint8Array([9]));
    expect(epoch.epoch).toBe(1);
    expect(epoch.roomKey).toBe(key);
    expect(host.applyRoomKey).toHaveBeenCalledWith(key);
  });

  it("returns null when the provider write was superseded", async () => {
    const { epoch, host } = setup();
    host.applyRoomKey.mockResolvedValueOnce(false);
    await expect(epoch.rotateRoomKey()).resolves.toBeNull();
  });
});

describe("rotateKeyPeriodically", () => {
  it("rotates, distributes to the live peer map and re-arms the timer", async () => {
    const { epoch, host, state } = setup();
    await epoch.rotateKeyPeriodically();
    expect(epoch.epoch).toBe(1);
    expect(host.distributeRoomKey).toHaveBeenCalledWith(KEYPAIR, epoch.roomKey, state.peers);
    expect(epoch.rotatingKey).toBe(false);
    await vi.advanceTimersByTimeAsync(ROTATION_MS);
    expect(epoch.epoch).toBe(2);
  });

  it("does nothing unless this client holds the key", async () => {
    const { epoch, state } = setup();
    state.keyHolder = false;
    await epoch.rotateKeyPeriodically();
    expect(epoch.epoch).toBe(0);
  });

  it("does nothing while another rotation is in flight", async () => {
    const { epoch } = setup();
    epoch.rotatingKey = true;
    await epoch.rotateKeyPeriodically();
    expect(epoch.epoch).toBe(0);
  });

  it("falls back to the facade's channel and does nothing with neither", async () => {
    const { epoch, state } = setup();
    state.channelId = null;
    await epoch.rotateKeyPeriodically();
    expect(epoch.epoch).toBe(0);
    state.currentChannelId = 3;
    await epoch.rotateKeyPeriodically();
    expect(epoch.epoch).toBe(1);
  });

  it("skips distribution without an ECDH keypair", async () => {
    const { epoch, host, state } = setup();
    state.keypair = null;
    await epoch.rotateKeyPeriodically();
    expect(host.distributeRoomKey).not.toHaveBeenCalled();
    expect(epoch.epoch).toBe(1);
  });

  it("stops after a superseded provider write, then re-arms", async () => {
    const { epoch, host } = setup();
    host.applyRoomKey.mockResolvedValueOnce(false);
    await epoch.rotateKeyPeriodically();
    expect(host.distributeRoomKey).not.toHaveBeenCalled();
    expect(epoch.rotatingKey).toBe(false);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("survives a failed distribution and still re-arms", async () => {
    const { epoch, host } = setup();
    host.distributeRoomKey.mockRejectedValueOnce(new Error("wrap"));
    await epoch.rotateKeyPeriodically();
    expect(epoch.rotatingKey).toBe(false);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("leaves the flags to a session that superseded this rotation", async () => {
    const { epoch, host, state } = setup();
    host.applyRoomKey.mockImplementationOnce(async () => {
      state.generation++;
      return true;
    });
    await epoch.rotateKeyPeriodically();
    expect(epoch.rotatingKey).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("runs a deferred rotation instead of arming the timer", async () => {
    const { epoch, host } = setup();
    host.applyRoomKey.mockImplementationOnce(async () => {
      epoch.rotationPending = true;
      return true;
    });
    await epoch.rotateKeyPeriodically();
    expect(epoch.epoch).toBe(2);
    expect(epoch.rotationPending).toBe(false);
    expect(host.distributeRoomKey).toHaveBeenCalledTimes(2);
  });
});

describe("rotation timer", () => {
  it("is not armed for a non-holder", () => {
    const { epoch, state } = setup();
    state.keyHolder = false;
    epoch.startKeyRotationTimer();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("fires one rotation after the interval, not before", async () => {
    const { epoch } = setup();
    epoch.startKeyRotationTimer();
    await vi.advanceTimersByTimeAsync(ROTATION_MS - 1);
    expect(epoch.epoch).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(epoch.epoch).toBe(1);
  });

  it("re-arming replaces the pending timer", () => {
    const { epoch } = setup();
    epoch.startKeyRotationTimer();
    epoch.startKeyRotationTimer();
    expect(vi.getTimerCount()).toBe(1);
  });

  it("clearKeyRotationTimer cancels it", async () => {
    const { epoch } = setup();
    epoch.startKeyRotationTimer();
    epoch.clearKeyRotationTimer();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(ROTATION_MS);
    expect(epoch.epoch).toBe(0);
  });
});

describe("rotation diagnostics", () => {
  it("logs the interval when the timer is armed", () => {
    const { epoch } = setup();
    epoch.startKeyRotationTimer();
    expect(log.debug).toHaveBeenCalledWith("E2EE: key rotation timer started", {
      intervalMs: ROTATION_MS,
    });
  });

  it("logs the channel and epoch of a periodic rotation and the peers it reached", async () => {
    const { epoch } = setup();
    await epoch.rotateKeyPeriodically();
    expect(log.info).toHaveBeenCalledWith("E2EE: periodic key rotation", {
      channelId: 1,
      epoch: 1,
    });
    expect(log.info).toHaveBeenCalledWith("E2EE: distributed periodically rotated key", {
      peerCount: 1,
    });
  });

  it("logs a failed rotation with its error", async () => {
    const { epoch, host } = setup();
    const failure = new Error("wrap");
    host.distributeRoomKey.mockRejectedValueOnce(failure);
    await epoch.rotateKeyPeriodically();
    expect(log.error).toHaveBeenCalledWith("E2EE: periodic key rotation failed", failure);
    expect(log.info).not.toHaveBeenCalledWith(
      "E2EE: distributed periodically rotated key",
      expect.anything(),
    );
  });

  it("stays quiet when a superseded rotation stops early", async () => {
    const { epoch, host } = setup();
    host.applyRoomKey.mockResolvedValueOnce(false);
    await epoch.rotateKeyPeriodically();
    expect(log.info).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
  });
});

describe("log tag", () => {
  it("keeps the E2EE log lines under their original tag", () => {
    expect(log.tags).toContain("livekitE2EE");
  });
});
