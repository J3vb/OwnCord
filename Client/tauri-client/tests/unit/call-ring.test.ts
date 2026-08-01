import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRingController, RING_TIMEOUT_MS } from "@lib/call-ring";
import type { RingState } from "@lib/call-ring";

/**
 * Statechart harness. The timer is injected rather than faked globally so a
 * test can fire the 30s timeout without also advancing every other timer in
 * the module graph.
 */
function harness() {
  const states: Array<RingState | null> = [];
  const chimes: boolean[] = [];
  const accepted: number[] = [];
  const declined: number[] = [];
  let pending: (() => void) | null = null;
  let pendingMs = 0;
  let cleared = 0;

  const ctrl = createRingController({
    onRingStateChange: (s) => states.push(s),
    onChime: (playing) => chimes.push(playing),
    onAccept: (id) => accepted.push(id),
    onDecline: (id) => declined.push(id),
    setTimer: (fn, ms) => {
      pending = fn;
      pendingMs = ms;
      return 1 as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: () => {
      cleared += 1;
      pending = null;
    },
  });

  return {
    ctrl,
    states,
    chimes,
    accepted,
    declined,
    fireTimeout: () => pending?.(),
    timerMs: () => pendingMs,
    clearedCount: () => cleared,
  };
}

const ring = (channelId = 5, fromUserId = 9): RingState => ({
  channelId,
  fromUserId,
  fromUsername: "alice",
});

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("ring controller — incoming", () => {
  it("starts ringing and reports the state", () => {
    const h = harness();
    h.ctrl.incoming(ring());

    expect(h.ctrl.current()).toEqual(ring());
    expect(h.states).toEqual([ring()]);
    expect(h.chimes).toEqual([true]);
  });

  it("arms the 30 second timeout", () => {
    const h = harness();
    h.ctrl.incoming(ring());
    expect(h.timerMs()).toBe(RING_TIMEOUT_MS);
  });

  // Two banners at once is two decisions the user did not ask to make; the
  // newer ring is the one they can still answer.
  it("replaces an existing ring for a different channel", () => {
    const h = harness();
    h.ctrl.incoming(ring(5));
    h.ctrl.incoming(ring(6));

    expect(h.ctrl.current()?.channelId).toBe(6);
    expect(h.states).toEqual([ring(5), null, ring(6)]);
    expect(h.chimes).toEqual([true, false, true]);
  });
});

describe("ring controller — accept", () => {
  it("joins the DM's voice channel and stops ringing", () => {
    const h = harness();
    h.ctrl.incoming(ring(5));
    h.ctrl.accept();

    expect(h.accepted).toEqual([5]);
    expect(h.declined).toEqual([]);
    expect(h.ctrl.current()).toBeNull();
    expect(h.chimes).toEqual([true, false]);
    expect(h.states).toEqual([ring(5), null]);
  });

  it("is a no-op when nothing is ringing", () => {
    const h = harness();
    h.ctrl.accept();
    expect(h.accepted).toEqual([]);
    expect(h.states).toEqual([]);
  });

  it("disarms the timeout", () => {
    const h = harness();
    h.ctrl.incoming(ring());
    h.ctrl.accept();
    expect(h.clearedCount()).toBeGreaterThan(0);
    // A late timeout must not re-fire the state change.
    h.fireTimeout();
    expect(h.states).toEqual([ring(), null]);
  });
});

describe("ring controller — decline", () => {
  it("tells the ringer and stops ringing", () => {
    const h = harness();
    h.ctrl.incoming(ring(5));
    h.ctrl.decline();

    expect(h.declined).toEqual([5]);
    expect(h.accepted).toEqual([]);
    expect(h.ctrl.current()).toBeNull();
    expect(h.chimes).toEqual([true, false]);
  });

  it("is a no-op when nothing is ringing", () => {
    const h = harness();
    h.ctrl.decline();
    expect(h.declined).toEqual([]);
  });
});

describe("ring controller — timeout", () => {
  it("stops ringing after 30 seconds", () => {
    const h = harness();
    h.ctrl.incoming(ring(5));
    h.fireTimeout();

    expect(h.ctrl.current()).toBeNull();
    expect(h.chimes).toEqual([true, false]);
    expect(h.states).toEqual([ring(5), null]);
  });

  // A timeout means "nobody was there", and the ringer's own 30s window
  // already covers it — sending a decline would claim a refusal that did not
  // happen.
  it("does not send a decline", () => {
    const h = harness();
    h.ctrl.incoming(ring(5));
    h.fireTimeout();
    expect(h.declined).toEqual([]);
  });
});

describe("ring controller — cancel (declined elsewhere / ringer left)", () => {
  it("stops ringing for the matching channel", () => {
    const h = harness();
    h.ctrl.incoming(ring(5));
    h.ctrl.cancel(5);

    expect(h.ctrl.current()).toBeNull();
    expect(h.chimes).toEqual([true, false]);
    // Cancel is not a refusal by this user, so nothing is sent back.
    expect(h.declined).toEqual([]);
    expect(h.accepted).toEqual([]);
  });

  // A stale signal for another conversation must not silence a live call.
  it("ignores a cancel for a different channel", () => {
    const h = harness();
    h.ctrl.incoming(ring(5));
    h.ctrl.cancel(6);

    expect(h.ctrl.current()?.channelId).toBe(5);
    expect(h.chimes).toEqual([true]);
  });

  it("is a no-op when nothing is ringing", () => {
    const h = harness();
    h.ctrl.cancel(5);
    expect(h.states).toEqual([]);
  });
});

describe("ring controller — destroy", () => {
  it("stops the chime and clears the banner", () => {
    const h = harness();
    h.ctrl.incoming(ring());
    h.ctrl.destroy();

    expect(h.ctrl.current()).toBeNull();
    expect(h.chimes).toEqual([true, false]);
    expect(h.states).toEqual([ring(), null]);
  });

  it("is safe with nothing ringing", () => {
    const h = harness();
    h.ctrl.destroy();
    expect(h.chimes).toEqual([]);
  });
});
