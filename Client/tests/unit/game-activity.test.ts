import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  startGameActivity,
  GAME_ACTIVITY_POLL_MS,
  type GameActivityLoop,
} from "@lib/presence/gameActivity";
import { handleActivityRefusal, GAME_ACTIVITY_PREF_KEY } from "@lib/presence/gameActivityBridge";
import { applyGameActivityPolicy, resetServerCapabilities } from "@lib/net/serverCapabilities";
import { savePref } from "@lib/prefs/preferences";
import { addLogListener, setLogLevel, type LogEntry } from "@lib/logger";
import { expectConsole } from "../helpers/console";
import {
  GAME_PREFS_KEY,
  GAME_SEEN_KEY,
  EMPTY_GAME_PREFS,
  loadGamePrefs,
  loadSeen,
  saveGamePrefs,
  withHidden,
  withManual,
  withRename,
} from "@lib/prefs/gameActivityPrefs";
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
    listenerCounts(): { state: number; ready: number } {
      return { state: stateListeners.size, ready: readyListeners.size };
    },
  };
}

/** Let promise continuations run. */
async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

/** Starts a loop against a fresh socket and lets its first scan finish. */
async function startWith(start: (fake: ReturnType<typeof fakeWs>) => unknown) {
  const fake = fakeWs();
  start(fake);
  await flush();
  return fake;
}

/** Makes every scan wait until the test releases it, in call order. */
function holdScans(detect: Mock<() => Promise<DetectedGame | null>>) {
  const releases: Array<(g: DetectedGame | null) => void> = [];
  detect.mockImplementation(() => new Promise((resolve) => releases.push(resolve)));
  return releases;
}

/** Makes each scan find a differently named game. */
function newGameEachScan(detect: Mock<() => Promise<DetectedGame | null>>): void {
  let n = 0;
  detect.mockImplementation(async () => ({ ...factorio, name: `Game ${++n}` }));
}

