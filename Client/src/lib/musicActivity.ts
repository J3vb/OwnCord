/**
 * Music activity loop: tells the server which song this device is
 * playing, so other members see "Listening to <player>".
 *
 * Every `intervalMs` it asks the platform's media detector for the song and
 * sends a `listening_update` only when the title, artist or player differs
 * from what the server was last told (a seek or a new position is no change).
 * A song that stops or pauses sends `null` at once.
 *
 *  - Off means off: with the setting off, or a server without the
 *    `listening_activity` capability, nothing is read and nothing is sent.
 *    Turning the setting off sends `null` immediately so the song does not
 *    linger.
 *  - "Unknown" (the host's read failed or is still running) is neither a song
 *    nor a stop: the loop keeps what it showed and sends nothing.
 *  - The server forgets the song with the connection, so every successful
 *    (re)connect starts from "the server has nothing" and the current song is
 *    sent again. Each connection is an epoch: a read that began under an
 *    earlier one is dropped when it answers, never sent on the new socket
 *    (the per-attempt ownership `ws.ts` keeps with its generation counter).
 *  - The player choices (`musicActivityPrefs`) apply here: hidden player ids
 *    go to the host with every read, a change of them reads at once, and a
 *    song from a player hidden meanwhile is never sent. Every player seen is
 *    added to the device's history for the Settings list.
 *  - The same admin switch covers games and music: when it goes
 *    off the server clears the song itself, so the loop sends nothing, not
 *    even a `null`; it stops reading, forgets what it sent, and sends the
 *    current song again when the switch comes back on. A set that arrives
 *    while it is off is refused with `GAME_ACTIVITY_DISABLED` and asked again
 *    on the next poll.
 *  - The server limits a set to one per 10 s. A refused frame is forgotten, so
 *    the next poll sends whatever is playing then, even `null`: only the
 *    latest song is ever sent, never a queue of the songs skipped meanwhile.
 *    The dispatcher routes the refusal here through `gameActivityBridge` and
 *    shows no toast.
 *
 * The loop reads no store and writes none: the member's own song comes back as
 * a `presence` frame like everyone else's.
 */

import { Disposable } from "./disposable";
import { createLogger } from "./logger";
import { ServerMessageType as S } from "./protocolTypes";
import { setMusicRefusalHandler } from "./gameActivityBridge";
import { onGameActivityPolicy, serverSupportsListeningActivity } from "./serverCapabilities";
import type { WsClient } from "./ws";
import {
  MUSIC_ACTIVITY_PREF_KEY,
  MUSIC_PREFS_KEY,
  isMusicActivityShared,
  isPlayerHidden,
  loadMusicPrefs,
  recordSeenPlayer,
  toMediaPrefs,
} from "./musicActivityPrefs";
import type { MediaPrefs, MediaReading } from "../platform/contracts/mediaDetector";
import { onPrefChange } from "./preferences";
import { WsErrorCode } from "@lib/protocolTypes";

const log = createLogger("musicActivity");

/** How often the detector is asked. A song shows within 10 s of starting. */
export const MUSIC_ACTIVITY_POLL_MS = 10_000;

/** The refusals after which the same frame is worth sending again. A
 *  REQUEST_TIMEOUT is the server's per-frame deadline: the frame was not applied. */
const RETRYABLE_REFUSALS: ReadonlySet<string> = new Set([
  WsErrorCode.RATE_LIMITED,
  WsErrorCode.TIMED_OUT,
  WsErrorCode.REQUEST_TIMEOUT,
  // The switch is off but this client missed the off frame: the next poll asks
  // again, so the song shows once the switch is back on. It is not taken as
  // the policy itself, since a refusal can arrive after a newer
  // game_activity_policy true.
  WsErrorCode.GAME_ACTIVITY_DISABLED,
]);

/** The longest text the server accepts, in characters. */
const MAX_TITLE_CHARS = 128;
const MAX_PLAYER_CHARS = 64;

/** Frames kept for matching a refusal to its send. */
const MAX_TRACKED_FRAMES = 8;

/** Text as the server will show it: trimmed and cut at its limit by whole
 *  characters, so a long title is shortened rather than refused. */
