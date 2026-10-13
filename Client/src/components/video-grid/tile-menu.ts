/**
 * The context menu on a video tile (right-click, the Menu key or Shift+F10).
 * A remote tile gets the person's menu: Profile, Message, the stream's volume
 * (screen-share audio, 0-100 %) and the person's voice volume (mic, 0-200 %),
 * kept apart and labelled apart, local Mute, Focus, Full screen, Pop out,
 * Stop watching and, where the server allows it, voice moderation. Your own
 * camera tile gets a small one: Hide my camera and Turn off camera. Same
 * keyboard model and dismissal as the voice-roster volume menu
 * (channel-sidebar/volume-menu.ts), whose Mute and moderation rows it reuses.
 */

import { Disposable } from "@lib/disposable";
import { createElement, setText, appendChildren, setOwnedTimeout } from "@lib/dom";
import { createMenuItem, enableMenuKeyboard } from "@lib/context-menu";
import {
  getScreenshareAudioMuted,
  getScreenshareAudioVolume,
  getUserLocalMute,
  setUserLocalMute,
  getUserVolume,
  muteScreenshareAudio,
  setScreenshareAudioVolume,
  setUserVolume,
} from "@lib/livekitSession";
import type { TileConfig } from "../VideoGrid";
import {
  appendVoiceModeration,
  createLocalMuteItem,
  type VoiceModMenuOptions,
} from "../channel-sidebar/volume-menu";
import { voiceText as t } from "../../i18n/voice";

export interface TileMenuOptions {
  readonly x: number;
  readonly y: number;
  /** The person's display name. */
  readonly name: string;
  readonly config: TileConfig;
  /** The tile's lifetime: the menu closes when its tile is removed. */
  readonly signal: AbortSignal;
  /** The tiles' own sliders show the same settings; keep them in step. */
  readonly onVolumeChange: (isScreenshare: boolean, volume: number, muted: boolean) => void;
  readonly onStopWatching: () => void;
  /** Focus view, full screen and pop out for this tile, in their state now. */
  readonly view: TileMenuView;
  /** The person's own actions; each row is left out without its handler. */
  readonly person?: TileMenuPerson;
}

export interface TileMenuView {
  readonly focused: boolean;
  readonly fullscreen: boolean;
  readonly poppedOut: boolean;
  readonly onFocus: () => void;
  readonly onFullscreen: () => void;
  readonly onPopout: () => void;
}

export interface TileMenuPerson {
  readonly onProfile?: () => void;
  readonly onMessage?: () => void;
  /** As the voice roster's menu: the section, or why it is unavailable. */
  readonly moderation?: VoiceModMenuOptions | string;
}

export interface SelfTileMenuOptions {
  readonly x: number;
  readonly y: number;
  readonly signal: AbortSignal;
  /** Hide my camera, where the call view's "Show my camera" toggle applies. */
  readonly onHide?: () => void;
  /** Turn off camera; `cameraLocked` greys it with that reason. */
  readonly onCameraOff?: () => void;
  readonly cameraLocked?: string | null;
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
): { readonly rows: HTMLElement[]; readonly set: (value: number) => void } {
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
  const show = (v: number): void => {
    const text = t("tile.percent", { percent: v });
    setText(out, text);
    slider.setAttribute("aria-valuetext", text);
  };
  slider.addEventListener("input", () => {
    const v = Number(slider.value);
    show(v);
    onInput(v);
  });
  appendChildren(row, slider, out);
  return {
    rows: [heading, row],
    set: (v) => {
      slider.value = String(v);
      show(v);
    },
  };
}

/** One action row that closes the menu before it runs. */
function actionItem(
  label: string,
  action: string,
  close: () => void,
  run: () => void,
): HTMLElement {
  const item = createMenuItem(label, "context-menu-item");
  item.setAttribute("data-action", action);
  item.addEventListener("click", () => {
    close();
    run();
  });
  return item;
}

const sep = (): HTMLElement => createElement("div", { class: "context-menu-sep" });

/** The menu shell: one at a time, placed inside the window (and inside the
 *  full-screen element, where it can be seen), keyboard model, closed by a
 *  click outside or when its tile goes. `build` fills it. */
