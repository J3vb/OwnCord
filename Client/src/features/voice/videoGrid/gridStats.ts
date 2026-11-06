/**
 * The video grid's stream stats: polling the screen share being watched and
 * the quality chip's readout.
 */
import { isImeCommit } from "@lib/text/ime";
import { createElement } from "@lib/dom";
import { voiceText } from "../../../i18n/voice";
import type { StreamSample } from "../remoteTracks";
import type { GridState } from "@components/video-grid/gridState";

/** What the stats poller takes from the grid's shared helpers. */
export interface GridStatsDeps {
  readonly pollMs: number;
  readonly log: typeof import("@components/video-grid/gridShared").log;
  readonly sizeOf: typeof import("@components/video-grid/gridShared").sizeOf;
  readonly loadInfo: () => Promise<typeof import("@components/video-grid/streamInfo")>;
}

export function createGridStats(st: GridState, deps: GridStatsDeps) {
  const { pollMs, log, sizeOf, loadInfo } = deps;
  /** Poll the screen share you are watching (focused or full screen), and
   *  only it: a camera tile has no quality chip. */
  function syncStatsPolling(): void {
    const target = st.fullscreenTile ?? st.theatreTile ?? st.focusedTileId;
    const entry = target === null ? undefined : st.cells.get(target);
    const wanted =
      entry?.config?.isScreenshare === true && !entry.config.isSelf && entry.ending === undefined
        ? target
        : null;
    if (wanted === st.statsTile) return;
    if (st.statsTimer !== null) {
      clearInterval(st.statsTimer);
      st.statsTimer = null;
    }
    st.statsTile = wanted;
    if (wanted === null) return;
    const poll = (): void => void pollStats(wanted);
    poll();
    st.statsTimer = setInterval(poll, pollMs);
  }

  async function pollStats(tileId: number): Promise<void> {
    const entry = st.cells.get(tileId);
    if (entry === undefined) return;
    let sample: StreamSample | null = null;
    try {
      sample = (await st.callbacks.getStreamStats?.(tileId)) ?? null;
    } catch (err) {
      log.debug("Stream stats unavailable", { tileId, err });
    }
    // Loaded on first use: only a watched stream needs the readout.
    try {
      st.infoModule ??= await loadInfo();
    } catch (err) {
      log.debug("Stream info unavailable", { tileId, err });
      return;
    }
    const { chipText, renderStats, streamInfo } = st.infoModule;
    if (st.statsTile !== tileId || st.cells.get(tileId) !== entry) return;
    const info = sample !== null ? streamInfo(sample, entry.prevSample) : sizeOf(entry.video);
    if (sample !== null) entry.prevSample = sample;
    const chip = entry.el.querySelector<HTMLButtonElement>(".video-quality");
    const text = chipText(info);
    if (chip !== null) {
      chip.hidden = text === null;
      if (text !== null) {
        chip.textContent = text.text;
        chip.setAttribute("aria-label", text.label);
      }
    }
    const pop = entry.el.querySelector<HTMLElement>(".video-stats");
    if (pop !== null) renderStats(pop, entry.name, info);
    st.lastInfo.set(tileId, info);
  }

  function toggleStats(tileId: number, chip: HTMLButtonElement): void {
    const entry = st.cells.get(tileId);
    if (entry === undefined) return;
    const open = entry.el.querySelector<HTMLElement>(".video-stats");
    if (open !== null) {
      open.remove();
      chip.setAttribute("aria-expanded", "false");
      return;
    }
    const pop = createElement("div", {
      class: "video-stats",
      role: "dialog",
      "aria-label": voiceText("tile.stats"),
      tabindex: "-1",
    });
    st.infoModule?.renderStats(pop, entry.name, st.lastInfo.get(tileId) ?? {});
    pop.addEventListener(
      "keydown",
      (e) => {
        if (e.key !== "Escape" || isImeCommit(e)) return;
        e.stopPropagation();
        pop.remove();
        chip.setAttribute("aria-expanded", "false");
        chip.focus();
      },
      { signal: entry.listeners.signal },
    );
    entry.el.appendChild(pop);
    chip.setAttribute("aria-expanded", "true");
    pop.focus();
  }

  return { syncStatsPolling, pollStats, toggleStats };
}
