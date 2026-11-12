/**
 * The video grid's per-tile state badges, split from gridStreams.ts: who is
 * speaking, mute/deafen marks and the screen-share viewer count.
 */
import { createElement, setText } from "@lib/dom";
import { createIcon } from "@lib/icons";
import { voiceText } from "../../../i18n/voice";
import { viewersLabel } from "./viewers";
import type { GridState } from "./gridState";

export function createGridBadges(st: GridState) {
  /** Every camera and avatar tile with whose state it marks, or null for a
   *  tile that marks none (a screen share, or a host-drawn avatar). */
  function stateTiles(): [HTMLDivElement, number | null][] {
    const tiles: [HTMLDivElement, number | null][] = [];
    for (const [id, entry] of st.cells) {
      const cfg = entry.config;
      tiles.push([entry.el, cfg?.isScreenshare === true ? null : (cfg?.audioUserId ?? id)]);
    }
    for (const person of st.people) {
      const cell = st.personCells.get(person.userId);
      if (cell !== undefined) {
        tiles.push([cell, person.marksOwnState === true ? null : person.userId]);
      }
    }
    return tiles;
  }

  function applySpeaking(): void {
    for (const [el, userId] of stateTiles()) {
      el.classList.toggle("video-cell--speaking", userId !== null && st.speaking.has(userId));
    }
  }

  /** Draw each camera and avatar tile's mute/deafen badge from the roster
   *  state. */
  function applyUserAudioState(): void {
    for (const [el, userId] of stateTiles()) {
      const state = userId === null ? undefined : st.userAudioState.get(userId);
      let badge = el.querySelector<HTMLElement>("[data-testid='tile-audio-state']");
      if (state === undefined || (!state.muted && !state.deafened)) {
        badge?.remove();
        continue;
      }
      if (badge === null) {
        badge = createElement("span", {
          class: "video-cell__audio",
          "data-testid": "tile-audio-state",
          "aria-hidden": "true",
        });
        el.appendChild(badge);
      }
      badge.classList.toggle("video-cell__audio--muted", !state.deafened);
      badge.classList.toggle("video-cell__audio--deafened", state.deafened);
      while (badge.firstChild) badge.removeChild(badge.firstChild);
      badge.appendChild(createIcon(state.deafened ? "headphones-off" : "mic-off", 14));
    }
  }

  /** Draw each screen-share tile's viewer badge: the other members watching
   *  it, and you while a remote share plays here. Hidden at zero. */
  function applyStreamViewers(): void {
    for (const entry of st.cells.values()) {
      const config = entry.config;
      if (config?.isScreenshare !== true) continue;
      const badge = entry.el.querySelector<HTMLElement>(".video-viewers");
      if (badge === null) continue;
      const names = [...(st.streamViewers.get(config.audioUserId) ?? [])];
      if (!config.isSelf && !entry.el.classList.contains("video-cell--stopped")) {
        names.unshift(voiceText("tile.viewersYou"));
      }
      badge.hidden = names.length === 0;
      entry.el.classList.toggle("video-cell--has-viewers", names.length > 0);
      if (names.length === 0) continue;
      const label = viewersLabel(names);
      badge.title = label;
      badge.setAttribute("aria-label", label);
      const count = badge.querySelector(".video-viewers__count");
      if (count !== null) setText(count, String(names.length));
    }
  }

  return { stateTiles, applySpeaking, applyUserAudioState, applyStreamViewers };
}