function openMenu(
  x: number,
  y: number,
  label: string,
  signal: AbortSignal,
  build: (menu: HTMLElement, close: () => void) => void,
): void {
  document.querySelectorAll(".video-tile-menu").forEach((el) => {
    (el as HTMLElement & { dismiss?: Disposable }).dismiss?.destroy();
    el.remove();
  });

  const menu = createElement("div", { class: "context-menu video-tile-menu" });
  menu.setAttribute("aria-label", label);
  const dismiss = new Disposable();
  (menu as HTMLElement & { dismiss?: Disposable }).dismiss = dismiss;
  let restoreFocus: () => void = noop;
  const closeMenu = (): void => {
    menu.remove();
    dismiss.destroy();
    restoreFocus();
  };
  build(menu, closeMenu);

  (document.fullscreenElement ?? document.body).appendChild(menu);
  const margin = 8;
  const left = Math.min(x, window.innerWidth - menu.offsetWidth - margin);
  const top = Math.min(y, window.innerHeight - menu.offsetHeight - margin);
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
  signal.addEventListener(
    "abort",
    () => {
      menu.remove();
      dismiss.destroy();
    },
    { signal: dismiss.signal },
  );
}

/** Your own camera tile's menu. Nothing opens when it would be empty. */
export function showSelfTileMenu(opts: SelfTileMenuOptions): void {
  const { onHide, onCameraOff } = opts;
  const locked = opts.cameraLocked ?? null;
  // A menu whose only row is greyed could not take focus or close by keyboard.
  if (onHide === undefined && (onCameraOff === undefined || locked !== null)) return;
  openMenu(opts.x, opts.y, t("tile.selfMenu"), opts.signal, (menu, close) => {
    if (onHide !== undefined) {
      menu.append(actionItem(t("tile.hideMyCamera"), "hide-self", close, onHide));
    }
    if (onCameraOff !== undefined) {
      const off = actionItem(t("widget.control.cameraOff"), "camera-off", close, onCameraOff);
      if (locked !== null) {
        (off as HTMLButtonElement).disabled = true;
        off.classList.add("disabled");
        off.title = locked;
      }
      menu.append(off);
    }
  });
}

export function showTileMenu(opts: TileMenuOptions): void {
  openMenu(opts.x, opts.y, opts.name, opts.signal, (menu, close) =>
    buildTileMenu(menu, opts, close),
  );
}

function buildTileMenu(menu: HTMLElement, opts: TileMenuOptions, closeMenu: () => void): void {
  const { config, name, view, person } = opts;
  const id = config.audioUserId;

  if (person?.onProfile !== undefined) {
    menu.append(actionItem(t("tile.profile"), "profile", closeMenu, person.onProfile));
  }
  if (person?.onMessage !== undefined) {
    menu.append(actionItem(t("tile.message"), "message", closeMenu, person.onMessage));
  }
  if (menu.childElementCount > 0) menu.append(sep());

  if (config.isScreenshare) {
    let muted = getScreenshareAudioMuted(id);
    const start = muted ? 0 : Math.round(getScreenshareAudioVolume(id) * 100);
    const stream = volumeRow(
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
    );
    menu.append(...stream.rows);
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
    menu.append(muteItem, sep());
  }

  const voice = volumeRow(
    t("tile.menuVoice", { name }),
    t("tile.voiceVolume", { name }),
    "voice",
    200,
    getUserVolume(id),
    (v) => {
      setUserVolume(id, v);
      // Raising the level unmutes, as the sidebar and tile sliders do.
      if (v > 0 && getUserLocalMute(id)) setUserLocalMute(id, false);
      localMute.sync();
      opts.onVolumeChange(false, v, v === 0 || getUserLocalMute(id));
    },
  );
  // Unchecking Mute on a user at 0 % brings them back at 100 %.
  const localMute = createLocalMuteItem(id, () => {
    voice.set(100);
    opts.onVolumeChange(false, 100, false);
  });
  menu.append(...voice.rows, localMute.item, sep());

  menu.append(
    actionItem(
      view.focused ? t("tile.backToGrid") : t("tile.focus"),
      "focus",
      closeMenu,
      view.onFocus,
    ),
    actionItem(
      view.fullscreen ? t("tile.exitFullscreen") : t("tile.fullscreen"),
      "fullscreen",
      closeMenu,
      view.onFullscreen,
    ),
    actionItem(
      view.poppedOut ? t("tile.popIn") : t("tile.popOut"),
      "popout",
      closeMenu,
      view.onPopout,
    ),
    actionItem(t("tile.stopWatching"), "stop-watching", closeMenu, opts.onStopWatching),
  );

  if (person?.moderation !== undefined) appendVoiceModeration(menu, person.moderation, closeMenu);
}
