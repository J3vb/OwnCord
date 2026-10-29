/**
 * The video grid, loaded on first use. A synchronous stand-in for
 * `VideoGridComponent` that keeps the latest value of each piece of grid
 * state until the real grid's code has loaded, replays it into a fresh grid in
 * one run, and then forwards every call. Callers keep their types and their
 * synchronous code.
 *
 * Not a call queue: a stream added and removed before load is never drawn, and
 * a setting written ten times is replayed once. Two calls are not pure grid
 * state and still reach the voice layer at once, because the stream does not
 * arrive without them: `watch` (it subscribes the track) and `clearStreams`
 * (it forgets the watch of every tile it drops).
 *
 * The module is imported only as a type here, so it stays out of the
 * main-page chunk; `tests/unit/lazy-screens-structure.test.ts` pins that.
 */

import { createLazyScreen } from "@components/lazyScreen";
import { createLogger } from "@lib/logger";
import type {
  CallState,
  GridPerson,
  TileConfig,
  VideoGridCallbacks,
  VideoGridComponent,
} from "@components/VideoGrid";

export interface LazyVideoGrid extends VideoGridComponent {
  /** Start loading the grid's code (idempotent). Called when the user joins
   *  voice, so the import overlaps the connect. */
  ensureLoaded(): void;
}

interface PendingStream {
  username: string;
  /** A setLabel since the last addStream: replayed after it. */
  relabel: { readonly username: string; readonly name: string | undefined } | undefined;
  stream: MediaStream | null;
  config: TileConfig | undefined;
}

const log = createLogger("lazy-video-grid");

/** A stream whose video track ended while the grid was loading is replayed as
 *  a tile offered without a stream, not as a dead one. */
function liveOrNull(stream: MediaStream | null): MediaStream | null {
  if (stream === null) return null;
  return stream.getVideoTracks()[0]?.readyState === "ended" ? null : stream;
}

const videoGridScreen = createLazyScreen("video-grid", () => import("@components/VideoGrid"));

