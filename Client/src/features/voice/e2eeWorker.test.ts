import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const setKey = vi.hoisted(() => vi.fn());
vi.mock("livekit-client", () => ({
  ExternalE2EEKeyProvider: vi.fn(function (this: { setKey: typeof setKey }) {
    this.setKey = setKey;
  }),
}));
vi.mock("../../lib/net/e2eeCrypto", () => ({
  roomKeyToBase64: (key: Uint8Array) => `b64:${key[0]}`,
}));

import { E2EEWorker, KEY_SWITCH_DELAY_MS } from "./e2eeWorker";
// vi.resetModules() below would hand the re-imported module a fresh logger,
// which re-installs the logger's app-lifetime pref-change listener on every
// reset. Those tests re-import against this already-loaded instance instead,
// so the singleton stays one.
import * as appLogger from "../../lib/logger";
import { captureLogs } from "../../../tests/helpers/log-capture";
import { expectConsole } from "../../../tests/helpers/console";

function setup() {
  const state = { generation: 0, roomKey: null as Uint8Array | null };
  const onKeyInstalled = vi.fn();
  const worker = new E2EEWorker({
    getSessionGeneration: () => state.generation,
    getRoomKey: () => state.roomKey,
    onKeyInstalled,
  });
  return { state, worker, onKeyInstalled };
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

  it("reports a key install only for a key still owned once it landed", async () => {
    const { state, worker, onKeyInstalled } = setup();
    state.roomKey = new Uint8Array([1]);
    await worker.applyRoomKey(state.roomKey);
    expect(onKeyInstalled).toHaveBeenCalledTimes(1);

    setKey.mockImplementationOnce(async () => {
      state.generation++;
    });
    await worker.applyRoomKey(state.roomKey);
    expect(onKeyInstalled).toHaveBeenCalledTimes(1);

    setKey.mockRejectedValueOnce(new Error("import failed"));
    await expect(worker.applyRoomKey(state.roomKey)).rejects.toThrow("import failed");
    expect(onKeyInstalled).toHaveBeenCalledTimes(1);
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
    const onKeyInstalled = vi.fn();
    const worker = new LinuxWorker({
      getSessionGeneration: () => 0,
      getRoomKey: () => roomKey,
      onKeyInstalled,
    });
    await expect(worker.applyRoomKey(roomKey)).resolves.toBe(true);
    expect(setRoomKey).toHaveBeenCalledWith("b64:9");
    expect(onKeyInstalled).toHaveBeenCalledTimes(1);
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

const KEY = new Uint8Array([5]);

async function loadWorker(linux: boolean) {
  vi.resetModules();
  vi.doMock("../../lib/logger", () => appLogger);
  vi.doMock("./native/platform", () => ({ isLinuxDesktop: () => linux }));
  const clearRoomKey = vi.fn(async () => undefined);
  const setRoomKey = vi.fn(async () => undefined);
  vi.doMock("../../platform/desktop", () => ({
    desktop: { nativeVoice: { setRoomKey, clearRoomKey } },
  }));
  const { E2EEWorker: LoadedWorker } = await import("./e2eeWorker");
  const worker = new LoadedWorker({ getSessionGeneration: () => 1, getRoomKey: () => KEY });
  return { worker, clearRoomKey, setRoomKey };
}

function unmock(): void {
  vi.doUnmock("./native/platform");
  vi.doUnmock("../../platform/desktop");
  vi.doUnmock("../../lib/logger");
}

describe("E2EEWorker.clearRoomKey backends", () => {
  it("leaves the native backend alone away from Linux", async () => {
    const { worker, clearRoomKey } = await loadWorker(false);
    worker.clearRoomKey();
    await Promise.resolve();
    await Promise.resolve();
    expect(clearRoomKey).not.toHaveBeenCalled();
    unmock();
  });

  it("logs a failed native clear and still installs the next key", async () => {
    const { worker, clearRoomKey, setRoomKey } = await loadWorker(true);
    const logs = captureLogs();
    clearRoomKey.mockRejectedValue(new Error("ipc closed"));
    worker.clearRoomKey();
    await expect(worker.applyRoomKey(KEY)).resolves.toBe(true);
    expect(setRoomKey).toHaveBeenCalledWith("b64:5");
    const entries = logs.find("native key clear failed");
    expect(entries).toHaveLength(1);
    expect(entries[0]?.level).toBe("warn");
    expect(entries[0]?.data).toMatchObject({ error: "ipc closed" });
    expectConsole("warn", "native key clear failed");
    unmock();
  });
});

function slotSetup() {
  const { state, worker, onKeyInstalled } = setup();
  const stageKey = vi.spyOn(worker.keyProvider, "stageKey").mockResolvedValue(undefined);
  const useKey = vi.spyOn(worker.keyProvider, "useKey").mockResolvedValue(undefined);
  const useSlot = vi.spyOn(worker.keyProvider, "useSlot").mockReturnValue(true);
  return { state, worker, onKeyInstalled, stageKey, useKey, useSlot };
}

describe("E2EEWorker key slots", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("stages a key in the free slot and sends with it only after the switch delay", async () => {
    const { state, worker, stageKey, useSlot } = slotSetup();
    state.roomKey = new Uint8Array([4]);
    await expect(
      worker.applyRoomKey(state.roomKey, undefined, { slot: 1, stage: true }),
    ).resolves.toBe(true);
    expect(stageKey).toHaveBeenCalledWith("b64:4", 1);
    expect(worker.sendSlot).toBe(0);

    await vi.advanceTimersByTimeAsync(KEY_SWITCH_DELAY_MS - 1);
    expect(useSlot).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(useSlot).toHaveBeenCalledWith(1);
    expect(worker.sendSlot).toBe(1);
  });

  it("a newer key before the switch replaces it, so the stale switch never fires", async () => {
    const { state, worker, useSlot } = slotSetup();
    state.roomKey = new Uint8Array([4]);
    await worker.applyRoomKey(state.roomKey, undefined, { slot: 1, stage: true });
    await vi.advanceTimersByTimeAsync(KEY_SWITCH_DELAY_MS / 2);

    state.roomKey = new Uint8Array([5]);
    await worker.applyRoomKey(state.roomKey, undefined, { slot: 1, stage: true });
    await vi.advanceTimersByTimeAsync(KEY_SWITCH_DELAY_MS / 2);
    expect(useSlot).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(KEY_SWITCH_DELAY_MS / 2);
    expect(useSlot).toHaveBeenCalledTimes(1);
  });

  it("drops the pending switch when the room key is no longer the session's", async () => {
    const { state, worker, useSlot } = slotSetup();
    state.roomKey = new Uint8Array([4]);
    await worker.applyRoomKey(state.roomKey, undefined, { slot: 1, stage: true });
    state.generation++;
    await vi.advanceTimersByTimeAsync(KEY_SWITCH_DELAY_MS);
    expect(useSlot).not.toHaveBeenCalled();
    expect(worker.sendSlot).toBe(0);
  });

  it("resetSlots cancels a pending switch", async () => {
    const { state, worker, useSlot } = slotSetup();
    state.roomKey = new Uint8Array([4]);
    await worker.applyRoomKey(state.roomKey, undefined, { slot: 1, stage: true });
    worker.resetSlots();
    await vi.advanceTimersByTimeAsync(KEY_SWITCH_DELAY_MS);
    expect(useSlot).not.toHaveBeenCalled();
  });

  it("staging into the slot being sent on is a switch at once", async () => {
    const { state, worker, stageKey, useKey } = slotSetup();
    state.roomKey = new Uint8Array([4]);
    await worker.applyRoomKey(state.roomKey, undefined, { slot: 0, stage: true });
    expect(stageKey).not.toHaveBeenCalled();
    expect(setKey).toHaveBeenCalledWith("b64:4");
    state.roomKey = new Uint8Array([6]);
    await worker.applyRoomKey(state.roomKey, undefined, { slot: 1, stage: false });
    expect(useKey).toHaveBeenCalledWith("b64:6", 1);
    expect(worker.sendSlot).toBe(1);
  });

  it("re-applies the current key at once in the slot it is in", async () => {
    const { state } = slotSetup();
    const placement = { slot: 1 as const, stage: true };
    const w = new E2EEWorker({
      getSessionGeneration: () => state.generation,
      getRoomKey: () => state.roomKey,
      getRoomKeyPlacement: () => placement,
    });
    const reuse = vi.spyOn(w.keyProvider, "useKey").mockResolvedValue(undefined);
    state.roomKey = new Uint8Array([8]);
    await w.applyCurrentRoomKey(() => true);
    expect(reuse).toHaveBeenCalledWith("b64:8", 1);
    expect(w.sendSlot).toBe(1);
  });
});

describe("E2EEWorker key slots on the Linux native backend", () => {
  it("stages over IPC and switches the native sender after the delay", async () => {
    vi.useFakeTimers();
    vi.resetModules();
    vi.doMock("../../lib/logger", () => appLogger);
    vi.doMock("./native/platform", () => ({ isLinuxDesktop: () => true }));
    const setRoomKey = vi.fn(async () => undefined);
    const useKeySlot = vi.fn(async () => undefined);
    vi.doMock("../../platform/desktop", () => ({
      desktop: { nativeVoice: { setRoomKey, useKeySlot } },
    }));
    const mod = await import("./e2eeWorker");
    const roomKey = new Uint8Array([3]);
    const worker = new mod.E2EEWorker({
      getSessionGeneration: () => 0,
      getRoomKey: () => roomKey,
    });
    await worker.applyRoomKey(roomKey, undefined, { slot: 1, stage: true });
    expect(setRoomKey).toHaveBeenCalledWith("b64:3", { slot: 1, stage: true });
    await vi.advanceTimersByTimeAsync(mod.KEY_SWITCH_DELAY_MS);
    expect(useKeySlot).toHaveBeenCalledWith(1);
    vi.doUnmock("./native/platform");
    vi.doUnmock("../../platform/desktop");
    vi.doUnmock("../../lib/logger");
    vi.useRealTimers();
  });
});
