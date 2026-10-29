/**
 * Game activity loop (WP 8.3c): tells the server which game this device is
 * running, so other members see "Playing <game>".
 *
 * Every `intervalMs` it asks the platform's detector for the running game and
 * sends an `activity_update` only when the answer differs from what the server
 * was last told. A game that goes away sends `null`.
 *
 *  - Off means off: with the setting off, or a server without the
 *    `game_activity` capability, nothing is scanned and nothing is sent.
 *    Turning the setting off sends `null` at once so the game does not linger.
 *  - The server forgets the activity with the connection, so every successful
 *    (re)connect starts from "the server has nothing" and the current game is
 *    sent again. Each connection is an epoch: a detection that began under an
 *    earlier one is dropped when it answers, never sent on the new socket (the
 *    per-attempt ownership `ws.ts` keeps with its generation counter).
 *  - The user's own choices (WP 8.3d, `gameActivityPrefs`) apply here: manual
 *    programs and hidden names go to the detector with every scan, a rename is
 *    applied to the name before it is sent, and any change scans at once, so
 *    hiding the game being shown sends the next game or `null` in one frame
 *    (never the hidden name again). Every detected name is added to the device's history for the
 *    Settings list.
 *  - An admin can turn game activity off for the whole server (WP 8.3e-2). The
 *    server clears every shown game itself, so the loop sends nothing, not even
 *    a `null`: it stops scanning, forgets what it sent, and sends the current
 *    game again at once when the switch comes back on. A set that arrives
 *    while it is off (a client that missed the off frame) is refused with
 *    `GAME_ACTIVITY_DISABLED` and asked again on the next poll.
 *  - The server limits a set to one per 10 s. A refused frame is forgotten, so
 *    the next poll sends whatever is current, even `null`. The dispatcher
 *    routes the refusal here through `gameActivityBridge` and shows no toast.
 *
 * The loop reads no store and writes none: the member's own game comes back as
 * a `presence` frame like everyone else's.
 */

import { Disposable } from "./disposable";
import { createLogger } from "./logger";
import { ServerMessageType as S } from "./protocolTypes";
import {
  GAME_ACTIVITY_PREF_KEY,
  isGameActivityShared,
  setActivityRefusalHandler,
} from "./gameActivityBridge";
import { onGameActivityPolicy, serverSupportsGameActivity } from "./serverCapabilities";
import type { WsClient } from "./ws";
import {
  GAME_PREFS_KEY,
  displayName,
  isHidden,
  loadGamePrefs,
  recordSeen,
  toDetectPrefs,
} from "./gameActivityPrefs";
import type { DetectedGame, DetectPrefs } from "../platform/contracts/gameDetector";
import { onPrefChange } from "./preferences";
import { WsErrorCode } from "@lib/protocolTypes";

const log = createLogger("gameActivity");

/** How often the detector is asked. A game shows within 30 s of starting. */
export const GAME_ACTIVITY_POLL_MS = 15_000;

/** The refusals after which the same frame is worth sending again. A
 *  REQUEST_TIMEOUT is the server's per-frame deadline: the frame was not applied. */
const RETRYABLE_REFUSALS: ReadonlySet<string> = new Set([
  WsErrorCode.RATE_LIMITED,
  WsErrorCode.TIMED_OUT,
  WsErrorCode.REQUEST_TIMEOUT,
  // The switch is off (WP 8.3e-2) but this client missed the off frame: the
  // next poll asks again, so the game shows once the switch is back on. It is
  // not taken as the policy itself, since a refusal can arrive after a newer
  // game_activity_policy true.
  WsErrorCode.GAME_ACTIVITY_DISABLED,
]);

/** The longest name the server accepts, in characters. */
const MAX_NAME_CHARS = 128;

/** The name as the server will show it: the user's rename if any, trimmed, and
 *  cut at its limit by whole characters so a long title is shortened rather
 *  than refused. */
function shownName(name: string): string {
  return Array.from(name.trim()).slice(0, MAX_NAME_CHARS).join("");
}

/** Frames kept for matching a refusal to its send. */
const MAX_TRACKED_FRAMES = 8;

export interface GameActivityOptions {
  readonly ws: Pick<WsClient, "send" | "on" | "onStateChange" | "getState">;
  /** The running game; never rejects (a failed scan reads as null), but a
   *  rejection is handled here too. */
  readonly detect: (prefs: DetectPrefs) => Promise<DetectedGame | null>;
  /** Poll interval. Defaults to `GAME_ACTIVITY_POLL_MS`. */
  readonly intervalMs?: number;
  /** Whether the setting is on. Defaults to the device preference. */
  readonly enabled?: () => boolean;
  /** Whether the server advertises `game_activity`. Defaults to the ready's flag. */
  readonly supported?: () => boolean;
}

export interface GameActivityLoop {
  /** Stop polling and unregister. Sends nothing: the server clears the game
   *  with the connection. */
  destroy(): void;
}

/**
 * Start the loop. The caller owns it and calls `destroy` on teardown (the
 * signed-in page's teardown).
 */
