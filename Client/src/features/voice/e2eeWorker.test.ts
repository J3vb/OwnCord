import { describe, it, expect, vi, beforeEach } from "vitest";

const setKey = vi.hoisted(() => vi.fn());
vi.mock("livekit-client", () => ({
  ExternalE2EEKeyProvider: vi.fn(function (this: { setKey: typeof setKey }) {
    this.setKey = setKey;
  }),
}));
vi.mock("../../lib/e2eeCrypto", () => ({
  roomKeyToBase64: (key: Uint8Array) => `b64:${key[0]}`,
}));

import { E2EEWorker } from "./e2eeWorker";
// vi.resetModules() below would hand the re-imported module a fresh logger,
// which re-installs the logger's app-lifetime pref-change listener on every
// reset. Those tests re-import against this already-loaded instance instead,
// so the singleton stays one.
import * as appLogger from "../../lib/logger";

function setup() {
  const state = { generation: 0, roomKey: null as Uint8Array | null };
  const worker = new E2EEWorker({
    getSessionGeneration: () => state.generation,
    getRoomKey: () => state.roomKey,
  });
  return { state, worker };
}

function deferred() {
  const d = {} as { promise: Promise<void>; resolve: () => void };
  d.promise = new Promise<void>((resolve) => {
    d.resolve = resolve;
  });
  return d;
}

beforeEach(() => {
  setKey.mockReset();
  setKey.mockResolvedValue(undefined);
});

describe("E2EEWorker.applyRoomKey", () => {
  it("installs the current room key into the provider", async () => {
    const { state, worker } = setup();
    state.roomKey = new Uint8Array([1]);
    await expect(worker.applyRoomKey(state.roomKey)).resolves.toBe(true);
    expect(setKey).toHaveBeenCalledWith("b64:1");
  });

  it("skips a key superseded before its turn", async () => {
    const { state, worker } = setup();
    state.roomKey = new Uint8Array([2]);
    await expect(worker.applyRoomKey(new Uint8Array([1]))).resolves.toBe(false);
    expect(setKey).not.toHaveBeenCalled();
  });

  it("skips a key whose caller no longer owns it", async () => {
    const { state, worker } = setup();
    state.roomKey = new Uint8Array([1]);
    await expect(worker.applyRoomKey(state.roomKey, () => false)).resolves.toBe(false);
    expect(setKey).not.toHaveBeenCalled();
  });

  it("reports false when the session ended during the provider write", async () => {
    const { state, worker } = setup();
    state.roomKey = new Uint8Array([1]);
    setKey.mockImplementationOnce(async () => {
      state.generation++;
    });
    await expect(worker.applyRoomKey(state.roomKey)).resolves.toBe(false);
    expect(setKey).toHaveBeenCalledTimes(1);
  });

  it("serializes writes so a later key never lands before an earlier one", async () => {
    const { state, worker } = setup();
    const first = new Uint8Array([1]);
    const gate = deferred();
    setKey.mockImplementationOnce(() => gate.promise);
    state.roomKey = first;
    const a = worker.applyRoomKey(first);
    await Promise.resolve();
    const second = new Uint8Array([2]);
    state.roomKey = second;
    const b = worker.applyRoomKey(second);
    await Promise.resolve();
    expect(setKey).toHaveBeenCalledTimes(1);
    gate.resolve();
    await expect(a).resolves.toBe(false); // superseded by the second key while in flight
    await expect(b).resolves.toBe(true);
    expect(setKey.mock.calls.map((c) => c[0])).toEqual(["b64:1", "b64:2"]);
  });

  it("a failed import rejects its caller without blocking later writes", async () => {
    const { state, worker } = setup();
    state.roomKey = new Uint8Array([1]);
    setKey.mockRejectedValueOnce(new Error("import failed"));
    await expect(worker.applyRoomKey(state.roomKey)).rejects.toThrow("import failed");
    await expect(worker.applyRoomKey(state.roomKey)).resolves.toBe(true);
  });
});

describe("E2EEWorker.applyCurrentRoomKey", () => {
  it("does nothing without a room key or when not current", async () => {
    const { state, worker } = setup();
    await worker.applyCurrentRoomKey(() => true);
    state.roomKey = new Uint8Array([1]);
    await worker.applyCurrentRoomKey(() => false);
    expect(setKey).not.toHaveBeenCalled();
  });

  it("retries with the live key until one lands", async () => {
    const { state, worker } = setup();
    state.roomKey = new Uint8Array([1]);
    setKey.mockImplementationOnce(async () => {
      state.roomKey = new Uint8Array([2]); // a rotation replaced the key mid-write
    });
    await worker.applyCurrentRoomKey(() => true);
    expect(setKey.mock.calls.map((c) => c[0])).toEqual(["b64:1", "b64:2"]);
  });
});

describe("E2EEWorker.applyRoomKey on the Linux native backend", () => {
  it("sends the same base64 text to the native key provider, not the web one", async () => {
    vi.resetModules();
    vi.doMock("../../lib/logger", () => appLogger);
    vi.doMock("./native/platform", () => ({ isLinuxDesktop: () => true }));
    const setRoomKey = vi.fn(async () => undefined);
    vi.doMock("../../platform/desktop", () => ({ desktop: { nativeVoice: { setRoomKey } } }));
    const { E2EEWorker: LinuxWorker } = await import("./e2eeWorker");
    const roomKey = new Uint8Array([9]);
    const worker = new LinuxWorker({ getSessionGeneration: () => 0, getRoomKey: () => roomKey });
    await expect(worker.applyRoomKey(roomKey)).resolves.toBe(true);
    expect(setRoomKey).toHaveBeenCalledWith("b64:9");
    expect(setKey).not.toHaveBeenCalled();
    vi.doUnmock("./native/platform");
    vi.doUnmock("../../platform/desktop");
    vi.doUnmock("../../lib/logger");
  });
});

describe("E2EEWorker.clearRoomKey on the Linux native backend", () => {
  it("lands before the next session's key, even when the clear is slow", async () => {
    vi.resetModules();
    vi.doMock("../../lib/logger", () => appLogger);
    vi.doMock("./native/platform", () => ({ isLinuxDesktop: () => true }));
    const order: string[] = [];
    const clearing = deferred();
    const clearRoomKey = vi.fn(async () => {
      await clearing.promise;
      order.push("clear");
    });
    const setRoomKey = vi.fn(async (key: string) => {
      order.push(`set ${key}`);
    });
    vi.doMock("../../platform/desktop", () => ({
      desktop: { nativeVoice: { setRoomKey, clearRoomKey } },
    }));
    const { E2EEWorker: LinuxWorker } = await import("./e2eeWorker");
    const nextKey = new Uint8Array([7]);
    const worker = new LinuxWorker({ getSessionGeneration: () => 1, getRoomKey: () => nextKey });
    worker.clearRoomKey();
    const applied = worker.applyRoomKey(nextKey);
    await Promise.resolve();
    expect(setRoomKey).not.toHaveBeenCalled();
    clearing.resolve();
    await expect(applied).resolves.toBe(true);
    expect(order).toEqual(["clear", "set b64:7"]);
    vi.doUnmock("./native/platform");
    vi.doUnmock("../../platform/desktop");
    vi.doUnmock("../../lib/logger");
  });
});
