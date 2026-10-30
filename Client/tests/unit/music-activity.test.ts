import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  startMusicActivity,
  MUSIC_ACTIVITY_POLL_MS,
  type MusicActivityLoop,
} from "@lib/presence/musicActivity";
import { handleActivityRefusal } from "@lib/presence/gameActivityBridge";
import { applyGameActivityPolicy, resetServerCapabilities } from "@lib/net/serverCapabilities";
import { savePref } from "@lib/prefs/preferences";
import {
  EMPTY_MUSIC_PREFS,
  MUSIC_ACTIVITY_PREF_KEY,
  MUSIC_PREFS_KEY,
  MUSIC_SEEN_KEY,
  loadMusicPrefs,
  loadSeenPlayers,
  saveMusicPrefs,
  withPlayerHidden,
} from "@lib/prefs/musicActivityPrefs";
import type { ConnectionState } from "@lib/ws";
import type { MediaPrefs, MediaReading } from "../../src/platform/contracts/mediaDetector";

/**
 * The loop sends `listening_update` only when the title, artist or player
 * changes, clears when the music stops, keeps what it showed when the host
 * cannot say, retries a refused frame with only the latest song, starts over
 * on every connection and drops a read that began under an older connection.
 */

const NOW = 1_761_206_400_000;

function playing(
  overrides: Partial<Extract<MediaReading, { state: "playing" }>> = {},
): MediaReading {
  return {
    state: "playing",
    title: "Blue in Green",
    artist: "Miles Davis",
    player: "Spotify",
    playerId: "spotify.exe",
    positionMs: 60_000,
    durationMs: 337_000,
    ...overrides,
  };
}
const NONE: MediaReading = { state: "none" };
const UNKNOWN: MediaReading = { state: "unknown" };

interface Sent {
  readonly id: string;
  readonly listening: {
    title: string;
    artist: string;
    player: string;
    started_at: number;
    duration_ms: number;
  } | null;
}

