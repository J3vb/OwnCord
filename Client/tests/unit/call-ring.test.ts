import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRingController, createOutgoingCall, RING_TIMEOUT_MS } from "@lib/call-ring";
import type { RingState, OutgoingCallState } from "@lib/call-ring";

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
  const started: RingState[] = [];
  const missed: RingState[] = [];
  let pending: (() => void) | null = null;
  let pendingMs = 0;
  let cleared = 0;

  const ctrl = createRingController({
    onRingStateChange: (s) => states.push(s),
    onChime: (playing) => chimes.push(playing),
    onAccept: (id) => accepted.push(id),
    onDecline: (id) => declined.push(id),
    onRingStart: (s) => started.push(s),
    onMissed: (s) => missed.push(s),
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
    started,
    missed,
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

// DP-24: the callee who was away when the ring ran out learns about it. Only
// the timeout is a missed call: every other exit is the user (or the ringer)
// acting on the call, and a redial or a newer call is still a live ring.
describe("ring controller — missed call", () => {
  it("a ring that times out reports a missed call once, and an accepted, declined or ringer-left ring does not", () => {
    const timedOut = harness();
    timedOut.ctrl.incoming(ring(5));
    timedOut.fireTimeout();
    timedOut.fireTimeout();
    expect(timedOut.missed).toEqual([ring(5)]);

    const accepted = harness();
    accepted.ctrl.incoming(ring(5));
    accepted.ctrl.accept();
    accepted.fireTimeout();
    expect(accepted.missed).toEqual([]);

    const declined = harness();
    declined.ctrl.incoming(ring(5));
    declined.ctrl.decline();
    declined.fireTimeout();
    expect(declined.missed).toEqual([]);

    const ringerLeft = harness();
    ringerLeft.ctrl.incoming(ring(5));
    ringerLeft.ctrl.cancel(5, "ringer-left");
    ringerLeft.fireTimeout();
    expect(ringerLeft.missed).toEqual([]);
  });

  it("a redial or a newer call is not a missed call", () => {
    const h = harness();
    h.ctrl.incoming(ring(5));
    // A redial re-arms the window; only the last one running out is missed.
    h.ctrl.incoming(ring(5));
    // A call from another DM supersedes the first ring.
    h.ctrl.incoming(ring(6, 4));
    expect(h.missed).toEqual([]);
    h.fireTimeout();
    expect(h.missed).toEqual([ring(6, 4)]);
  });

  it("destroy is not a missed call", () => {
    const h = harness();
    h.ctrl.incoming(ring(5));
    h.ctrl.destroy();
    h.fireTimeout();
    expect(h.missed).toEqual([]);
  });
});

// The OS notification and the attention request fire once per ring, not once
// per call_incoming: a redial of a ring still on screen is the same call.
describe("ring controller — ring start", () => {
  it("reports a new ring once, not a redial of the same one", () => {
    const h = harness();
    h.ctrl.incoming(ring(5));
    h.ctrl.incoming(ring(5));
    expect(h.started).toEqual([ring(5)]);
  });

  it("reports a ring that supersedes another, and a ring after the last one ended", () => {
    const h = harness();
    h.ctrl.incoming(ring(5));
    h.ctrl.incoming(ring(6, 4));
    h.ctrl.decline();
    h.ctrl.incoming(ring(6, 4));
    expect(h.started).toEqual([ring(5), ring(6, 4), ring(6, 4)]);
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

// ---------------------------------------------------------------------------
// Outgoing call — the caller's side
// ---------------------------------------------------------------------------

function outgoingHarness() {
  const states: Array<OutgoingCallState | null> = [];
  let pending: (() => void) | null = null;
  let pendingMs = 0;
  let cleared = 0;
  const call = createOutgoingCall({
    onChange: (s) => states.push(s),
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
    call,
    states,
    fireTimeout: () => pending?.(),
    timerFn: () => pending,
    timerMs: () => pendingMs,
    armed: () => pending !== null,
    clearedCount: () => cleared,
  };
}

describe("outgoing call", () => {
  it("rings the callees and arms the same 30s window the callees ring for", () => {
    const h = outgoingHarness();
    h.call.start(5, [9]);

    expect(h.call.current()).toEqual({ channelId: 5, phase: "ringing", pending: [9] });
    expect(h.timerMs()).toBe(RING_TIMEOUT_MS);
  });

  it("moves to no-answer when the window runs out", () => {
    const h = outgoingHarness();
    h.call.start(5, [9]);
    h.fireTimeout();

    expect(h.call.current()?.phase).toBe("no-answer");
  });

  it("moves to declined when the only callee declines, and stops the timer", () => {
    const h = outgoingHarness();
    h.call.start(5, [9]);
    h.call.declined(5, 9);

    expect(h.call.current()).toEqual({ channelId: 5, phase: "declined", pending: [] });
    expect(h.armed()).toBe(false);
  });

  it("in a group, a decline only takes that callee off the list", () => {
    const h = outgoingHarness();
    h.call.start(5, [9, 10]);
    h.call.declined(5, 9);

    expect(h.call.current()).toEqual({ channelId: 5, phase: "ringing", pending: [10] });
    expect(h.armed()).toBe(true);

    h.call.declined(5, 10);
    expect(h.call.current()?.phase).toBe("declined");
  });

  it("ignores a decline for another channel or from someone not being rung", () => {
    const h = outgoingHarness();
    h.call.start(5, [9]);
    h.call.declined(6, 9);
    h.call.declined(5, 42);

    expect(h.call.current()?.phase).toBe("ringing");
    expect(h.states).toHaveLength(1);
  });

  it("a late timer firing after a decline changes nothing", () => {
    const h = outgoingHarness();
    h.call.start(5, [9]);
    const late = h.timerFn();
    h.call.declined(5, 9);
    late?.();

    expect(h.call.current()?.phase).toBe("declined");
  });

  it("Ring again restarts the window from a declined call", () => {
    const h = outgoingHarness();
    h.call.start(5, [9]);
    h.call.declined(5, 9);
    h.call.start(5, [9]);

    expect(h.call.current()).toEqual({ channelId: 5, phase: "ringing", pending: [9] });
    expect(h.armed()).toBe(true);
  });

  it("clear ends it and stops the timer; clearing twice reports once", () => {
    const h = outgoingHarness();
    h.call.start(5, [9]);
    h.call.clear();
    h.call.clear();

    expect(h.call.current()).toBeNull();
    expect(h.armed()).toBe(false);
    expect(h.states.filter((s) => s === null)).toHaveLength(1);
  });

  it("destroy is a clear", () => {
    const h = outgoingHarness();
    h.call.start(5, [9]);
    h.call.destroy();

    expect(h.call.current()).toBeNull();
    expect(h.armed()).toBe(false);
  });
});
