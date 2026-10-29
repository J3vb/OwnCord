import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startGameActivity, GAME_ACTIVITY_POLL_MS, type GameActivityLoop } from "@lib/gameActivity";
import { handleActivityRefusal, GAME_ACTIVITY_PREF_KEY } from "@lib/gameActivityBridge";
import { applyGameActivityPolicy, resetServerCapabilities } from "@lib/serverCapabilities";
import { savePref } from "@lib/preferences";
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
} from "@lib/gameActivityPrefs";
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

  it("asks again on the next poll after a set refused because the switch is off", async () => {
    const fake = fakeWs();
    current = factorio;
    start(fake);
    await flush();
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
      const fake = fakeWs();
      current = factorio;
      start(fake);
      await flush();
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
      const fake = fakeWs();
      current = factorio;
      start(fake);
      await flush();
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
      const fake = fakeWs();
      current = factorio;
      start(fake);
      await flush();
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
      const fake = fakeWs();
      current = factorio;
      start(fake);
      await flush();
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
    const fake = fakeWs();
    current = factorio;
    start(fake);
    await flush();
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
    const fake = fakeWs();
    current = factorio;
    start(fake);
    await flush();
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
    const fake = fakeWs();
    current = factorio;
    start(fake);
    await flush();
    current = valorant;
    await vi.advanceTimersByTimeAsync(GAME_ACTIVITY_POLL_MS);
    current = factorio;
    await vi.advanceTimersByTimeAsync(GAME_ACTIVITY_POLL_MS);
    await vi.advanceTimersByTimeAsync(GAME_ACTIVITY_POLL_MS);
    expect(loadSeen()).toEqual(["Factorio", "VALORANT"]);
  });

  it("hiding the game being shown clears it at once when no other game runs, and never sends it again", async () => {
    const fake = fakeWs();
    current = factorio;
    start(fake);
    await flush();
    expect(fake.sent.map((s) => s.activity?.name ?? null)).toEqual(["Factorio"]);

    // The host skips a hidden game, as the real one does.
    detect.mockImplementation(async (prefs) =>
      (prefs as { hidden: string[] }).hidden.includes("Factorio") ? null : current,
    );
    saveGamePrefs(withHidden(loadGamePrefs(), "Factorio", true));
    await flush();
    expect(fake.sent.map((s) => s.activity?.name ?? null)).toEqual(["Factorio", null]);

    await vi.advanceTimersByTimeAsync(GAME_ACTIVITY_POLL_MS * 3);
    expect(fake.sent.map((s) => s.activity?.name ?? null)).toEqual(["Factorio", null]);

    // Showing it again brings it back.
    saveGamePrefs(withHidden(loadGamePrefs(), "factorio", false));
    await flush();
    expect(fake.sent.map((s) => s.activity?.name ?? null)).toEqual(["Factorio", null, "Factorio"]);
  });

  it("hides a game by its detected name even when it is shown under a rename", async () => {
    saveGamePrefs(withRename(EMPTY_GAME_PREFS, "Factorio", "My Factory"));
    const fake = fakeWs();
    current = factorio;
    start(fake);
    await flush();
    saveGamePrefs(withHidden(loadGamePrefs(), "FACTORIO", true));
    await flush();
    expect(fake.sent.map((s) => s.activity?.name ?? null)).toEqual(["My Factory", null]);
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
    const fake = fakeWs();
    current = factorio;
    start(fake);
    await flush();
    detect.mockImplementation(async (prefs) =>
      (prefs as { hidden: string[] }).hidden.includes("Factorio") ? valorant : factorio,
    );
    saveGamePrefs(withHidden(loadGamePrefs(), "Factorio", true));
    await flush();
    expect(fake.sent.map((s) => s.activity?.name ?? null)).toEqual(["Factorio", "VALORANT"]);
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
    expect(fake.sent.map((s) => s.activity?.name ?? null)).toEqual(["VALORANT"]);
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
    const fake = fakeWs();
    start(fake);
    await flush();
    expect(fake.sent.map((s) => s.activity?.name)).toEqual(["Factorio"]);
  });
});