function fakeWs(initial: ConnectionState = "connected") {
  let state: ConnectionState = initial;
  let nextId = 1;
  const sent: Sent[] = [];
  const stateListeners = new Set<(s: ConnectionState) => void>();
  const readyListeners = new Set<() => void>();
  const ws = {
    getState: () => state,
    send: vi.fn((msg: { type: string; payload: { listening: Sent["listening"] } }) => {
      expect(msg.type).toBe("listening_update");
      const id = `id-${nextId++}`;
      sent.push({ id, listening: msg.payload.listening });
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

describe("music activity loop", () => {
  let loop: MusicActivityLoop | null = null;
  let current: MediaReading;
  let supported: boolean;
  let enabled: boolean;
  const detect = vi.fn(async (_prefs: MediaPrefs): Promise<MediaReading> => current);

  function start(fake: ReturnType<typeof fakeWs>) {
    loop = startMusicActivity({
      ws: fake.ws,
      detect,
      enabled: () => enabled,
      supported: () => supported,
    });
    return loop;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    localStorage.clear();
    current = NONE;
    supported = true;
    enabled = true;
    detect.mockClear();
    detect.mockImplementation(async () => current);
  });

  afterEach(() => {
    loop?.destroy();
    loop = null;
    resetServerCapabilities();
    vi.useRealTimers();
  });

  it("sends the song once, with its start time and length, and stays quiet while it plays", async () => {
    const fake = fakeWs();
    current = playing();
    start(fake);
    await flush();
    expect(fake.sent.map((s) => s.listening)).toEqual([
      {
        title: "Blue in Green",
        artist: "Miles Davis",
        player: "Spotify",
        started_at: NOW - 60_000,
        duration_ms: 337_000,
      },
    ]);

    // The position moves on every poll; that is no change.
    current = playing({ positionMs: 70_000 });
    await vi.advanceTimersByTimeAsync(MUSIC_ACTIVITY_POLL_MS);
    current = playing({ positionMs: 10_000 });
    await vi.advanceTimersByTimeAsync(MUSIC_ACTIVITY_POLL_MS * 2);
    expect(detect.mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(fake.sent).toHaveLength(1);
  });

  it("asks every 10 seconds", () => {
    expect(MUSIC_ACTIVITY_POLL_MS).toBe(10_000);
  });

  it("sends nothing while nothing plays", async () => {
    const fake = fakeWs();
    start(fake);
    await vi.advanceTimersByTimeAsync(MUSIC_ACTIVITY_POLL_MS * 2);
    expect(fake.sent).toHaveLength(0);
  });

  it("sends a change of title, artist or player, each once", async () => {
    const fake = fakeWs();
    current = playing();
    start(fake);
    await flush();
    current = playing({ title: "So What" });
    await vi.advanceTimersByTimeAsync(MUSIC_ACTIVITY_POLL_MS);
    current = playing({ title: "So What", artist: "Coltrane" });
    await vi.advanceTimersByTimeAsync(MUSIC_ACTIVITY_POLL_MS);
    current = playing({ title: "So What", artist: "Coltrane", player: "VLC", playerId: "vlc" });
    await vi.advanceTimersByTimeAsync(MUSIC_ACTIVITY_POLL_MS);
    expect(
      fake.sent.map((s) => `${s.listening?.title}|${s.listening?.artist}|${s.listening?.player}`),
    ).toEqual([
      "Blue in Green|Miles Davis|Spotify",
      "So What|Miles Davis|Spotify",
      "So What|Coltrane|Spotify",
      "So What|Coltrane|VLC",
    ]);
  });

  it("sends a song with no artist and no length", async () => {
    const fake = fakeWs();
    current = playing({ artist: "", durationMs: 0 });
    start(fake);
    await flush();
    expect(fake.sent[0]?.listening).toMatchObject({ artist: "", duration_ms: 0 });
  });

  it("sends null at once when the music stops, then stays quiet", async () => {
    const fake = fakeWs();
    current = playing();
    start(fake);
    await flush();
    current = NONE;
    await vi.advanceTimersByTimeAsync(MUSIC_ACTIVITY_POLL_MS);
    expect(fake.sent.map((s) => s.listening?.title ?? null)).toEqual(["Blue in Green", null]);
    await vi.advanceTimersByTimeAsync(MUSIC_ACTIVITY_POLL_MS * 3);
    expect(fake.sent).toHaveLength(2);
  });

  it("keeps the last state and sends nothing while the host answers unknown", async () => {
    const fake = fakeWs();
    current = playing();
    start(fake);
    await flush();
    current = UNKNOWN;
    await vi.advanceTimersByTimeAsync(MUSIC_ACTIVITY_POLL_MS * 3);
    expect(fake.sent).toHaveLength(1);
    // The same song after the stall is no change either.
    current = playing({ positionMs: 90_000 });
    await vi.advanceTimersByTimeAsync(MUSIC_ACTIVITY_POLL_MS);
    expect(fake.sent).toHaveLength(1);
    // And a stop after the stall still clears.
    current = UNKNOWN;
    await vi.advanceTimersByTimeAsync(MUSIC_ACTIVITY_POLL_MS);
    current = NONE;
    await vi.advanceTimersByTimeAsync(MUSIC_ACTIVITY_POLL_MS);
    expect(fake.sent.map((s) => s.listening?.title ?? null)).toEqual(["Blue in Green", null]);
  });

  it("treats a rejecting detector as unknown", async () => {
    const fake = fakeWs();
    current = playing();
    start(fake);
    await flush();
    detect.mockRejectedValue(new Error("no host"));
    await vi.advanceTimersByTimeAsync(MUSIC_ACTIVITY_POLL_MS * 2);
    expect(fake.sent).toHaveLength(1);
  });

  it("cuts a very long title at the server's limit by whole characters", async () => {
    const fake = fakeWs();
    current = playing({
      title: `  ${"é".repeat(200)}  `,
      artist: "ä".repeat(300),
      player: "p".repeat(90),
    });
    start(fake);
    await flush();
    expect(Array.from(fake.sent[0]?.listening?.title ?? "")).toHaveLength(128);
    expect(Array.from(fake.sent[0]?.listening?.artist ?? "")).toHaveLength(128);
    expect(Array.from(fake.sent[0]?.listening?.player ?? "")).toHaveLength(64);
  });

  it("treats a blank title or player as no song", async () => {
    const fake = fakeWs();
    current = playing({ title: "   " });
    start(fake);
    await flush();
    current = playing({ player: " " });
    await vi.advanceTimersByTimeAsync(MUSIC_ACTIVITY_POLL_MS);
    expect(fake.sent).toHaveLength(0);
  });

  describe("gates", () => {
    it("sends nothing and reads nothing when the server lacks listening_activity", async () => {
      const fake = fakeWs();
      supported = false;
      current = playing();
      start(fake);
      await vi.advanceTimersByTimeAsync(MUSIC_ACTIVITY_POLL_MS * 2);
      expect(detect).not.toHaveBeenCalled();
      expect(fake.sent).toHaveLength(0);
    });

    it("sends nothing and reads nothing while the setting is off", async () => {
      const fake = fakeWs();
      enabled = false;
      current = playing();
      start(fake);
      await vi.advanceTimersByTimeAsync(MUSIC_ACTIVITY_POLL_MS * 2);
      expect(detect).not.toHaveBeenCalled();
      expect(fake.sent).toHaveLength(0);
    });

    it("learns the capability from ready on a first connect", async () => {
      const fake = fakeWs();
      supported = false;
      current = playing();
      start(fake);
      await flush();
      expect(fake.sent).toHaveLength(0);
      supported = true;
      fake.ready();
      await flush();
      expect(fake.sent.map((s) => s.listening?.title)).toEqual(["Blue in Green"]);
    });

    it("sends nothing while disconnected and starts when the connection comes up", async () => {
      const fake = fakeWs("disconnected");
      current = playing();
      start(fake);
      await vi.advanceTimersByTimeAsync(MUSIC_ACTIVITY_POLL_MS);
      expect(fake.sent).toHaveLength(0);
      expect(detect).not.toHaveBeenCalled();
      fake.setState("connected");
      await flush();
      expect(fake.sent).toHaveLength(1);
    });
  });

  describe("the setting", () => {
    it("sends null at once when it is turned off, and stops reading", async () => {
      const fake = fakeWs();
      current = playing();
      start(fake);
      await flush();
      expect(fake.sent).toHaveLength(1);

      enabled = false;
      savePref(MUSIC_ACTIVITY_PREF_KEY, false);
      // At once: no timer has advanced.
      expect(fake.sent.map((s) => s.listening?.title ?? null)).toEqual(["Blue in Green", null]);
      detect.mockClear();
      await vi.advanceTimersByTimeAsync(MUSIC_ACTIVITY_POLL_MS * 2);
      expect(detect).not.toHaveBeenCalled();
      expect(fake.sent).toHaveLength(2);
    });

    it("does not send a clear for a setting change when nothing was shown", async () => {
      const fake = fakeWs();
      start(fake);
      await flush();
      enabled = false;
      savePref(MUSIC_ACTIVITY_PREF_KEY, false);
      expect(fake.sent).toHaveLength(0);
    });

    it("looks right away when it is turned back on", async () => {
      const fake = fakeWs();
      enabled = false;
      current = playing();
      start(fake);
      await flush();
      enabled = true;
      savePref(MUSIC_ACTIVITY_PREF_KEY, true);
      await flush();
      expect(fake.sent.map((s) => s.listening?.title)).toEqual(["Blue in Green"]);
    });

    it("drops a read that answers after the setting went off", async () => {
      const fake = fakeWs();
      let release: (r: MediaReading) => void = () => undefined;
      detect.mockImplementation(() => new Promise<MediaReading>((resolve) => (release = resolve)));
      start(fake);
      await flush();
      enabled = false;
      release(playing());
      await flush();
      expect(fake.sent).toHaveLength(0);
    });
  });

  describe("connections", () => {
    it("sends the song again after a reconnect, once", async () => {
      const fake = fakeWs();
      current = playing();
      start(fake);
      await flush();
      expect(fake.sent).toHaveLength(1);

      fake.setState("reconnecting");
      fake.setState("connected");
      await flush();
      expect(fake.sent.map((s) => s.listening?.title)).toEqual(["Blue in Green", "Blue in Green"]);

      await vi.advanceTimersByTimeAsync(MUSIC_ACTIVITY_POLL_MS * 2);
      expect(fake.sent).toHaveLength(2);
    });

    it("a reconnect that supersedes a read: the stale attempt sends nothing, the new one does", async () => {
      const fake = fakeWs();
      const releases: Array<(r: MediaReading) => void> = [];
      detect.mockImplementation(
        () => new Promise<MediaReading>((resolve) => releases.push(resolve)),
      );
      start(fake);
      await flush();
      expect(releases).toHaveLength(1);

      // The connection drops and comes back while the first read is running.
      fake.setState("reconnecting");
      fake.setState("connected");
      await flush();
      expect(releases).toHaveLength(2);

      // The stale read answers first: it belongs to the old attempt.
      releases[0]?.(playing({ title: "Old attempt" }));
      await flush();
      expect(fake.sent).toHaveLength(0);

      releases[1]?.(playing({ title: "New attempt" }));
      await flush();
      expect(fake.sent.map((s) => s.listening?.title)).toEqual(["New attempt"]);
    });

    it("a read answering while the connection is down sends nothing", async () => {
      const fake = fakeWs();
      let release: (r: MediaReading) => void = () => undefined;
      detect.mockImplementation(() => new Promise<MediaReading>((resolve) => (release = resolve)));
      start(fake);
      await flush();
      fake.setState("reconnecting");
      release(playing());
      await flush();
      expect(fake.sent).toHaveLength(0);
    });

    it("forgets a refusal's id after a reconnect, so a late refusal claims nothing", async () => {
      const fake = fakeWs();
      current = playing();
      start(fake);
      await flush();
      const stale = fake.sent[0]!.id;
      fake.setState("reconnecting");
      fake.setState("connected");
      await flush();
      expect(handleActivityRefusal("RATE_LIMITED", stale)).toBe(false);
      // And the reconnect's own send is not pushed into a resend by it.
      await vi.advanceTimersByTimeAsync(MUSIC_ACTIVITY_POLL_MS);
      expect(fake.sent).toHaveLength(2);
    });
  });

  describe("refusals", () => {
    it("forgets a RATE_LIMITED set and sends again on the next poll, claiming the refusal", async () => {
      const fake = fakeWs();
      current = playing();
      start(fake);
      await flush();
      expect(handleActivityRefusal("RATE_LIMITED", fake.sent[0]!.id)).toBe(true);

      await vi.advanceTimersByTimeAsync(MUSIC_ACTIVITY_POLL_MS);
      expect(fake.sent).toHaveLength(2);
      expect(fake.sent[1]?.listening?.title).toBe("Blue in Green");
    });

    for (const code of ["TIMED_OUT", "REQUEST_TIMEOUT", "GAME_ACTIVITY_DISABLED"]) {
      it(`retries after ${code}`, async () => {
        const fake = fakeWs();
        current = playing();
        start(fake);
        await flush();
        expect(handleActivityRefusal(code, fake.sent[0]!.id)).toBe(true);
        await vi.advanceTimersByTimeAsync(MUSIC_ACTIVITY_POLL_MS);
        expect(fake.sent.map((s) => s.listening?.title)).toEqual([
          "Blue in Green",
          "Blue in Green",
        ]);
      });
    }

    it("does not retry a refusal that is not retryable, and claims only its own frames", async () => {
      const fake = fakeWs();
      current = playing();
      start(fake);
      await flush();
      expect(handleActivityRefusal("BAD_REQUEST", "someone-else")).toBe(false);
      expect(handleActivityRefusal("BAD_REQUEST", fake.sent[0]!.id)).toBe(true);
      await vi.advanceTimersByTimeAsync(MUSIC_ACTIVITY_POLL_MS * 2);
      expect(fake.sent).toHaveLength(1);
    });

    it("fast skipping while RATE_LIMITED: only the final song is ever sent", async () => {
      const fake = fakeWs();
      current = playing({ title: "Song 1" });
      start(fake);
      await flush();
      // Song 1 is accepted. The user then skips through songs 2, 3 and 4.
      current = playing({ title: "Song 2" });
      await vi.advanceTimersByTimeAsync(MUSIC_ACTIVITY_POLL_MS);
      expect(fake.sent.map((s) => s.listening?.title)).toEqual(["Song 1", "Song 2"]);
      // Song 2 is refused by the server's 1/10 s budget.
      expect(handleActivityRefusal("RATE_LIMITED", fake.sent[1]!.id)).toBe(true);
      // The skips outpace the polls: 3 and 4 are never read, 5 is what plays.
      current = playing({ title: "Song 5" });
      await vi.advanceTimersByTimeAsync(MUSIC_ACTIVITY_POLL_MS);
      expect(fake.sent.map((s) => s.listening?.title)).toEqual(["Song 1", "Song 2", "Song 5"]);
      // Nothing of the skipped songs is queued: quiet polls send nothing more.
      await vi.advanceTimersByTimeAsync(MUSIC_ACTIVITY_POLL_MS * 3);
      expect(fake.sent).toHaveLength(3);
    });

    it("fast skipping: a refused song is not resent when the music then stops", async () => {
      const fake = fakeWs();
      current = playing({ title: "Song 1" });
      start(fake);
      await flush();
      current = playing({ title: "Song 2" });
      await vi.advanceTimersByTimeAsync(MUSIC_ACTIVITY_POLL_MS);
      handleActivityRefusal("RATE_LIMITED", fake.sent[1]!.id);
      current = NONE;
      await vi.advanceTimersByTimeAsync(MUSIC_ACTIVITY_POLL_MS);
      // Song 2 never shows; the clear removes song 1.
      expect(fake.sent.map((s) => s.listening?.title ?? null)).toEqual(["Song 1", "Song 2", null]);
      await vi.advanceTimersByTimeAsync(MUSIC_ACTIVITY_POLL_MS * 2);
      expect(fake.sent).toHaveLength(3);
    });
  });

  describe("the server switch", () => {
    it("sends nothing when it goes off, and sends the song again when it comes back", async () => {
      const fake = fakeWs();
      current = playing();
      start(fake);
      await flush();
      expect(fake.sent).toHaveLength(1);

      supported = false;
      applyGameActivityPolicy(false);
      await vi.advanceTimersByTimeAsync(MUSIC_ACTIVITY_POLL_MS * 2);
      // Not even a null: the server cleared the song itself.
      expect(fake.sent).toHaveLength(1);

      supported = true;
      applyGameActivityPolicy(true);
      await flush();
      expect(fake.sent.map((s) => s.listening?.title)).toEqual(["Blue in Green", "Blue in Green"]);
    });
  });

  describe("the player choices", () => {
    it("passes the hidden player ids to every read", async () => {
      const fake = fakeWs();
      saveMusicPrefs(withPlayerHidden(EMPTY_MUSIC_PREFS, "vlc", true));
      current = playing();
      start(fake);
      await flush();
      expect(detect).toHaveBeenCalledWith({ hidden: ["vlc"] });
    });

    it("records the players seen", async () => {
      const fake = fakeWs();
      current = playing();
      start(fake);
      await flush();
      expect(loadSeenPlayers()).toEqual([{ id: "spotify.exe", name: "Spotify" }]);
    });

    it("hiding the player being shown sends null at once, and never the hidden song again", async () => {
      const fake = fakeWs();
      current = playing();
      start(fake);
      await flush();
      expect(fake.sent).toHaveLength(1);

      // The host skips the hidden player, so the next read finds nothing.
      detect.mockImplementation(async (prefs) =>
        prefs.hidden.includes("spotify.exe") ? NONE : current,
      );
      saveMusicPrefs(withPlayerHidden(loadMusicPrefs(), "spotify.exe", true));
      await flush();
      expect(fake.sent.map((s) => s.listening?.title ?? null)).toEqual(["Blue in Green", null]);
      await vi.advanceTimersByTimeAsync(MUSIC_ACTIVITY_POLL_MS * 2);
      expect(fake.sent).toHaveLength(2);
    });

    it("a song from a player hidden while the read ran is not sent", async () => {
      const fake = fakeWs();
      let release: (r: MediaReading) => void = () => undefined;
      detect.mockImplementation(() => new Promise<MediaReading>((resolve) => (release = resolve)));
      start(fake);
      await flush();
      // The user hides the player while the read is running: it is dropped
      // and one more read runs under the new choice.
      detect.mockImplementation(async () => NONE);
      savePref(MUSIC_PREFS_KEY, { hidden: ["spotify.exe"] });
      release(playing());
      await flush();
      await flush();
      expect(fake.sent).toHaveLength(0);
    });

    it("showing a hidden player again sends its song", async () => {
      const fake = fakeWs();
      saveMusicPrefs({ hidden: ["spotify.exe"] });
      detect.mockImplementation(async (prefs) =>
        prefs.hidden.includes("spotify.exe") ? NONE : current,
      );
      current = playing();
      start(fake);
      await flush();
      expect(fake.sent).toHaveLength(0);
      saveMusicPrefs({ hidden: [] });
      await flush();
      expect(fake.sent.map((s) => s.listening?.title)).toEqual(["Blue in Green"]);
    });

    it("a hidden player's song is not sent even if an older host returns it", async () => {
      const fake = fakeWs();
      saveMusicPrefs({ hidden: ["Spotify.exe"] });
      current = playing();
      start(fake);
      await flush();
      expect(fake.sent).toHaveLength(0);
      expect(loadSeenPlayers()).toEqual([]);
    });
  });

  it("stops everything on destroy and sends nothing", async () => {
    const fake = fakeWs();
    current = playing();
    start(fake);
    await flush();
    loop?.destroy();
    detect.mockClear();
    fake.setState("reconnecting");
    fake.setState("connected");
    savePref(MUSIC_ACTIVITY_PREF_KEY, false);
    await vi.advanceTimersByTimeAsync(MUSIC_ACTIVITY_POLL_MS * 3);
    expect(detect).not.toHaveBeenCalled();
    expect(fake.sent).toHaveLength(1);
    // The refusal slot is free again.
    expect(handleActivityRefusal("RATE_LIMITED", "id-1")).toBe(false);
    // The history key is the one the Settings list reads.
    expect(MUSIC_SEEN_KEY).toBe("musicActivitySeen");
  });
});