export function startGameActivity(options: GameActivityOptions): GameActivityLoop {
  const { ws, detect } = options;
  const enabled = options.enabled ?? isGameActivityShared;
  const supported = options.supported ?? serverSupportsGameActivity;
  const disposable = new Disposable();

  /** The name the server shows for this connection: null = nothing, undefined
   *  = unknown (a refused frame), where the next poll sends the current answer
   *  even when it is "no game". */
  let lastSent: string | null | undefined = null;
  /** The detected name behind `lastSent`. Two games renamed to one name are
   *  still two games: a switch between them clears first, so the server starts
   *  the new one's clock instead of keeping the old one's. */
  let lastDetected: string | null = null;
  /** The user's game choices changed while a scan was running: that scan
   *  answered under the old ones, so its answer is dropped and one more scan
   *  runs at once. */
  let rescan = false;
  /** Counts connections (and drops of one). A detection that started under an
   *  older count belongs to a connection that is gone. */
  let epoch = 0;
  /** The epoch a scan is running for, or null. A scan from an older epoch does
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

  /** Send the shown game (`name` is already renamed and trimmed) or the clear. */
  function transmit(game: DetectedGame | null, name: string | null): void {
    try {
      const id = ws.send({
        type: "activity_update",
        payload: {
          activity:
            game === null || name === null
              ? null
              : { name, started_at: Math.trunc(game.startedAtMs) },
        },
      });
      remember(id);
      lastSent = name;
      lastDetected = game === null || name === null ? null : game.name;
    } catch (err) {
      // The socket dropped between the check and the send; the next
      // connection starts over.
      log.warn("activity_update not sent", { error: err instanceof Error ? err.message : "" });
    }
  }

  async function poll(): Promise<void> {
    if (scanning === epoch || !live() || !active()) return;
    const mine = epoch;
    scanning = mine;
    try {
      let game: DetectedGame | null = null;
      try {
        game = await detect(toDetectPrefs(loadGamePrefs()));
      } catch {
        // A failed scan is "no game".
        game = null;
      }
      // The connection, the setting or the server may have changed while the
      // scan ran; a stale answer is dropped, the next poll asks again.
      if (mine !== epoch || !live() || !active()) return;
      // The choices changed under this scan: it knows nothing of them, and the
      // scan queued below decides what is sent (one frame, not two).
      if (rescan) return;
      // The choices are read again: a game hidden while the scan ran (or one
      // an older host does not skip) is not shown.
      const prefs = loadGamePrefs();
      if (game !== null && isHidden(prefs, game.name)) game = null;
      // A name that trims to nothing is no game.
      const name = game === null ? null : shownName(displayName(prefs, game.name));
      if (name === "") game = null;
      // A program added by hand is already in the list as itself.
      if (game !== null && game.source !== "manual") recordSeen(game.name);
      if (game === null || name === null) {
        if (lastSent === null) return;
        transmit(null, null);
        return;
      }
      if (name === lastSent) {
        if (game.name === lastDetected) return;
        // Another game under the same shown name: a clear (never limited)
        // lets the set below start its own clock.
        transmit(null, null);
      }
      transmit(game, name);
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
      // know whether a game was sent.
      if (live() && supported() && lastSent !== null) transmit(null, null);
      return;
    }
    void poll();
  }

  /** The user's game choices changed. A scan now answers under the new ones:
   *  a game just hidden is replaced by the next one the host finds, or cleared,
   *  in one frame, and the hidden name is never sent again. A scan already
   *  running is dropped for a fresh one. */
  function onGamePrefsChanged(): void {
    if (destroyed || !enabled()) return;
    if (scanning === epoch) rescan = true;
    else void poll();
  }

  const unsubState = ws.onStateChange((state) => {
    epoch += 1;
    if (state !== "connected") return;
    // A new connection: the server starts it with no activity.
    lastSent = null;
    lastDetected = null;
    sentIds.length = 0;
    void poll();
  });
  // A first connect learns the capability from `ready`, which lands after the
  // connection is up. Read-only: this handler only starts a poll.
  const unsubReady = ws.on(S.READY, () => {
    void poll();
  });

  // An admin turned game activity off or on for the server (WP 8.3e-2). Off:
  // the server already cleared the game, so nothing is sent, not even a null;
  // `supported` reads false and the loop stops scanning. Either way the server
  // holds nothing for this connection, so the shown game is forgotten and, on
  // true, sent again at once. Read-only: this handler only starts a poll.
  const unsubPolicy = onGameActivityPolicy((nowOn) => {
    if (destroyed) return;
    lastSent = null;
    lastDetected = null;
    if (nowOn) void poll();
  });
  disposable.addCleanup(unsubPolicy);

  const timer = setInterval(() => void poll(), options.intervalMs ?? GAME_ACTIVITY_POLL_MS);

  disposable.addCleanup(unsubState);
  disposable.addCleanup(unsubReady);
  disposable.addCleanup(() => clearInterval(timer));
  onPrefChange(
    [GAME_ACTIVITY_PREF_KEY, GAME_PREFS_KEY],
    (key) => {
      if (key === GAME_ACTIVITY_PREF_KEY) onSettingChanged();
      else onGamePrefsChanged();
    },
    disposable.signal,
  );

  setActivityRefusalHandler((code, id) => {
    if (destroyed || id === undefined) return false;
    const at = sentIds.indexOf(id);
    if (at === -1) return false;
    sentIds.splice(at, 1);
    if (RETRYABLE_REFUSALS.has(code)) lastSent = undefined;
    log.debug("activity_update refused", { code });
    return true;
  });
  disposable.addCleanup(() => setActivityRefusalHandler(null));

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
