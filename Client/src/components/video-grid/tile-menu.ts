/**
 * The context menu on a remote video tile (right-click, the Menu key or
 * Shift+F10): the stream's volume (screen-share audio, 0-100 %) and the
 * person's voice volume (mic, 0-200 %), kept apart and labelled apart, plus
 * Mute stream and Stop watching. Same keyboard model and dismissal as the
 * voice-roster volume menu (channel-sidebar/volume-menu.ts).
 */

import { Disposable } from "@lib/disposable";
import { createElement, setText, appendChildren, setOwnedTimeout } from "@lib/dom";
import { createMenuItem, enableMenuKeyboard } from "@lib/context-menu";
import {
  getScreenshareAudioMuted,
  getScreenshareAudioVolume,
  getUserVolume,
  muteScreenshareAudio,
  setScreenshareAudioVolume,
  setUserVolume,
} from "@lib/livekitSession";
import type { TileConfig } from "../VideoGrid";
import { voiceText as t } from "../../i18n/voice";

export interface TileMenuOptions {
  readonly x: number;
  readonly y: number;
  /** The person's display name. */
  readonly name: string;
  readonly config: TileConfig;
  /** The grid's lifetime: the menu goes with it. */
  readonly signal: AbortSignal;
  /** The tiles' own sliders show the same settings; keep them in step. */
  readonly onVolumeChange: (isScreenshare: boolean, volume: number, muted: boolean) => void;
  readonly onStopWatching: () => void;
}

/** No-op default until the keyboard model installs the real restorer. */
const noop = (): void => {};

function volumeRow(
  label: string,
  sliderLabel: string,
  kind: "stream" | "voice",
  max: number,
  value: number,
  onInput: (value: number) => void,
): HTMLElement[] {
  const heading = createElement("div", { class: "context-menu-label" }, label);
  const row = createElement("div", { class: "context-menu-range" });
  const slider = createElement("input", {
    type: "range",
    min: "0",
    max: String(max),
    value: String(value),
    "aria-label": sliderLabel,
    "aria-valuetext": t("tile.percent", { percent: value }),
    "data-menu-volume": kind,
  });
  const out = createElement("span", { class: "slider-val" }, t("tile.percent", { percent: value }));
  slider.addEventListener("input", () => {
    const v = Number(slider.value);
    const text = t("tile.percent", { percent: v });
    setText(out, text);
    slider.setAttribute("aria-valuetext", text);
    onInput(v);
  });
  appendChildren(row, slider, out);
  return [heading, row];
}

export function showTileMenu(opts: TileMenuOptions): void {
  const { config, name } = opts;
  document.querySelectorAll(".video-tile-menu").forEach((el) => {
    (el as HTMLElement & { dismiss?: Disposable }).dismiss?.destroy();
    el.remove();
  });

  const menu = createElement("div", { class: "context-menu video-tile-menu" });
  menu.setAttribute("aria-label", name);
  const dismiss = new Disposable();
  (menu as HTMLElement & { dismiss?: Disposable }).dismiss = dismiss;
  let restoreFocus: () => void = noop;
  const closeMenu = (): void => {
    menu.remove();
    dismiss.destroy();
    restoreFocus();
  };

  const id = config.audioUserId;
  if (config.isScreenshare) {
    let muted = getScreenshareAudioMuted(id);
    const start = muted ? 0 : Math.round(getScreenshareAudioVolume(id) * 100);
    menu.append(
      ...volumeRow(
        t("tile.menuStream"),
        t("tile.streamVolume", { name }),
        "stream",
        100,
        start,
        (v) => {
          muted = v === 0;
          muteScreenshareAudio(id, muted);
          setScreenshareAudioVolume(id, v / 100);
          setText(muteItem, muted ? t("tile.unmuteStream") : t("tile.muteStream"));
          opts.onVolumeChange(true, v, muted);
        },
      ),
    );
    const muteItem = createMenuItem(
      muted ? t("tile.unmuteStream") : t("tile.muteStream"),
      "context-menu-item",
    );
    muteItem.addEventListener("click", () => {
      muted = !muted;
      let volume = Math.round(getScreenshareAudioVolume(id) * 100);
      if (!muted && volume === 0) {
        volume = 100;
        setScreenshareAudioVolume(id, 1);
      }
      muteScreenshareAudio(id, muted);
      opts.onVolumeChange(true, volume, muted);
      closeMenu();
    });
    menu.append(muteItem, createElement("div", { class: "context-menu-sep" }));
  }

  menu.append(
    ...volumeRow(
      t("tile.menuVoice", { name }),
      t("tile.voiceVolume", { name }),
      "voice",
      200,
      getUserVolume(id),
      (v) => {
        setUserVolume(id, v);
        opts.onVolumeChange(false, v, v === 0);
      },
    ),
  );

  const stop = createMenuItem(t("tile.stopWatching"), "context-menu-item");
  stop.addEventListener("click", () => {
    closeMenu();
    opts.onStopWatching();
  });
  menu.append(createElement("div", { class: "context-menu-sep" }), stop);

  document.body.appendChild(menu);
  const margin = 8;
  const left = Math.min(opts.x, window.innerWidth - menu.offsetWidth - margin);
  const top = Math.min(opts.y, window.innerHeight - menu.offsetHeight - margin);
  menu.style.left = `${Math.max(margin, left)}px`;
  menu.style.top = `${Math.max(margin, top)}px`;
  restoreFocus = enableMenuKeyboard(menu, { signal: dismiss.signal, onClose: closeMenu });

  setOwnedTimeout(
    dismiss.signal,
    () => {
      document.addEventListener(
        "mousedown",
        (e: MouseEvent) => {
          if (!menu.contains(e.target as Node)) closeMenu();
        },
        { signal: dismiss.signal },
      );
    },
    0,
  );
  opts.signal.addEventListener(
    "abort",
    () => {
      menu.remove();
      dismiss.destroy();
    },
    { signal: dismiss.signal },
  );
}