function clip(text: string, max: number): string {
  return Array.from(text.trim()).slice(0, max).join("");
}

/** A song as it will be sent (before the start time is known). */
interface Song {
  readonly title: string;
  readonly artist: string;
  readonly player: string;
  readonly positionMs: number;
  readonly durationMs: number;
}

/** What the server shows for a song: the same key means the same shown song. */
function songKey(song: Pick<Song, "title" | "artist" | "player">): string {
  return JSON.stringify([song.title, song.artist, song.player]);
}

export interface MusicActivityOptions {
  readonly ws: Pick<WsClient, "send" | "on" | "onStateChange" | "getState">;
  /** The song playing; never rejects (a failed read is "unknown"), but a
   *  rejection is handled here too. */
  readonly detect: (prefs: MediaPrefs) => Promise<MediaReading>;
  /** Poll interval. Defaults to `MUSIC_ACTIVITY_POLL_MS`. */
  readonly intervalMs?: number;
  /** Whether the setting is on. Defaults to the device preference. */
  readonly enabled?: () => boolean;
  /** Whether the server advertises `listening_activity`. Defaults to the ready's flag. */
  readonly supported?: () => boolean;
}

export interface MusicActivityLoop {
  /** Stop polling and unregister. Sends nothing: the server clears the song
   *  with the connection. */
  destroy(): void;
}

/** The song a reading holds, cleaned for the wire, or null for none. */
function songOf(reading: MediaReading, prefs: ReturnType<typeof loadMusicPrefs>): Song | null {
  if (reading.state !== "playing") return null;
  // A player hidden while the read ran (or one an older host does not skip).
  if (isPlayerHidden(prefs, reading.playerId)) return null;
  const title = clip(reading.title, MAX_TITLE_CHARS);
  const player = clip(reading.player, MAX_PLAYER_CHARS);
  // The server needs a title and a player; without either there is no song.
  if (title === "" || player === "") return null;
  return {
    title,
    artist: clip(reading.artist, MAX_TITLE_CHARS),
    player,
    positionMs: reading.positionMs,
    durationMs: reading.durationMs,
  };
}

/**
 * Start the loop. The caller owns it and calls `destroy` on teardown (the
 * signed-in page's teardown).
 */
