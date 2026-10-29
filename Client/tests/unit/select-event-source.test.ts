import { afterEach, describe, expect, it, vi } from "vitest";
import { eventSource, select } from "../../src/lib/select";
import { createStore } from "../../src/lib/store";

let controllers: AbortController[] = [];
const ownedSignal = (): AbortSignal => {
  const ac = new AbortController();
  controllers.push(ac);
  return ac.signal;
};

afterEach(() => {
  for (const ac of controllers) ac.abort();
  controllers = [];
  vi.restoreAllMocks();
});

describe("eventSource ownership", () => {
  it("reads afresh while nothing is subscribed, after a subscription ended", () => {
    const read = vi.fn(() => 1);
    const src = eventSource("select-own-a", read);
    const ac = new AbortController();
    src.subscribe(() => {}, ac.signal);
    src.getState();
    src.getState();
    expect(read).toHaveBeenCalledTimes(1);
    ac.abort();
    src.getState();
    src.getState();
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("subscribing with a signal that is already aborted changes nothing", () => {
    const read = vi.fn(() => 1);
    const src = eventSource("select-own-b", read);
    const listener = vi.fn();
    const ac = new AbortController();
    ac.abort();
    const stop = src.subscribe(listener, ac.signal);
    window.dispatchEvent(new Event("select-own-b"));
    expect(listener).not.toHaveBeenCalled();
    expect(() => stop()).not.toThrow();
    src.getState();
    src.getState();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("refuses to subscribe without an owning signal", () => {
    const src = eventSource("select-own-c", () => 1);
    expect(() => src.subscribe(() => {})).toThrow("eventSource.subscribe needs an owning signal");
  });

  it("registers its window listener and abort hook on the owning signal, once", () => {
    const signal = ownedSignal();
    const onWindow = vi.spyOn(window, "addEventListener");
    const onSignal = vi.spyOn(signal, "addEventListener");
    const src = eventSource("select-own-d", () => 1);
    src.subscribe(() => {}, signal);
    expect(onWindow).toHaveBeenCalledWith("select-own-d", expect.any(Function), { signal });
    const hooks = onSignal.mock.calls.filter(
      ([type, fn]) => type === "abort" && (fn as { name?: string }).name === "stop",
    );
    expect(hooks).toHaveLength(1);
    expect(hooks[0]?.[2]).toEqual({ once: true });
  });

  it("lets go of the abort hook and the window listener when unsubscribed by hand", () => {
    const signal = ownedSignal();
    const listener = vi.fn();
    const src = eventSource("select-own-e", () => 1);
    const offSignal = vi.spyOn(signal, "removeEventListener");
    const offWindow = vi.spyOn(window, "removeEventListener");
    const stop = src.subscribe(listener, signal);
    stop();
    expect(offSignal).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(offWindow).toHaveBeenCalledWith("select-own-e", expect.any(Function));
    window.dispatchEvent(new Event("select-own-e"));
    expect(listener).not.toHaveBeenCalled();
    stop();
    expect(offWindow).toHaveBeenCalledTimes(1);
  });

  it("stops listening when the owning signal aborts", () => {
    const ac = new AbortController();
    const listener = vi.fn();
    const src = eventSource("select-own-f", () => 1);
    src.subscribe(listener, ac.signal);
    window.dispatchEvent(new Event("select-own-f"));
    expect(listener).toHaveBeenCalledTimes(1);
    ac.abort();
    window.dispatchEvent(new Event("select-own-f"));
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("select ownership", () => {
  it("hangs one self-removing abort hook on the owning signal", () => {
    const signal = ownedSignal();
    const onSignal = vi.spyOn(signal, "addEventListener");
    select(
      [createStore({ n: 1 })],
      (s) => s.n,
      () => {},
      { signal },
    );
    const aborts = onSignal.mock.calls.filter(([type]) => type === "abort");
    expect(aborts).toHaveLength(1);
    expect(aborts[0]?.[2]).toEqual({ once: true });
  });
});
