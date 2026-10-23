import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startGameActivity, GAME_ACTIVITY_POLL_MS, type GameActivityLoop } from "@lib/gameActivity";
import { handleActivityRefusal, GAME_ACTIVITY_PREF_KEY } from "@lib/gameActivityBridge";
import { savePref } from "@lib/preferences";
import type { ConnectionState } from "@lib/ws";
import type { DetectedGame } from "../../src/platform/contracts/gameDetector";

/**
 * The loop sends `activity_update` only on change, clears when the game goes,
 * retries a refused frame, starts over on every connection and drops a
 * detection that began under an older connection.
 */

const factorio: DetectedGame = {
  name: "Factorio",
  source: "steam",
  startedAtMs: 1_761_206_400_000,
};
const valorant: DetectedGame = { name: "VALORANT", source: "list", startedAtMs: 1_761_206_500_000 };

interface Sent {
  readonly id: string;
  readonly activity: { name: string; started_at: number } | null;
}

function fakeWs(initial: ConnectionState = "connected") {
  let state: ConnectionState = initial;
  let nextId = 1;
  const sent: Sent[] = [];
  const stateListeners = new Set<(s: ConnectionState) => void>();
  const readyListeners = new Set<() => void>();
  const ws = {
    getState: () => state,
    send: vi.fn((msg: { type: string; payload: { activity: Sent["activity"] } }) => {
      expect(msg.type).toBe("activity_update");
      const id = `id-${nextId++}`;
      sent.push({ id, activity: msg.payload.activity });
      return id;
    }),
    onStateChange: (fn: (s: ConnectionState) => void) => {
      stateListeners.add(fn);
      return () => stateListeners.delete(fn);
    },
    on: (type: string, fn: () => void) => {
      expect(type).toBe("ready");
      readyListeners.add(fn);
      return () => readyListeners.delete(fn);
    },
  };
  return {
    ws: ws as never,
    sent,
    setState(next: ConnectionState): void {
      state = next;
      for (const fn of stateListeners) fn(next);
    },
    ready(): void {
      for (const fn of readyListeners) fn();
    },
  };
}

/** Let promise continuations run. */
async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

