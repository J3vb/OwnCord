// The app's side of the speech worker: what it tells the worker at the start
// and when the "Let more soft speech through" setting changes, that a worker
// which takes no setting gets none, and that a stopped detection stops
// listening.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { savePref } from "../../lib/prefs/preferences";
import { expectConsole } from "../../../tests/helpers/console";
import { bindSpeechDetection } from "./sileroWorker";

type Listener = (event: { data?: unknown; message?: string }) => void;

class FakeWorker {
  static last: FakeWorker | undefined;
  readonly posted: unknown[] = [];
  readonly listeners = new Map<string, Listener>();
  terminated = false;
  constructor(
    readonly url: string,
    readonly options: unknown,
  ) {
    FakeWorker.last = this;
  }
  postMessage(message: unknown): void {
    this.posted.push(message);
  }
  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, listener);
  }
  terminate(): void {
    this.terminated = true;
  }
}

function startDetection() {
  const node = { port: { postMessage: vi.fn() } };
  const source = { connect: vi.fn() };
  const input = { source: { connect: vi.fn(), disconnect: vi.fn() }, setActive: vi.fn() };
  const setOn = vi.fn((on: boolean) => Promise.resolve(on));
  const setGate = bindSpeechDetection(node as never, source as never, setOn, input as never);
  setGate(true);
  const worker = FakeWorker.last;
  if (worker === undefined) throw new Error("No speech worker was started");
  /** The worker's "ready". A worker of this release says which setting it runs with. */
  const ready = (softSpeech?: boolean): void =>
    worker.listeners.get("message")?.({
      data: softSpeech === undefined ? { type: "ready" } : { type: "ready", softSpeech },
    });
  return { worker, setGate, setOn, input, node, ready };
}

describe("speech worker glue", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWorker.last = undefined;
    vi.stubGlobal("Worker", FakeWorker);
    vi.stubGlobal(
      "MessageChannel",
      class {
        port1 = { name: "worklet side" };
        port2 = { name: "worker side" };
      },
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("starts the worker with its port and the soft speech setting, on by default", () => {
    const { worker, setGate } = startDetection();
    expect(worker.url).toBe("/silero-vad-worker.js");
    expect(worker.options).toEqual({ type: "module" });
    expect(worker.posted).toEqual([{ port: { name: "worker side" }, softSpeech: true }]);
    setGate(false);
  });

  it("starts the worker with the setting the user saved", () => {
    savePref("softSpeech", false);
    const { worker, setGate } = startDetection();
    expect(worker.posted).toEqual([{ port: { name: "worker side" }, softSpeech: false }]);
    setGate(false);
  });

  it("tells a running worker when the setting changes, and nothing after it stopped", () => {
    const { worker, setGate, ready } = startDetection();
    ready(true);
    expect(worker.posted).toHaveLength(1);
    savePref("softSpeech", false);
    savePref("softSpeech", true);
    // Another preference is not the worker's business.
    savePref("sileroBufferMs", 120);
    expect(worker.posted.slice(1)).toEqual([{ softSpeech: false }, { softSpeech: true }]);

    setGate(false);
    expect(worker.terminated).toBe(true);
    savePref("softSpeech", false);
    expect(worker.posted).toHaveLength(3);
  });

  it("catches up when the setting changed while the models loaded", () => {
    const { worker, setGate, ready } = startDetection();
    savePref("softSpeech", false);
    // Nothing goes to a worker that has not said it takes a setting.
    expect(worker.posted).toHaveLength(1);

    ready(true);
    expect(worker.posted.slice(1)).toEqual([{ softSpeech: false }]);
    savePref("softSpeech", true);
    expect(worker.posted.slice(2)).toEqual([{ softSpeech: true }]);
    setGate(false);
  });

  it("sends no setting to a worker file from an older release, which would fail on it", () => {
    const { worker, setGate, setOn, input, ready } = startDetection();
    ready();
    savePref("softSpeech", false);
    savePref("softSpeech", true);
    expect(worker.posted).toHaveLength(1);
    // The older worker keeps running as it was.
    expect(worker.terminated).toBe(false);
    expect(input.setActive).toHaveBeenLastCalledWith(true);
    expect(setOn).not.toHaveBeenCalled();
    setGate(false);
  });

  it("stops listening for the setting when the worker fails", () => {
    const { worker, setOn, ready } = startDetection();
    ready(true);
    worker.listeners.get("message")?.({ data: { type: "error", message: "no model" } });
    expectConsole("warn", "Silero unavailable, using the RNNoise gate");
    expect(worker.terminated).toBe(true);
    expect(setOn).toHaveBeenCalledWith(true);

    savePref("softSpeech", false);
    expect(worker.posted).toHaveLength(1);
  });

  it("gives both model files six seconds, then falls back to the RNNoise gate", () => {
    const { worker, setOn, input } = startDetection();
    vi.advanceTimersByTime(5999);
    expect(worker.terminated).toBe(false);
    expect(setOn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expectConsole("warn", "model initialization timed out");
    expect(worker.terminated).toBe(true);
    expect(input.setActive).toHaveBeenLastCalledWith(false);
    expect(setOn).toHaveBeenCalledWith(true);
  });

  it("keeps the worker once it reports ready within that time", () => {
    const { worker, setGate, setOn, input, node, ready } = startDetection();
    vi.advanceTimersByTime(5999);
    ready(true);
    vi.advanceTimersByTime(60_000);
    expect(worker.terminated).toBe(false);
    expect(setOn).not.toHaveBeenCalled();
    expect(input.setActive).toHaveBeenLastCalledWith(true);
    expect(node.port.postMessage).toHaveBeenLastCalledWith({ type: "sileroReady" });
    setGate(false);
  });
});