const sentNames = (fake: ReturnType<typeof fakeWs>): Array<string | null> =>
  fake.sent.map((s) => s.activity?.name ?? null);

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

  async function begin(game?: DetectedGame | null) {
    if (game !== undefined) current = game;
    return startWith(start);
  }

  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
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
    const fake = await begin(factorio);
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
    const fake = await begin(factorio);
    current = valorant;
    await vi.advanceTimersByTimeAsync(GAME_ACTIVITY_POLL_MS);
    current = null;
    await vi.advanceTimersByTimeAsync(GAME_ACTIVITY_POLL_MS);
    expect(sentNames(fake)).toEqual(["Factorio", "VALORANT", null]);
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
    const fake = await begin(factorio);
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
    const fake = await begin();
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
    const fake = await begin(factorio);
    const first = fake.sent[0]!;
    // The dispatcher routes the refusal here; the loop claims it (no toast).
    expect(handleActivityRefusal("RATE_LIMITED", first.id)).toBe(true);

    await vi.advanceTimersByTimeAsync(GAME_ACTIVITY_POLL_MS);
    expect(fake.sent).toHaveLength(2);
    expect(fake.sent[1]?.activity?.name).toBe("Factorio");
  });

  it("sends again after the server's per-frame deadline refused the set", async () => {
    const fake = await begin(factorio);
    expect(handleActivityRefusal("REQUEST_TIMEOUT", fake.sent[0]!.id)).toBe(true);

    await vi.advanceTimersByTimeAsync(GAME_ACTIVITY_POLL_MS);
    expect(fake.sent.map((s) => s.activity?.name)).toEqual(["Factorio", "Factorio"]);
  });

  it("after a refused set, sends null if the game is gone by the retry", async () => {
    const fake = await begin(factorio);
    handleActivityRefusal("RATE_LIMITED", fake.sent[0]!.id);
    current = null;
    await vi.advanceTimersByTimeAsync(GAME_ACTIVITY_POLL_MS);
    expect(sentNames(fake)).toEqual(["Factorio", null]);
  });

  it("claims only its own frames' refusals", async () => {
    const fake = await begin(factorio);
    expect(handleActivityRefusal("RATE_LIMITED", "some-other-frame")).toBe(false);
    expect(handleActivityRefusal("RATE_LIMITED", undefined)).toBe(false);
    // Nothing was forgotten, so nothing is re-sent.
    await vi.advanceTimersByTimeAsync(GAME_ACTIVITY_POLL_MS);
    expect(fake.sent).toHaveLength(1);
  });

  it("leaves a BAD_REQUEST name alone instead of retrying it every poll", async () => {
    const fake = await begin(factorio);
    expect(handleActivityRefusal("BAD_REQUEST", fake.sent[0]!.id)).toBe(true);
    await vi.advanceTimersByTimeAsync(GAME_ACTIVITY_POLL_MS * 2);
    expect(fake.sent).toHaveLength(1);
  });

  it("asks again on the next poll after a set refused because the switch is off", async () => {
    const fake = await begin(factorio);
    expect(fake.sent).toHaveLength(1);
    // The dispatcher routes the refusal here; the loop claims it (no toast).
    expect(handleActivityRefusal("GAME_ACTIVITY_DISABLED", fake.sent[0]!.id)).toBe(true);

    await vi.advanceTimersByTimeAsync(GAME_ACTIVITY_POLL_MS * 3);
    // One retry; the server held it this time, so nothing more is sent.
    expect(fake.sent.map((s) => s.activity?.name)).toEqual(["Factorio", "Factorio"]);
  });

  describe("the per-server switch", () => {
    afterEach(() => resetServerCapabilities());

    it("sends nothing, not even a null, when the switch goes off, and stops scanning", async () => {
      const fake = await begin(factorio);
      expect(fake.sent).toHaveLength(1);

      // The server cleared the game itself; the dispatcher turns the capability off.
      supported = false;
      applyGameActivityPolicy(false);
      await flush();
      const scans = detect.mock.calls.length;
      await vi.advanceTimersByTimeAsync(GAME_ACTIVITY_POLL_MS * 3);
      expect(fake.sent).toHaveLength(1);
      expect(detect.mock.calls.length).toBe(scans);
    });

    it("polls at once when the switch comes back on, and sends the game again", async () => {
      const fake = await begin(factorio);
      supported = false;
      applyGameActivityPolicy(false);
      await flush();
      expect(fake.sent).toHaveLength(1);

      supported = true;
      applyGameActivityPolicy(true);
      await flush();
      // No timer advanced: the server holds nothing for us, so the set is sent again.
      expect(fake.sent.map((s) => s.activity?.name)).toEqual(["Factorio", "Factorio"]);
    });

    it("sends the game again after the switch cycled even if it never saw the off frame", async () => {
      const fake = await begin(factorio);
      // The set was refused while off; the off frame itself was missed, and
      // the true frame that follows is no change for this client.
      handleActivityRefusal("GAME_ACTIVITY_DISABLED", fake.sent[0]!.id);
      applyGameActivityPolicy(true);
      await vi.advanceTimersByTimeAsync(GAME_ACTIVITY_POLL_MS);
      expect(fake.sent).toHaveLength(2);
    });

    it("drops a scan that answers after the switch went off", async () => {
      const fake = fakeWs();
      let release: (g: DetectedGame | null) => void = () => undefined;
      detect.mockImplementationOnce(
        () =>
          new Promise<DetectedGame | null>((resolve) => {
            release = resolve;
          }),
      );
      start(fake);
      await flush();
      supported = false;
      applyGameActivityPolicy(false);
      release(factorio);
      await flush();
      expect(fake.sent).toHaveLength(0);
    });

    it("stops listening when destroyed", async () => {
      await begin(factorio);
      loop?.destroy();
      loop = null;
      const scans = detect.mock.calls.length;
      applyGameActivityPolicy(false);
      applyGameActivityPolicy(true);
      await flush();
      expect(detect.mock.calls.length).toBe(scans);
    });
  });

  it("re-sends the current game after every reconnect", async () => {
    const fake = await begin(factorio);
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
    const fake = await begin(factorio);
    expect(fake.sent).toHaveLength(1);
    detect.mockImplementation(async () => {
      throw new Error("boom");
    });
    await vi.advanceTimersByTimeAsync(GAME_ACTIVITY_POLL_MS);
    expect(sentNames(fake)).toEqual(["Factorio", null]);
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

  describe("names, bookkeeping and teardown", () => {
    afterEach(() => resetServerCapabilities());

    it("sends the name trimmed and cut at 128 whole characters", async () => {
      const fake = fakeWs();
      current = { ...factorio, name: `  ${"é".repeat(130)}  ` };
      start(fake);
      await flush();
      expect(fake.sent[0]?.activity?.name).toBe("é".repeat(128));

      current = { ...factorio, name: "  Factorio  " };
      await vi.advanceTimersByTimeAsync(GAME_ACTIVITY_POLL_MS);
      expect(fake.sent[1]?.activity?.name).toBe("Factorio");

      current = { ...factorio, name: `${"a".repeat(127)}\u{1F600}\u{1F600}` };
      await vi.advanceTimersByTimeAsync(GAME_ACTIVITY_POLL_MS);
      expect(fake.sent[2]?.activity?.name).toBe(`${"a".repeat(127)}\u{1F600}`);

      current = { ...factorio, name: "b".repeat(128) };
      await vi.advanceTimersByTimeAsync(GAME_ACTIVITY_POLL_MS);
      expect(fake.sent[3]?.activity?.name).toBe("b".repeat(128));
    });

    it("sends nothing for a name that is only spaces", async () => {
      const fake = fakeWs();
      current = { ...factorio, name: "   " };
      start(fake);
      await vi.advanceTimersByTimeAsync(GAME_ACTIVITY_POLL_MS * 2);
      expect(fake.sent).toHaveLength(0);
    });

    it("clears a shown game when the next name is only spaces", async () => {
      const fake = await begin(factorio);
      current = { ...factorio, name: "  " };
      await vi.advanceTimersByTimeAsync(GAME_ACTIVITY_POLL_MS);
      expect(sentNames(fake)).toEqual(["Factorio", null]);
    });

    it("does not start another scan while one is still running", async () => {
      const fake = fakeWs();
      const releases = holdScans(detect);
      start(fake);
      await vi.advanceTimersByTimeAsync(GAME_ACTIVITY_POLL_MS * 2);
      expect(detect).toHaveBeenCalledTimes(1);
      releases[0]!(factorio);
      await flush();
      expect(fake.sent.map((x) => x.activity?.name)).toEqual(["Factorio"]);
    });

    it("drops the answer of a scan that was running when the game choices changed", async () => {
      const fake = fakeWs();
      const releases = holdScans(detect);
      start(fake);
      await flush();
      saveGamePrefs(withRename(EMPTY_GAME_PREFS, "Factorio", "My Factory"));
      detect.mockImplementation(async () => valorant);
      releases[0]!(factorio);
      await flush();
      expect(fake.sent.map((x) => x.activity?.name)).toEqual(["VALORANT"]);
    });

    it("lets the current connection's scan run on after an older connection's scan ends", async () => {
      const fake = fakeWs();
      const releases = holdScans(detect);
      start(fake);
      await flush();
      fake.setState("reconnecting");
      fake.setState("connected");
      await flush();
      expect(detect).toHaveBeenCalledTimes(2);
      releases[0]!(null);
      await flush();
      await vi.advanceTimersByTimeAsync(GAME_ACTIVITY_POLL_MS);
      expect(detect).toHaveBeenCalledTimes(2);
    });

    it("forgets a choices change noticed by a scan that an older connection owned", async () => {
      const fake = fakeWs();
      const releases = holdScans(detect);
      start(fake);
      await flush();
      saveGamePrefs(withRename(EMPTY_GAME_PREFS, "Other", "Renamed"));
      fake.setState("reconnecting");
      fake.setState("connected");
      await flush();
      releases[0]!(factorio);
      await flush();
      releases[1]!(valorant);
      await flush();
      expect(fake.sent.map((x) => x.activity?.name)).toEqual(["VALORANT"]);
      expect(detect).toHaveBeenCalledTimes(2);
    });

    it("keeps going when the socket drops between the check and the send", async () => {
      const fake = fakeWs();
      const send = (fake.ws as unknown as { send: ReturnType<typeof vi.fn> }).send;
      send.mockImplementationOnce(() => {
        throw new Error("socket closed");
      });
      send.mockImplementationOnce(() => {
        throw "plain text";
      });
      const entries: LogEntry[] = [];
      const stop = addLogListener((entry) => entries.push(entry));
      current = factorio;
      try {
        start(fake);
        await flush();
        expect(fake.sent).toHaveLength(0);
        await vi.advanceTimersByTimeAsync(GAME_ACTIVITY_POLL_MS);
        expect(fake.sent).toHaveLength(0);
        await vi.advanceTimersByTimeAsync(GAME_ACTIVITY_POLL_MS);
      } finally {
        stop();
      }
      expectConsole("warn", "activity_update not sent");
      expectConsole("warn", "activity_update not sent");
      expect(entries.map((e) => [e.level, e.message, e.data])).toEqual([
        ["warn", "activity_update not sent", { error: "socket closed" }],
        ["warn", "activity_update not sent", { error: "" }],
      ]);
      // Nothing was recorded as sent, so the next poll sends it.
      expect(fake.sent.map((x) => x.activity?.name)).toEqual(["Factorio"]);
    });

    it("tracks the eight most recent frames for refusals", async () => {
      const fake = fakeWs();
      newGameEachScan(detect);
      start(fake);
      await flush();
      await vi.advanceTimersByTimeAsync(GAME_ACTIVITY_POLL_MS * 7);
      expect(fake.sent).toHaveLength(8);
      expect(handleActivityRefusal("BAD_REQUEST", fake.sent[0]!.id)).toBe(true);
      expect(handleActivityRefusal("BAD_REQUEST", fake.sent[7]!.id)).toBe(true);
    });

    it("forgets the oldest frame once a ninth is sent", async () => {
      const fake = fakeWs();
      newGameEachScan(detect);
      start(fake);
      await flush();
      await vi.advanceTimersByTimeAsync(GAME_ACTIVITY_POLL_MS * 8);
      expect(fake.sent).toHaveLength(9);
      expect(handleActivityRefusal("BAD_REQUEST", fake.sent[0]!.id)).toBe(false);
      expect(handleActivityRefusal("BAD_REQUEST", fake.sent[1]!.id)).toBe(true);
      expect(handleActivityRefusal("BAD_REQUEST", fake.sent[8]!.id)).toBe(true);
    });

    it("claims a refusal once and logs it", async () => {
      const fake = await begin(factorio);
      const entries: LogEntry[] = [];
      const stop = addLogListener((entry) => entries.push(entry));
      setLogLevel("debug");
      vi.spyOn(console, "debug").mockImplementation(() => {});
      try {
        expect(handleActivityRefusal("RATE_LIMITED", fake.sent[0]!.id)).toBe(true);
        expect(handleActivityRefusal("RATE_LIMITED", fake.sent[0]!.id)).toBe(false);
      } finally {
        setLogLevel("warn");
        stop();
        vi.restoreAllMocks();
      }
      expect(entries.map((e) => [e.level, e.message, e.data])).toEqual([
        ["debug", "activity_update refused", { code: "RATE_LIMITED" }],
      ]);
    });

    it("still claims a refusal that arrives after the socket dropped", async () => {
      const fake = await begin(factorio);
      fake.setState("reconnecting");
      expect(handleActivityRefusal("BAD_REQUEST", fake.sent[0]!.id)).toBe(true);
    });

    it("sends no clear for a setting turned off while the socket is down", async () => {
      const fake = await begin(factorio);
      fake.setState("reconnecting");
      enabled = false;
      savePref(GAME_ACTIVITY_PREF_KEY, false);
      expect(fake.sent).toHaveLength(1);
    });

    it("sends no clear for a setting turned off once the server stopped supporting it", async () => {
      const fake = await begin(factorio);
      supported = false;
      enabled = false;
      savePref(GAME_ACTIVITY_PREF_KEY, false);
      expect(fake.sent).toHaveLength(1);
    });

    it("does not scan again when the server switch goes off, even if the capability still reads on", async () => {
      const fake = await begin(factorio);
      const scans = detect.mock.calls.length;
      applyGameActivityPolicy(false);
      await flush();
      expect(detect.mock.calls.length).toBe(scans);
      expect(fake.sent).toHaveLength(1);
    });

    it("unregisters from the socket when destroyed", async () => {
      const fake = fakeWs();
      start(fake);
      expect(fake.listenerCounts()).toEqual({ state: 1, ready: 1 });
      loop?.destroy();
      loop = null;
      expect(fake.listenerCounts()).toEqual({ state: 0, ready: 0 });
    });

    it("drops a scan that answers after the loop was destroyed", async () => {
      const fake = fakeWs();
      const releases = holdScans(detect);
      const l = start(fake);
      await flush();
      l.destroy();
      loop = null;
      releases[0]!(factorio);
      await flush();
      expect(fake.sent).toHaveLength(0);
    });
  });
});

