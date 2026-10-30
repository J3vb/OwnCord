import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRingController, createOutgoingCall, RING_TIMEOUT_MS } from "@lib/voice/callRing";
import type { RingEndReason, RingState, OutgoingCallState } from "@lib/voice/callRing";

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
  const ended: RingState[] = [];
  const endReasons: Array<RingEndReason | undefined> = [];
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
    onRingEnd: (s, reason) => {
      ended.push(s);
      endReasons.push(reason);
    },
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
    ended,
    endReasons,
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

describe("ring controller — end reasons (3B-4)", () => {
  it("reports superseded only when a ring from another channel replaces the current one", () => {
    const h = harness();
    h.ctrl.incoming(ring(5));
    h.ctrl.incoming(ring(5)); // a redial of the same channel is not a replacement
    expect(h.endReasons).toEqual([]);

    h.ctrl.incoming(ring(6));
    expect(h.ended).toEqual([ring(5)]);
    expect(h.endReasons).toEqual(["superseded"]);
    expect(h.missed).toEqual([]);
  });

  it("reports accepted, declined and timeout for the other exits", () => {
    const a = harness();
    a.ctrl.incoming(ring(5));
    a.ctrl.accept();
    const d = harness();
    d.ctrl.incoming(ring(5));
    d.ctrl.decline();
    const t = harness();
    t.ctrl.incoming(ring(5));
    t.fireTimeout();
    expect([a.endReasons, d.endReasons, t.endReasons]).toEqual([
      ["accepted"],
      ["declined"],
      ["timeout"],
    ]);
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
  it("a ring that times out or whose ringer left reports a missed call once; an accepted, declined or superseded ring does not", () => {
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
    expect(ringerLeft.missed).toEqual([ring(5)]);

    // A cancel that names no reason (a call_declined, or the room joined)
    // is not a miss either.
    const plainCancel = harness();
    plainCancel.ctrl.incoming(ring(5));
    plainCancel.ctrl.cancel(5);
    expect(plainCancel.missed).toEqual([]);
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

// D-13: the OS call notification is withdrawn however the ring ends.
describe("ring controller — ring end", () => {
  it("reports every ended ring once: accept, decline, timeout, cancel and a newer call", () => {
    const h = harness();
    h.ctrl.incoming(ring(5));
    h.ctrl.incoming(ring(5)); // a redial of the same ring is not an end
    h.ctrl.accept();
    h.ctrl.incoming(ring(6));
    h.ctrl.decline();
    h.ctrl.incoming(ring(7));
    h.fireTimeout();
    h.ctrl.incoming(ring(8));
    h.ctrl.cancel(8, "ringer-left");
    h.ctrl.incoming(ring(9));
    h.ctrl.incoming(ring(10, 4));
    h.ctrl.destroy();
    h.ctrl.decline(); // nothing is ringing: no end

    expect(h.ended.map((r) => r.channelId)).toEqual([5, 6, 7, 8, 9, 10]);
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
  const ringbacks: boolean[] = [];
  let pending: (() => void) | null = null;
  let pendingMs = 0;
  let cleared = 0;
  const call = createOutgoingCall({
    onChange: (s) => states.push(s),
    onRingback: (playing) => ringbacks.push(playing),
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
    ringbacks,
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

  it("a call to an offline 1:1 contact is offline at once, with no window and no ringback", () => {
    const h = outgoingHarness();
    h.call.start(5, [9], true);

    expect(h.call.current()).toEqual({ channelId: 5, phase: "offline", pending: [9] });
    expect(h.armed()).toBe(false);
    expect(h.ringbacks).toEqual([]);

    // Ring again once they are back rings as usual.
    h.call.start(5, [9]);
    expect(h.call.current()?.phase).toBe("ringing");
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

// DP-25: the caller hears a ringback while the callee's phone rings, and it
// stops the moment the ring ends — whichever way it ends.
describe("outgoing call — ringback", () => {
  it("starts on ringing and stops on declined", () => {
    const h = outgoingHarness();
    h.call.start(5, [9]);
    expect(h.ringbacks).toEqual([true]);

    h.call.declined(5, 9);
    expect(h.ringbacks).toEqual([true, false]);
  });

  it("stops on no-answer when the window runs out", () => {
    const h = outgoingHarness();
    h.call.start(5, [9]);
    h.fireTimeout();

    expect(h.call.current()?.phase).toBe("no-answer");
    expect(h.ringbacks).toEqual([true, false]);
  });

  it("stops on clear and destroy, and neither plays after clear", () => {
    const cleared = outgoingHarness();
    cleared.call.start(5, [9]);
    cleared.call.clear();
    cleared.call.clear();
    cleared.fireTimeout();
    expect(cleared.ringbacks).toEqual([true, false]);

    const destroyed = outgoingHarness();
    destroyed.call.start(5, [9]);
    destroyed.call.destroy();
    destroyed.fireTimeout();
    expect(destroyed.ringbacks).toEqual([true, false]);
  });

  it("a group decline keeps ringing until the last callee declines", () => {
    const h = outgoingHarness();
    h.call.start(5, [9, 10]);
    h.call.declined(5, 9);
    // Still ringing for 10: the ringback must not stop on the first decline.
    expect(h.ringbacks).toEqual([true]);

    h.call.declined(5, 10);
    expect(h.ringbacks).toEqual([true, false]);
  });

  it("a redial restarts the ringback", () => {
    const h = outgoingHarness();
    h.call.start(5, [9]);
    h.call.declined(5, 9);
    h.call.start(5, [9]);

    expect(h.ringbacks).toEqual([true, false, true]);
  });
});

describe("outgoing call — restart and late declines", () => {
  it("a second start clears the first window before arming its own", () => {
    const h = outgoingHarness();
    h.call.start(5, [9]);
    expect(h.clearedCount()).toBe(0);
    h.call.start(6, [9]);

    expect(h.clearedCount()).toBe(1);
    expect(h.call.current()).toEqual({ channelId: 6, phase: "ringing", pending: [9] });
  });

  it("a decline that arrives after the window ran out changes nothing", () => {
    const h = outgoingHarness();
    h.call.start(5, [8, 9]);
    h.fireTimeout();
    expect(h.call.current()?.phase).toBe("no-answer");
    const changes = h.states.length;

    h.call.declined(5, 9);

    expect(h.call.current()).toEqual({ channelId: 5, phase: "no-answer", pending: [8, 9] });
    expect(h.states).toHaveLength(changes);
  });

  it("a decline for an offline 1:1 changes nothing", () => {
    const h = outgoingHarness();
    h.call.start(5, [9], true);
    h.call.declined(5, 9);
    expect(h.call.current()).toEqual({ channelId: 5, phase: "offline", pending: [9] });
  });
});

describe("call timers without an injected clock", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("an answered ring never times out afterwards", () => {
    const ended: Array<RingEndReason | undefined> = [];
    const missed: RingState[] = [];
    const ctrl = createRingController({
      onRingStateChange: () => {},
      onChime: () => {},
      onAccept: () => {},
      onDecline: () => {},
      onMissed: (s) => missed.push(s),
      onRingEnd: (_s, reason) => ended.push(reason),
    });
    ctrl.incoming(ring());
    ctrl.accept();
    vi.advanceTimersByTime(RING_TIMEOUT_MS * 2);

    expect(ended).toEqual(["accepted"]);
    expect(missed).toEqual([]);
  });

  it("a ring that nobody answers times out after the window", () => {
    const missed: RingState[] = [];
    const ctrl = createRingController({
      onRingStateChange: () => {},
      onChime: () => {},
      onAccept: () => {},
      onDecline: () => {},
      onMissed: (s) => missed.push(s),
    });
    ctrl.incoming(ring());
    vi.advanceTimersByTime(RING_TIMEOUT_MS - 1);
    expect(missed).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(missed).toEqual([ring()]);
    expect(ctrl.current()).toBeNull();
  });

  it("a cleared outgoing call never reports no-answer afterwards", () => {
    const states: Array<OutgoingCallState | null> = [];
    const call = createOutgoingCall({ onChange: (s) => states.push(s) });
    call.start(5, [9]);
    call.clear();
    vi.advanceTimersByTime(RING_TIMEOUT_MS * 2);

    expect(states.map((s) => s?.phase ?? null)).toEqual(["ringing", null]);
  });

  it("a redialled ring keeps ringing for a full window from the redial", () => {
    const ended: Array<RingEndReason | undefined> = [];
    const ctrl = createRingController({
      onRingStateChange: () => {},
      onChime: () => {},
      onAccept: () => {},
      onDecline: () => {},
      onRingEnd: (_s, reason) => ended.push(reason),
    });
    ctrl.incoming(ring());
    vi.advanceTimersByTime(20_000);
    ctrl.incoming(ring());
    vi.advanceTimersByTime(20_000);
    expect(ended).toEqual([]);
    expect(ctrl.current()).not.toBeNull();
    vi.advanceTimersByTime(10_000);
    expect(ended).toEqual(["timeout"]);
  });

  it("a restarted outgoing call waits a full window from the restart", () => {
    const call = createOutgoingCall({ onChange: () => {} });
    call.start(5, [9]);
    vi.advanceTimersByTime(20_000);
    call.start(5, [9]);
    vi.advanceTimersByTime(20_000);
    expect(call.current()?.phase).toBe("ringing");
    vi.advanceTimersByTime(10_000);
    expect(call.current()?.phase).toBe("no-answer");
  });

  it("an unanswered outgoing call reports no-answer after the window", () => {
    const call = createOutgoingCall({ onChange: () => {} });
    call.start(5, [9]);
    vi.advanceTimersByTime(RING_TIMEOUT_MS);
    expect(call.current()?.phase).toBe("no-answer");
  });
});
