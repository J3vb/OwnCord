/** The voice widget's listening bar: while you listen to a member's shared
 *  music it names them, shows the Music level and offers Stop, so you can
 *  stop from anywhere, with the call view closed. */
import { createElement, appendChildren, setText } from "@lib/dom";
import { createIcon } from "@lib/icons";
import { USER_VOLUME_CHANGED } from "@lib/constants";
import { getMusicVolume, listenToMusic } from "../livekitSession";
import { membersStore, memberDisplayName } from "@stores/members.store";
import type { VoiceState } from "@stores/voice.store";
import { voiceText as t } from "../../../i18n/voice";
import { shellText } from "../../../i18n/shell";

export interface ListeningBar {
  readonly el: HTMLDivElement;
  /** Show the bar for the member listened to, or hide it. */
  sync(voice: VoiceState): void;
}

/** Who `userId` is: their display name, else the call roster's username. */
function nameOf(userId: number, voice: VoiceState): string {
  const member = membersStore.getState().members.get(userId);
  const named = member === undefined ? "" : memberDisplayName(member);
  if (named !== "") return named;
  const roster =
    voice.currentChannelId === null ? undefined : voice.voiceUsers.get(voice.currentChannelId);
  return roster?.get(userId)?.username || shellText("common.unknown");
}

/** `onLevel` runs when a Music volume changes anywhere (the tile's slider, the
 *  volume menu), so the percent stays current; `signal` owns that listener. */
export function createListeningBar(signal: AbortSignal, onLevel: () => void): ListeningBar {
  const el = createElement("div", {
    class: "vw-listening",
    "data-testid": "vw-listening",
  });
  el.hidden = true;
  const icon = createElement("span", { class: "vw-listening__icon", "aria-hidden": "true" });
  icon.appendChild(createIcon("audio-lines", 20));
  const title = createElement("div", { class: "vw-listening__title", role: "status" });
  const level = createElement("div", { class: "vw-listening__level" });
  const text = createElement("div", { class: "vw-listening__text" });
  appendChildren(text, title, level);
  const stop = createElement("button", {
    type: "button",
    class: "vw-listening__stop",
    "data-testid": "vw-listening-stop",
  });
  appendChildren(stop, createIcon("x", 14), createElement("span", {}, t("music.bar.stop")));
  stop.addEventListener("click", () => listenToMusic(null), { signal });
  appendChildren(el, icon, text, stop);
  window.addEventListener(USER_VOLUME_CHANGED, onLevel, { signal });

  function sync(voice: VoiceState): void {
    const userId = voice.listeningTo ?? null;
    // Gone with the tile and the pill when the sharer stopped (the listen
    // lingers a moment in case their music comes back).
    el.hidden = userId === null || voice.musicSharers?.has(userId) !== true;
    if (userId === null) return;
    const name = nameOf(userId, voice);
    setText(title, t("music.bar.listening", { name }));
    setText(level, t("music.bar.level", { percent: getMusicVolume(userId) }));
    stop.setAttribute("aria-label", t("music.bar.stopLabel", { name }));
  }

  return { el, sync };
}