describe("game activity loop: the user's own game choices", () => {
  let loop: GameActivityLoop | null = null;
  let current: DetectedGame | null;
  const detect = vi.fn(async (_prefs: unknown) => current);

  function start(fake: ReturnType<typeof fakeWs>) {
    loop = startGameActivity({
      ws: fake.ws,
      detect,
      enabled: () => true,
      supported: () => true,
    });
    return loop;
  }

  async function begin(game?: DetectedGame | null) {
    if (game !== undefined) current = game;
    return startWith(start);
  }

  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    current = null;
    detect.mockClear();
    detect.mockImplementation(async () => current);
  });

  afterEach(() => {
    loop?.destroy();
    loop = null;
    vi.useRealTimers();
  });

  it("hands the manual programs and hidden names to the detector", async () => {
    let prefs = withManual(EMPTY_GAME_PREFS, "C:\\Games\\mine.exe", "Mine")!;
    prefs = withHidden(prefs, "Hades", true);
    saveGamePrefs(prefs);
    start(fakeWs());
    await flush();
    expect(detect).toHaveBeenCalledWith({
      manual: [{ path: "C:\\Games\\mine.exe", name: "Mine" }],
      hidden: ["Hades"],
    });
  });

  it("sends the renamed name, and the detected name again once the rename is reset", async () => {
    saveGamePrefs(withRename(EMPTY_GAME_PREFS, "Factorio", "  My Factory  "));
    const fake = await begin(factorio);
    expect(fake.sent.map((s) => s.activity?.name)).toEqual(["My Factory"]);

    // A rename made while the game runs is picked up at once, not on the next beat.
    saveGamePrefs(withRename(loadGamePrefs(), "Factorio", "Factory"));
    await flush();
    expect(fake.sent.map((s) => s.activity?.name)).toEqual(["My Factory", "Factory"]);

    saveGamePrefs(withRename(loadGamePrefs(), "Factorio", "   "));
    await flush();
    expect(fake.sent.map((s) => s.activity?.name)).toEqual(["My Factory", "Factory", "Factorio"]);
  });

  it("restarts the clock when another game takes over the same shown name", async () => {
    saveGamePrefs(
      withRename(withRename(EMPTY_GAME_PREFS, "Factorio", "Playing"), "VALORANT", "Playing"),
    );
    const fake = await begin(factorio);
    current = valorant;
    await vi.advanceTimersByTimeAsync(GAME_ACTIVITY_POLL_MS);
    expect(fake.sent.map((s) => s.activity ?? null)).toEqual([
      { name: "Playing", started_at: factorio.startedAtMs },
      null,
      { name: "Playing", started_at: valorant.startedAtMs },
    ]);
    // The same game on the next poll sends nothing.
    await vi.advanceTimersByTimeAsync(GAME_ACTIVITY_POLL_MS);
    expect(fake.sent).toHaveLength(3);
  });

  it("remembers every detected name, newest first, once", async () => {
    await begin(factorio);
    current = valorant;
    await vi.advanceTimersByTimeAsync(GAME_ACTIVITY_POLL_MS);
    current = factorio;
    await vi.advanceTimersByTimeAsync(GAME_ACTIVITY_POLL_MS);
    await vi.advanceTimersByTimeAsync(GAME_ACTIVITY_POLL_MS);
    expect(loadSeen()).toEqual(["Factorio", "VALORANT"]);
  });

  it("hiding the game being shown clears it at once when no other game runs, and never sends it again", async () => {
    const fake = await begin(factorio);
    expect(sentNames(fake)).toEqual(["Factorio"]);

    // The host skips a hidden game, as the real one does.
    detect.mockImplementation(async (prefs) =>
      (prefs as { hidden: string[] }).hidden.includes("Factorio") ? null : current,
    );
    saveGamePrefs(withHidden(loadGamePrefs(), "Factorio", true));
    await flush();
    expect(sentNames(fake)).toEqual(["Factorio", null]);

    await vi.advanceTimersByTimeAsync(GAME_ACTIVITY_POLL_MS * 3);
    expect(sentNames(fake)).toEqual(["Factorio", null]);

    // Showing it again brings it back.
    saveGamePrefs(withHidden(loadGamePrefs(), "factorio", false));
    await flush();
    expect(sentNames(fake)).toEqual(["Factorio", null, "Factorio"]);
  });

  it("hides a game by its detected name even when it is shown under a rename", async () => {
    saveGamePrefs(withRename(EMPTY_GAME_PREFS, "Factorio", "My Factory"));
    const fake = await begin(factorio);
    saveGamePrefs(withHidden(loadGamePrefs(), "FACTORIO", true));
    await flush();
    expect(sentNames(fake)).toEqual(["My Factory", null]);
  });

  it("drops an answer for a game hidden while the scan ran", async () => {
    const fake = fakeWs();
    let release: (g: DetectedGame | null) => void = () => {};
    detect.mockImplementation(() => new Promise((resolve) => (release = resolve)));
    start(fake);
    await flush();
    saveGamePrefs(withHidden(EMPTY_GAME_PREFS, "Factorio", true));
    release(factorio);
    await flush();
    expect(fake.sent).toHaveLength(0);
  });

  it("falls through to the next game the host finds once one is hidden", async () => {
    const fake = await begin(factorio);
    detect.mockImplementation(async (prefs) =>
      (prefs as { hidden: string[] }).hidden.includes("Factorio") ? valorant : factorio,
    );
    saveGamePrefs(withHidden(loadGamePrefs(), "Factorio", true));
    await flush();
    expect(sentNames(fake)).toEqual(["Factorio", "VALORANT"]);
  });

  it("a hide while a scan is running drops that scan's answer and sends one frame from the next", async () => {
    const fake = fakeWs();
    let release: (g: DetectedGame | null) => void = () => {};
    detect.mockImplementation(() => new Promise((resolve) => (release = resolve)));
    start(fake);
    await flush();
    saveGamePrefs(withHidden(EMPTY_GAME_PREFS, "Factorio", true));
    detect.mockImplementation(async () => valorant);
    release(factorio);
    await flush();
    expect(sentNames(fake)).toEqual(["VALORANT"]);
  });

  it("does not record a manual game as a detected one", async () => {
    saveGamePrefs(withManual(EMPTY_GAME_PREFS, "/x/mine", "Mine")!);
    const fake = fakeWs();
    current = { name: "Mine", source: "manual", startedAtMs: 5 };
    start(fake);
    await flush();
    expect(fake.sent.map((s) => s.activity?.name)).toEqual(["Mine"]);
    expect(loadSeen()).toEqual([]);
  });

  it("works with stored choices that are malformed or from an older version", async () => {
    const blobs: unknown[] = [
      "garbage",
      [1, 2, 3],
      { manual: "x", hidden: 5, renames: [] },
      { manual: [null, 4, { path: 1, name: 2 }, { path: "/a", name: "" }], hidden: [null, {}, ""] },
      { version: 1, hide: ["Factorio"], names: { Factorio: "Nope" } },
    ];
    for (const blob of blobs) {
      localStorage.clear();
      savePref(GAME_PREFS_KEY, blob);
      savePref(GAME_SEEN_KEY, blob);
      const fake = fakeWs();
      current = factorio;
      detect.mockClear();
      const l = start(fake);
      await flush();
      expect(
        fake.sent.map((s) => s.activity?.name),
        JSON.stringify(blob),
      ).toEqual(["Factorio"]);
      expect(detect).toHaveBeenCalledWith({ manual: [], hidden: [] });
      l.destroy();
    }
    // Text that is not JSON at all.
    localStorage.setItem("owncord:settings:" + GAME_PREFS_KEY, "{not json");
    const fake = await begin();
    expect(fake.sent.map((s) => s.activity?.name)).toEqual(["Factorio"]);
  });
});
