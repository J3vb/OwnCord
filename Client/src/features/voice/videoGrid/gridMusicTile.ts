/**
 * The music tiles: one card per remote member sharing music, drawn like a
 * screen share you have not watched. Nothing plays until the viewer taps
 * Listen to music; while they listen, the card carries the volume and Stop
 * listening. The cells are packed with the video tiles but are not streams:
 * they hold no picture, so they live beside `st.cells`, never in it.
 */
import { createElement, appendChildren } from "@lib/dom";
import { createIcon } from "@lib/icons";
import { voiceText } from "../../../i18n/voice";
import type { GridState, GridApi } from "./gridState";
import type { GridMusic } from "./VideoGrid";

export const MUSIC_CELL_CLASS = "video-cell--music";

/** What the cell was last drawn from: a change in it redraws the card, any
 *  other update leaves it alone (a slider being dragged keeps its thumb). */
function drawKey(music: GridMusic): string {
  return `${music.listening ? "on" : "off"}|${music.name}`;
}

function buildLabel(name: string): HTMLElement {
  const label = createElement("div", { class: "video-label" });
  const tag = createElement("div", { class: "video-username" });
  appendChildren(tag, createIcon("music", 14), createElement("span", {}, name));
  label.appendChild(tag);
  return label;
}

function buildVolume(music: GridMusic): HTMLElement {
  const row = createElement("div", { class: "video-music__volume" });
  const slider = createElement("input", {
    type: "range",
    class: "tile-volume-slider",
    min: "0",
    max: "100",
    value: String(music.volume),
    "aria-label": voiceText("music.tile.volume", { name: music.name }),
    "data-testid": "music-tile-volume",
  });
  const value = createElement("span", { class: "tile-volume-value" }, `${music.volume}%`);
  slider.addEventListener("input", () => {
    const percent = Number(slider.value);
    value.textContent = `${percent}%`;
    music.onVolume(percent);
  });
  appendChildren(row, createIcon("volume-2", 16), slider, value);
  return row;
}

/** The card's body: the disc, the line under it and the button (and, while
 *  listening, the volume). */
function buildBody(music: GridMusic): HTMLElement {
  const body = createElement("div", {
    class: music.listening ? "video-music video-music--on" : "video-music",
  });
  const disc = createElement("div", { class: "video-music__disc", "aria-hidden": "true" });
  disc.appendChild(createIcon(music.listening ? "audio-lines" : "music", 34));
  const text = createElement(
    "div",
    { class: "video-music__text", role: "status" },
    music.listening
      ? voiceText("music.tile.listening", { name: music.name })
      : voiceText("music.tile.sharing", { name: music.name }),
  );
  const button = createElement("button", {
    type: "button",
    class: "video-watch-btn video-music__btn",
    "data-music-control": music.listening ? "stop" : "listen",
  });
  button.appendChild(createIcon(music.listening ? "x" : "headphones", 16));
  button.appendChild(
    createElement(
      "span",
      {},
      music.listening ? voiceText("music.tile.stop") : voiceText("music.tile.listen"),
    ),
  );
  button.addEventListener("click", music.listening ? music.onStop : music.onListen);
  appendChildren(body, disc, text, button);
  if (music.listening) body.appendChild(buildVolume(music));
  return body;
}

function draw(cell: HTMLDivElement, music: GridMusic): void {
  cell.dataset["musicKey"] = drawKey(music);
  cell.setAttribute("aria-label", voiceText("music.tile.label", { name: music.name }));
  cell.classList.toggle("video-cell--listening", music.listening);
  cell.replaceChildren(buildBody(music), buildLabel(music.name));
}

export function createGridMusic(st: GridState, api: GridApi) {
  /** One cell per sharer in `st.music`, reused across updates; a sharer who
   *  stopped loses theirs. */
  function syncMusic(): void {
    const wanted = new Set<number>();
    for (const music of st.music) {
      wanted.add(music.userId);
      let cell = st.musicCells.get(music.userId);
      if (cell === undefined) {
        cell = createElement("div", {
          class: `video-cell video-cell--stopped ${MUSIC_CELL_CLASS}`,
          role: "group",
          "data-music-id": String(music.userId),
        });
        st.musicCells.set(music.userId, cell);
      }
      if (cell.dataset["musicKey"] !== drawKey(music)) draw(cell, music);
    }
    for (const [id, cell] of st.musicCells) {
      if (wanted.has(id)) continue;
      cell.remove();
      st.musicCells.delete(id);
    }
  }

  /** The cells in layout order. */
  function musicTiles(): HTMLDivElement[] {
    const cells: HTMLDivElement[] = [];
    for (const music of st.music) {
      const cell = st.musicCells.get(music.userId);
      if (cell !== undefined) cells.push(cell);
    }
    return cells;
  }

  function setMusic(next: readonly GridMusic[]): void {
    st.music = next;
    api.relayout();
  }

  /** The grid is torn down. */
  function resetMusic(): void {
    for (const cell of st.musicCells.values()) cell.remove();
    st.musicCells.clear();
    st.music = [];
  }

  return { syncMusic, musicTiles, setMusic, resetMusic };
}