export function startMusicActivity(options: MusicActivityOptions): MusicActivityLoop {
  const { ws, detect } = options;
  const enabled = options.enabled ?? isMusicActivityShared;
  const supported = options.supported ?? serverSupportsListeningActivity;
  const disposable = new Disposable();

  /** The key of the song the server shows for this connection: null = nothing,
   *  undefined = unknown (a refused frame), where the next poll sends the
   *  current answer even when it is "nothing". */
  let lastSent: string | null | undefined = null;
  /** The player choices changed while a read was running: that read answered
   *  under the old ones, so its answer is dropped and one more read runs at
   *  once. */
  let rescan = false;
  /** Counts connections (and drops of one). A read that started under an older
   *  count belongs to a connection that is gone. */
  let epoch = 0;
  /** The epoch a read is running for, or null. A read from an older epoch does
   *  not hold up the current connection's own. */
  let scanning: number | null = null;
  let destroyed = false;
  /** Envelope ids of the frames on the wire, to claim their refusals. */
  const sentIds: string[] = [];

  const live = (): boolean => !destroyed && ws.getState() === "connected";
  const active = (): boolean => enabled() && supported();

  function remember(id: string): void {
    sentIds.push(id);
    if (sentIds.length > MAX_TRACKED_FRAMES) sentIds.shift();
  }

  /** Send the shown song, or the clear when `song` is null. */
  function transmit(song: Song | null): void {
    try {
      const id = ws.send({
        type: "listening_update",
        payload: {
          listening:
            song === null
              ? null
              : {
                  title: song.title,
                  artist: song.artist,
                  player: song.player,
                  started_at: Math.trunc(Date.now() - song.positionMs),
                  duration_ms: Math.trunc(song.durationMs),
                },
        },
      });
      remember(id);
      lastSent = song === null ? null : songKey(song);
    } catch (err) {
      // The socket dropped between the check and the send; the next
      // connection starts over.
      log.warn("listening_update not sent", { error: err instanceof Error ? err.message : "" });
    }
  }

  async function poll(): Promise<void> {
    if (scanning === epoch || !live() || !active()) return;
    const mine = epoch;
    scanning = mine;
    try {
      let reading: MediaReading;
      try {
        reading = await detect(toMediaPrefs(loadMusicPrefs()));
      } catch {
        // A failed read is "unknown".
        reading = { state: "unknown" };
      }
      // The connection, the setting or the server may have changed while the
      // read ran; a stale answer is dropped, the next poll asks again.
      if (mine !== epoch || !live() || !active()) return;
      // The choices changed under this read: it knows nothing of them, and the
      // read queued below decides what is sent (one frame, not two).
      if (rescan) return;
      // The host could not say: keep the song the server shows.
      if (reading.state === "unknown") return;
      const song = songOf(reading, loadMusicPrefs());
      if (song !== null && reading.state === "playing")
        recordSeenPlayer(reading.playerId, song.player);
      if (song === null) {
        if (lastSent === null) return;
        transmit(null);
        return;
      }
      // The same title, artist and player is the same shown song, whatever
      // the position: a seek must not send.
      if (songKey(song) === lastSent) return;
      transmit(song);
    } finally {
      if (scanning === mine) scanning = null;
      if (rescan && mine === epoch) {
        rescan = false;
        void poll();
      } else if (mine !== epoch) {
        rescan = false;
      }
    }
  }

  /** The setting changed. Off sends the clear at once; on looks right now. */
  function onSettingChanged(): void {
    if (destroyed) return;
    if (!enabled()) {
      // A clear is free on the server when nothing is shown, so no need to
      // know whether a song was sent.
      if (live() && supported() && lastSent !== null) transmit(null);
      return;
    }
    void poll();
  }

  /** The user's player choices changed. A read now answers under the new ones:
   *  a song just hidden is replaced by the next player's, or cleared, in one
   *  frame, and the hidden player is never sent again. A read already running
   *  is dropped for a fresh one. */
  function onPlayerPrefsChanged(): void {
    if (destroyed || !enabled()) return;
    if (scanning === epoch) rescan = true;
    else void poll();
  }

  const unsubState = ws.onStateChange((state) => {
    epoch += 1;
    if (state !== "connected") return;
    // A new connection: the server starts it with no song.
    lastSent = null;
    sentIds.length = 0;
    void poll();
  });
  // A first connect learns the capability from `ready`, which lands after the
  // connection is up. Read-only: this handler only starts a poll.
  const unsubReady = ws.on(S.READY, () => {
    void poll();
  });

  // An admin turned member activity off or on for the server. Off: the server
  // already cleared the song, so nothing is sent, not even a null; `supported`
  // reads false and the loop stops reading. Either way the server holds
  // nothing for this connection, so the shown song is forgotten and, on true,
  // sent again at once. Read-only: this handler only starts a poll.
  const unsubPolicy = onGameActivityPolicy((nowOn) => {
    if (destroyed) return;
    lastSent = null;
    if (nowOn) void poll();
  });

  const timer = setInterval(() => void poll(), options.intervalMs ?? MUSIC_ACTIVITY_POLL_MS);

  disposable.addCleanup(unsubPolicy);
  disposable.addCleanup(unsubState);
  disposable.addCleanup(unsubReady);
  disposable.addCleanup(() => clearInterval(timer));
  onPrefChange(
    [MUSIC_ACTIVITY_PREF_KEY, MUSIC_PREFS_KEY],
    (key) => {
      if (key === MUSIC_ACTIVITY_PREF_KEY) onSettingChanged();
      else onPlayerPrefsChanged();
    },
    disposable.signal,
  );

  setMusicRefusalHandler((code, id) => {
    if (destroyed || id === undefined) return false;
    const at = sentIds.indexOf(id);
    if (at === -1) return false;
    sentIds.splice(at, 1);
    if (RETRYABLE_REFUSALS.has(code)) lastSent = undefined;
    log.debug("listening_update refused", { code });
    return true;
  });
  disposable.addCleanup(() => setMusicRefusalHandler(null));

  // A loop started on an open connection (the page mounted late) looks now.
  void poll();

  return {
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      disposable.destroy();
    },
  };
}
