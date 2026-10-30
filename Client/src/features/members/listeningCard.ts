/**
 * The profile card for a song: title, "by <artist>", and a progress
 * bar when the length is known. For a song with a length it ticks the elapsed
 * time once a second until the owner stops it.
 */

import { listeningDetailsText as t } from "../../i18n/listeningDetails";
import { createIcon } from "../../lib/icons";
import { appendChildren, createElement, setText } from "../../lib/dom";
import { listeningLine, type ListeningSong } from "./listeningLine";

/** "m:ss", or "h:mm:ss" from an hour on. Never negative. */
export function formatClock(ms: number): string {
  const total = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`
    : `${minutes}:${seconds}`;
}

/** How far into the song it is: elapsed clamped to [0, duration], and the
 *  fraction. A song of unknown length has no fraction. */
export function listeningProgress(
  song: Pick<ListeningSong, "startedAt" | "durationMs">,
  nowMs: number,
): { readonly elapsedMs: number; readonly ratio: number | null } {
  const raw = Number.isFinite(nowMs - song.startedAt) ? nowMs - song.startedAt : 0;
  if (song.durationMs <= 0) return { elapsedMs: Math.max(0, raw), ratio: null };
  const elapsedMs = Math.min(Math.max(0, raw), song.durationMs);
  return { elapsedMs, ratio: elapsedMs / song.durationMs };
}

/** One tick of the card. */
export const LISTENING_TICK_MS = 1000;

export interface ListeningCardOptions {
  /** CSS class prefix of the surface: `upp` or `dps`. */
  readonly prefix: string;
  /** The clock. Defaults to `Date.now`. */
  readonly now?: () => number;
}

/**
 * Draw the song card into `host` (replacing its children) and, when the song
 * has a length, tick its elapsed time every second. Returns the stop function:
 * it clears the timer and must be called when the surface closes or repaints.
 * Calling it twice is harmless.
 */
export function mountListeningCard(
  host: HTMLElement,
  song: ListeningSong,
  options: ListeningCardOptions,
): () => void {
  const { prefix } = options;
  const now = options.now ?? Date.now;
  host.replaceChildren();

  const head = createElement("div", { class: `${prefix}-listening-head` });
  const icon = createIcon("music", 14);
  icon.setAttribute("aria-hidden", "true");
  icon.classList.add(`${prefix}-listening-icon`);
  const label = createElement("span", { class: `${prefix}-listening-label` });
  setText(label, listeningLine(song));
  appendChildren(head, icon, label);

  const title = createElement("div", { class: `${prefix}-listening-title`, title: song.title });
  setText(title, song.title);
  appendChildren(host, head, title);

  if (song.artist !== "") {
    const artist = createElement("div", { class: `${prefix}-listening-artist` });
    setText(artist, t("by.artist", { artist: song.artist }));
    host.appendChild(artist);
  }

  if (song.durationMs <= 0) return () => undefined;

  const track = createElement("div", {
    class: `${prefix}-listening-bar`,
    role: "progressbar",
    "aria-valuemin": "0",
    "aria-valuemax": String(Math.round(song.durationMs / 1000)),
  });
  const fill = createElement("div", { class: `${prefix}-listening-fill` });
  track.appendChild(fill);
  const time = createElement("div", { class: `${prefix}-listening-time` });
  appendChildren(host, track, time);

  const total = formatClock(song.durationMs);
  const paint = (): void => {
    const { elapsedMs, ratio } = listeningProgress(song, now());
    const elapsed = formatClock(elapsedMs);
    setText(time, t("progress.text", { elapsed, total }));
    fill.style.width = `${Math.round((ratio ?? 0) * 1000) / 10}%`;
    track.setAttribute("aria-valuenow", String(Math.floor(elapsedMs / 1000)));
    track.setAttribute("aria-valuetext", t("progress.aria", { elapsed, total }));
  };
  paint();

  let timer: ReturnType<typeof setInterval> | null = setInterval(paint, LISTENING_TICK_MS);
  return () => {
    if (timer === null) return;
    clearInterval(timer);
    timer = null;
  };
}
