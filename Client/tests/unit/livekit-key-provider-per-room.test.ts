import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KeyProviderEvent, Room } from "livekit-client";
import { E2EEWorker } from "../../src/features/voice/e2eeWorker";

// The installed livekit-client: E2EEManager.setup subscribes the Room to its
// key provider and nothing ever unsubscribes it. A provider shared across
// Rooms would gain two listeners per join and keep every past Room alive.
function stubWorker(): Worker {
  return {
    onmessage: null,
    onerror: null,
    postMessage() {},
    terminate() {},
  } as unknown as Worker;
}

const CYCLES = 12;

describe("one E2EE key provider per Room", () => {
  // jsdom has no WebRTC; this is the global livekit feature-detects E2EE by.
  beforeEach(() => vi.stubGlobal("RTCRtpScriptTransform", class {}));
  afterEach(() => vi.unstubAllGlobals());

  it("keeps one Room's listeners on the live provider after many joins and leaves", async () => {
    const worker = new E2EEWorker({ getSessionGeneration: () => 0, getRoomKey: () => null });
    const used = new Set<unknown>();
    for (let i = 0; i < CYCLES; i++) {
      const keyProvider = worker.newKeyProvider();
      used.add(keyProvider);
      const room = new Room({ e2ee: { keyProvider, worker: stubWorker() } });
      expect(keyProvider.listenerCount(KeyProviderEvent.SetKey)).toBe(1);
      expect(keyProvider.listenerCount(KeyProviderEvent.RatchetRequest)).toBe(1);
      // oxlint-disable-next-line no-await-in-loop -- a leave finishes before the next join
      await room.disconnect();
      worker.releaseKeyProvider();
    }
    expect(used.size).toBe(CYCLES);
    expect(worker.keyProvider.listenerCount(KeyProviderEvent.SetKey)).toBe(0);
  });

  it("hands a connect retry's new provider the session's room key", async () => {
    const roomKey = new Uint8Array(32).fill(7);
    const worker = new E2EEWorker({ getSessionGeneration: () => 0, getRoomKey: () => roomKey });
    const first = worker.newKeyProvider();
    await worker.applyRoomKey(roomKey);
    expect(first.getKeys()).toHaveLength(1);

    const retry = worker.newKeyProvider();
    const room = new Room({ e2ee: { keyProvider: retry, worker: stubWorker() } });
    const forwarded = vi.fn();
    retry.on(KeyProviderEvent.SetKey, forwarded);

    await vi.waitFor(() => expect(retry.getKeys()).toHaveLength(1));
    expect(retry).not.toBe(first);
    expect(forwarded).toHaveBeenCalledOnce();
    await room.disconnect();
  });
});