describe("game activity loop", () => {
  let loop: GameActivityLoop | null = null;
  let current: DetectedGame | null;
  let supported: boolean;
  let enabled: boolean;
  const detect = vi.fn(async () => current);

  function start(fake: ReturnType<typeof fakeWs>) {
    loop = startGameActivity({
      ws: fake.ws,
      detect,
      enabled: () => enabled,
      supported: () => supported,
    });
    return loop;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    current = null;
    supported = true;
    enabled = true;
    detect.mockClear();
    detect.mockImplementation(async () => current);
  });

  afterEach(() => {
    loop?.destroy();
    loop = null;
    vi.useRealTimers();
  });

  it("sends the game once and stays quiet while it does not change", async () => {
    const fake = fakeWs();
    current = factorio;
    start(fake);
    await flush();
    expect(fake.sent.map((s) => s.activity)).toEqual([
      { name: "Factorio", started_at: 1_761_206_400_000 },
    ]);

    await vi.advanceTimersByTimeAsync(GAME_ACTIVITY_POLL_MS * 3);
    expect(detect.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(fake.sent).toHaveLength(1);
  });

  it("sends nothing while no game runs", async () => {
    const fake = fakeWs();
    start(fake);
    await vi.advanceTimersByTimeAsync(GAME_ACTIVITY_POLL_MS * 2);
    expect(fake.sent).toHaveLength(0);
  });

  it("sends a change of game, then null when the game exits", async () => {
    const fake = fakeWs();
    current = factorio;
    start(fake);
    await flush();
    current = valorant;
    await vi.advanceTimersByTimeAsync(GAME_ACTIVITY_POLL_MS);
    current = null;
    await vi.advanceTimersByTimeAsync(GAME_ACTIVITY_POLL_MS);
    expect(fake.sent.map((s) => s.activity?.name ?? null)).toEqual(["Factorio", "VALORANT", null]);
    // Cleared once: further quiet polls send nothing more.
    await vi.advanceTimersByTimeAsync(GAME_ACTIVITY_POLL_MS * 2);
    expect(fake.sent).toHaveLength(3);
  });

  it("cuts a very long name at the server's limit by whole characters", async () => {
    const fake = fakeWs();
    current = { ...factorio, name: `  ${"é".repeat(200)}  ` };
    start(fake);
    await flush();
    expect(Array.from(fake.sent[0]?.activity?.name ?? "")).toHaveLength(128);
  });

  it("sends nothing and scans nothing when the server lacks game_activity", async () => {
    const fake = fakeWs();
    supported = false;
    current = factorio;
    start(fake);
    await vi.advanceTimersByTimeAsync(GAME_ACTIVITY_POLL_MS * 2);
    expect(detect).not.toHaveBeenCalled();
    expect(fake.sent).toHaveLength(0);
  });

  it("sends nothing and scans nothing while the setting is off", async () => {
    const fake = fakeWs();
    enabled = false;
    current = factorio;
    start(fake);
    await vi.advanceTimersByTimeAsync(GAME_ACTIVITY_POLL_MS * 2);
    expect(detect).not.toHaveBeenCalled();
    expect(fake.sent).toHaveLength(0);
  });

  it("learns the capability from ready on a first connect", async () => {
    const fake = fakeWs();
    supported = false;
    current = factorio;
    start(fake);
    await flush();
    expect(fake.sent).toHaveLength(0);
    supported = true;
    fake.ready();
    await flush();
    expect(fake.sent.map((s) => s.activity?.name)).toEqual(["Factorio"]);
  });

  it("sends null at once when the setting is turned off, and stops scanning", async () => {
    const fake = fakeWs();
    current = factorio;
    start(fake);
    await flush();
    expect(fake.sent).toHaveLength(1);

    enabled = false;
    savePref(GAME_ACTIVITY_PREF_KEY, false);
    // At once: no timer has advanced.
    expect(fake.sent.map((s) => s.activity)).toEqual([
      { name: "Factorio", started_at: 1_761_206_400_000 },
      null,
    ]);
    detect.mockClear();
    await vi.advanceTimersByTimeAsync(GAME_ACTIVITY_POLL_MS * 2);
    expect(detect).not.toHaveBeenCalled();
    expect(fake.sent).toHaveLength(2);
  });

  it("does not send a clear for a setting change when nothing was shown", async () => {
    const fake = fakeWs();
    start(fake);
    await flush();
    enabled = false;
    savePref(GAME_ACTIVITY_PREF_KEY, false);
    expect(fake.sent).toHaveLength(0);
  });

  it("looks right away when the setting is turned back on", async () => {
    const fake = fakeWs();
    enabled = false;
    current = factorio;
    start(fake);
    await flush();
    enabled = true;
    savePref(GAME_ACTIVITY_PREF_KEY, true);
    await flush();
    expect(fake.sent.map((s) => s.activity?.name)).toEqual(["Factorio"]);
  });

  it("forgets a RATE_LIMITED set and sends again on the next poll", async () => {
    const fake = fakeWs();
    current = factorio;
    start(fake);
    await flush();
    const first = fake.sent[0]!;
    // The dispatcher routes the refusal here; the loop claims it (no toast).
    expect(handleActivityRefusal("RATE_LIMITED", first.id)).toBe(true);

    await vi.advanceTimersByTimeAsync(GAME_ACTIVITY_POLL_MS);
    expect(fake.sent).toHaveLength(2);
    expect(fake.sent[1]?.activity?.name).toBe("Factorio");
  });

  it("sends again after the server's per-frame deadline refused the set", async () => {
    const fake = fakeWs();
    current = factorio;
    start(fake);
    await flush();
    expect(handleActivityRefusal("REQUEST_TIMEOUT", fake.sent[0]!.id)).toBe(true);

    await vi.advanceTimersByTimeAsync(GAME_ACTIVITY_POLL_MS);
    expect(fake.sent.map((s) => s.activity?.name)).toEqual(["Factorio", "Factorio"]);
  });

  it("after a refused set, sends null if the game is gone by the retry", async () => {
    const fake = fakeWs();
    current = factorio;
    start(fake);
    await flush();
    handleActivityRefusal("RATE_LIMITED", fake.sent[0]!.id);
    current = null;
    await vi.advanceTimersByTimeAsync(GAME_ACTIVITY_POLL_MS);
    expect(fake.sent.map((s) => s.activity?.name ?? null)).toEqual(["Factorio", null]);
  });

  it("claims only its own frames' refusals", async () => {
    const fake = fakeWs();
    current = factorio;
    start(fake);
    await flush();
    expect(handleActivityRefusal("RATE_LIMITED", "some-other-frame")).toBe(false);
    expect(handleActivityRefusal("RATE_LIMITED", undefined)).toBe(false);
    // Nothing was forgotten, so nothing is re-sent.
    await vi.advanceTimersByTimeAsync(GAME_ACTIVITY_POLL_MS);
    expect(fake.sent).toHaveLength(1);
  });

  it("leaves a BAD_REQUEST name alone instead of retrying it every poll", async () => {
    const fake = fakeWs();
    current = factorio;
    start(fake);
    await flush();
    expect(handleActivityRefusal("BAD_REQUEST", fake.sent[0]!.id)).toBe(true);
    await vi.advanceTimersByTimeAsync(GAME_ACTIVITY_POLL_MS * 2);
    expect(fake.sent).toHaveLength(1);
  });

  it("re-sends the current game after every reconnect", async () => {
    const fake = fakeWs();
    current = factorio;
    start(fake);
    await flush();
    expect(fake.sent).toHaveLength(1);

    fake.setState("reconnecting");
    await vi.advanceTimersByTimeAsync(GAME_ACTIVITY_POLL_MS);
    expect(detect.mock.calls.length).toBe(1); // nothing is scanned or sent while down
    expect(fake.sent).toHaveLength(1);

    fake.setState("connected");
    await flush();
    expect(fake.sent.map((s) => s.activity?.name)).toEqual(["Factorio", "Factorio"]);
  });

  it("drops a detection that began under an earlier connection", async () => {
    const fake = fakeWs();
    let release: (g: DetectedGame | null) => void = () => {};
    detect.mockImplementationOnce(
      () =>
        new Promise<DetectedGame | null>((resolve) => {
          release = resolve;
        }),
    );
    start(fake);
    await flush();
    // The scan is still running when the connection drops and comes back.
    fake.setState("reconnecting");
    // The new connection's own scan runs beside the old one and sees VALORANT.
    current = valorant;
    fake.setState("connected");
    await flush();
    expect(fake.sent.map((s) => s.activity?.name)).toEqual(["VALORANT"]);
    // The old scan answers late: its Factorio is for a connection that is gone.
    release(factorio);
    await flush();
    expect(fake.sent.map((s) => s.activity?.name)).toEqual(["VALORANT"]);
  });

  it("treats a rejected scan as no game", async () => {
    const fake = fakeWs();
    current = factorio;
    start(fake);
    await flush();
    expect(fake.sent).toHaveLength(1);
    detect.mockImplementation(async () => {
      throw new Error("boom");
    });
    await vi.advanceTimersByTimeAsync(GAME_ACTIVITY_POLL_MS);
    expect(fake.sent.map((s) => s.activity?.name ?? null)).toEqual(["Factorio", null]);
  });

  it("does not send while the socket is down", async () => {
    const fake = fakeWs("reconnecting");
    current = factorio;
    start(fake);
    await vi.advanceTimersByTimeAsync(GAME_ACTIVITY_POLL_MS * 2);
    expect(fake.sent).toHaveLength(0);
    expect(detect).not.toHaveBeenCalled();
  });

  it("stops everything on destroy", async () => {
    const fake = fakeWs();
    current = factorio;
    const l = start(fake);
    await flush();
    l.destroy();
    detect.mockClear();
    await vi.advanceTimersByTimeAsync(GAME_ACTIVITY_POLL_MS * 2);
    expect(detect).not.toHaveBeenCalled();
    expect(handleActivityRefusal("RATE_LIMITED", fake.sent[0]!.id)).toBe(false);
  });
});
