import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RingState } from "../../lib/voice/ringAnnounce";
import { createRingAnnouncer, type RingAnnouncer } from "./ringAnnouncer";

describe("ring announcer", () => {
  let call: object | null;
  let ring: RingState;
  /** Whether the next reports reach the server. */
  let online: boolean;
  /** What was reported, in order, with the call it went to. */
  let sent: Array<{ call: object | null; state: RingState }>;
  let announcer: RingAnnouncer;

  const states = (to: object | null = call): RingState[] =>
    sent.filter((report) => report.call === to).map((report) => report.state);

  /** Change the own ring, as the voice store's subscription would report it. */
  function setRing(next: RingState): void {
    ring = next;
    announcer.update();
  }

  beforeEach(() => {
    vi.useFakeTimers();
    call = {};
    ring = false;
    online = true;
    sent = [];
    announcer = createRingAnnouncer({
      getCall: () => call,
      getRing: () => ring,
      send: (state) => {
        if (online) sent.push({ call, state });
        return online;
      },
    });
  });
  afterEach(() => {
    setRing(null);
    vi.useRealTimers();
  });

  it("says nothing while the ring is dark and the call has heard nothing", () => {
    setRing(false);
    setRing(null);
    vi.advanceTimersByTime(5000);

    expect(sent).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports a lit ring at once", () => {
    setRing(true);

    expect(states()).toEqual([true]);
  });

  it("repeats a lit ring every second", () => {
    setRing(true);

    vi.advanceTimersByTime(3000);

    expect(states()).toEqual([true, true, true, true]);
  });

  it("reports the stop once and stops repeating", () => {
    setRing(true);
    vi.advanceTimersByTime(1000);

    setRing(false);
    vi.advanceTimersByTime(5000);

    expect(states()).toEqual([true, true, false]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports each change of a ring that flickers, in order", () => {
    setRing(true);
    setRing(false);
    setRing(true);
    setRing(false);

    expect(states()).toEqual([true, false, true, false]);
  });

  it("does not report a state the call already has", () => {
    setRing(true);
    announcer.update();
    setRing(false);
    announcer.update();

    expect(states()).toEqual([true, false]);
  });

  it("says so when the gate stops deciding after the call heard a verdict", () => {
    setRing(true);
    setRing(false);

    setRing(null);
    setRing(false);

    expect(states()).toEqual([true, false, null]);
  });

  describe("outside a call", () => {
    it("reports nothing and runs no timer", () => {
      call = null;

      setRing(true);
      vi.advanceTimersByTime(3000);

      expect(sent).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("stops repeating once the call is gone", () => {
      const first = call;
      setRing(true);

      call = null;
      vi.advanceTimersByTime(3000);

      expect(states(first)).toEqual([true]);
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  it("tells a new call afresh, at the next repeat", () => {
    const first = call;
    setRing(true);

    const second = {};
    call = second;
    vi.advanceTimersByTime(1000);

    expect(states(first)).toEqual([true]);
    expect(states(second)).toEqual([true]);
  });

  it("does not tell a new call about a ring that is dark", () => {
    setRing(true);
    call = {};

    setRing(false);

    expect(states()).toEqual([]);
  });

  describe("a report that could not be sent", () => {
    it("retries a lit ring at the next repeat", () => {
      online = false;
      setRing(true);
      expect(sent).toEqual([]);

      online = true;
      vi.advanceTimersByTime(1000);

      expect(states()).toEqual([true]);
    });

    it("sends a stop made while offline at the next update, with no timer of its own", () => {
      setRing(true);
      online = false;
      setRing(false);
      vi.advanceTimersByTime(3000);
      expect(vi.getTimerCount()).toBe(0);

      online = true;
      announcer.update();

      expect(states()).toEqual([true, false]);
    });

    it("sends nothing at that update when the ring went dark and lit again offline", () => {
      setRing(true);
      online = false;
      setRing(false);
      setRing(true);

      online = true;
      announcer.update();

      expect(states()).toEqual([true]);
    });
  });
});