export function createLazyVideoGrid(): LazyVideoGrid {
  let real: VideoGridComponent | null = null;
  let disposed = false;
  let loading = false;
  /** The last load failed: only a join (ensureLoaded) or a user's own action
   *  tries again, so track and roster events cannot re-toast. */
  let failed = false;

  // The latest value of each piece of grid state, until the grid exists.
  let slot: Element | null = null;
  let callbacks: VideoGridCallbacks | null = null;
  let callState: CallState | null = null;
  let exitVisible = false;
  let people: readonly GridPerson[] = [];
  let speaking: ReadonlySet<number> | null = null;
  let audioState: ReadonlyMap<number, { muted: boolean; deafened: boolean }> | null = null;
  let viewers: ReadonlyMap<number, readonly string[]> | null = null;
  let focusedTileId: number | null = null;
  /** Insertion order is the replay order; an update keeps its place. */
  const streams = new Map<number, PendingStream>();
  /** Watches asked for before the grid exists (a tile that has not arrived,
   *  or one that is up as a null stream). Removed with the stream. */
  const watches = new Set<number>();

  function forgetWatch(tileId: number): void {
    if (callbacks?.forgetStreamWatch !== undefined) callbacks.forgetStreamWatch(tileId);
    else callbacks?.setStreamWatched?.(tileId, false);
  }

  function dropRecorded(): void {
    streams.clear();
    watches.clear();
    slot = null;
    callbacks = null;
    callState = null;
    people = [];
    speaking = null;
    audioState = null;
    viewers = null;
    focusedTileId = null;
  }

  function replayInto(grid: VideoGridComponent): void {
    if (slot !== null) grid.mount(slot);
    // Callbacks first: addStream and watch call them.
    if (callbacks !== null) grid.setCallbacks(callbacks);
    if (callState !== null) grid.setCallState(callState);
    if (exitVisible) grid.setExitVisible(true);
    if (audioState !== null) grid.setUserAudioState(audioState);
    if (viewers !== null) grid.setStreamViewers(viewers);
    if (speaking !== null) grid.setSpeaking(speaking);
    if (people.length > 0) grid.setPeople(people);
    for (const [tileId, s] of streams) {
      grid.addStream(tileId, s.username, liveOrNull(s.stream), s.config);
      if (s.relabel !== undefined) grid.setLabel(tileId, s.relabel.username, s.relabel.name);
    }
    if (focusedTileId !== null) grid.setFocusedTile(focusedTileId);
    // setRemoteVideoWatched is idempotent for "on", so the second
    // setStreamWatched this makes for a still-pending watch is harmless.
    for (const tileId of watches) grid.watch(tileId);
  }

  function load(automatic: boolean): void {
    if (real !== null || loading || disposed) return;
    if (automatic && failed) return;
    loading = true;
    void videoGridScreen
      .load(() => !disposed)
      .then((mod) => {
        try {
          if (mod === null) {
            failed = true;
            return;
          }
          if (disposed || real !== null) return;
          const grid = mod.createVideoGrid();
          try {
            replayInto(grid);
          } catch (err) {
            try {
              grid.destroy?.();
            } catch {
              // Already failing; the recorded state stays for the next try.
            }
            throw err;
          }
          real = grid;
          failed = false;
          dropRecorded();
        } catch (err) {
          failed = true;
          log.error("Failed to start the video grid", { error: String(err) });
        } finally {
          loading = false;
        }
      });
  }

  /** A join: the import starts, and a failed one tries again. */
  function ensureLoaded(): void {
    load(false);
  }

  return {
    ensureLoaded,

    mount(container: Element): void {
      if (real !== null) {
        real.mount(container);
        return;
      }
      slot = container;
    },

    destroy(): void {
      disposed = true;
      if (real !== null) real.destroy?.();
      real = null;
      dropRecorded();
    },

    addStream(userId, username, stream, config): void {
      if (real !== null) {
        real.addStream(userId, username, stream, config);
        return;
      }
      // A new tile consumes a pending watch, as the real grid does. An
      // update keeps its place, and names the tile again from this call.
      if (!streams.has(userId)) watches.delete(userId);
      streams.set(userId, { username, relabel: undefined, stream, config });
      load(true);
    },

    watch(tileId): void {
      if (real !== null) {
        real.watch(tileId);
        return;
      }
      const entry = streams.get(tileId);
      if (entry?.config?.isSelf === true) return;
      watches.add(tileId);
      // Subscribing the track is what makes the stream arrive: do it now.
      callbacks?.setStreamWatched?.(tileId, true);
      load(false);
    },

    setLabel(userId, username, name): void {
      if (real !== null) {
        real.setLabel(userId, username, name);
        return;
      }
      const entry = streams.get(userId);
      if (entry === undefined) return;
      entry.relabel = { username, name };
    },

    removeStream(userId): void {
      if (real !== null) {
        real.removeStream(userId);
        return;
      }
      watches.delete(userId);
      const entry = streams.get(userId);
      if (entry === undefined) return;
      streams.delete(userId);
      if (entry.config !== undefined && entry.config.isSelf !== true) forgetWatch(userId);
      if (focusedTileId === userId) focusedTileId = firstTile();
    },

    clearStreams(): void {
      if (real !== null) {
        real.clearStreams();
        return;
      }
      // A watch whose tile never arrived, then each tile the grid would drop.
      for (const [tileId, entry] of streams) {
        if (entry.config !== undefined && entry.config.isSelf !== true) forgetWatch(tileId);
      }
      for (const tileId of watches) if (!streams.has(tileId)) forgetWatch(tileId);
      watches.clear();
      streams.clear();
      focusedTileId = null;
    },

    hasStreams: (): boolean => (real !== null ? real.hasStreams() : streams.size > 0),

    setFocusedTile(tileId): void {
      if (real !== null) {
        real.setFocusedTile(tileId);
        return;
      }
      focusedTileId = tileId;
      if (tileId !== null) load(true);
    },

    getFocusedTileId: (): number | null =>
      real !== null ? real.getFocusedTileId() : focusedTileId,

    setPeople(next): void {
      if (real !== null) {
        real.setPeople(next);
        return;
      }
      people = next;
      if (next.length > 0) load(true);
    },

    setSpeaking(userIds): void {
      if (real !== null) real.setSpeaking(userIds);
      else speaking = userIds;
    },

    setUserAudioState(state): void {
      if (real !== null) real.setUserAudioState(state);
      else audioState = state;
    },

    setStreamViewers(next): void {
      if (real !== null) real.setStreamViewers(next);
      else viewers = next;
    },

    setCallbacks(next): void {
      if (real !== null) real.setCallbacks(next);
      else callbacks = next;
    },

    setCallState(state): void {
      if (real !== null) real.setCallState(state);
      else callState = state;
    },

    setExitVisible(visible): void {
      if (real !== null) {
        real.setExitVisible(visible);
        return;
      }
      exitVisible = visible;
      if (visible) load(false);
    },

    // Nothing can be playing in a grid that is not there yet.
    showMiniPlayer(): void {
      real?.showMiniPlayer();
    },
    hideMiniPlayer(): void {
      real?.hideMiniPlayer();
    },
    raiseCallPopout: (): boolean => real?.raiseCallPopout() ?? false,
  };

  function firstTile(): number | null {
    for (const id of streams.keys()) return id;
    return null;
  }
}
