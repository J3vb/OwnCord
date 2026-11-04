/**
 * Active now on a phone: a row of cards across the top of the Messages
 * drawer, one per person playing a game or sitting in a server voice channel.
 * A tap opens that person's DM. The strip hides itself while nobody is active.
 */

import { appendChildren, createElement } from "@lib/dom";
import { createIcon } from "@lib/icons";
import { channelsStore } from "@stores/channels.store";
import { membersStore } from "@stores/members.store";
import { voiceStore } from "@stores/voice.store";
import { peopleHomeText as t } from "../../i18n/peopleHome";
import { activeNow, type ActiveModel } from "./model";
import { peopleScope, personAvatar, watchPeople } from "./shared";

export interface ActiveStripOptions {
  readonly signal: AbortSignal;
  readonly onOpen: (userId: number) => void;
}

function card(person: ActiveModel, onOpen: (userId: number) => void): HTMLLIElement {
  const li = createElement("li", { class: "dm-active-card" });
  const btn = createElement("button", {
    type: "button",
    class: "dm-active-btn",
    "aria-label": t("message", { name: person.name }),
    "data-testid": `dm-active-${person.id}`,
    "data-active-id": String(person.id),
  });
  const line =
    person.game ??
    (person.voiceChannel !== null ? t("active.voice", { channel: person.voiceChannel }) : "");
  const icon = createIcon(person.game !== null ? "gamepad-2" : "volume-2", 14);
  icon.setAttribute("aria-hidden", "true");
  const text = createElement("span", { class: "dm-active-text" });
  appendChildren(
    text,
    createElement("span", { class: "dm-active-name" }, person.name),
    createElement("span", { class: "dm-active-line" }, line),
  );
  appendChildren(btn, personAvatar(person), text, icon);
  btn.addEventListener("click", () => onOpen(person.id));
  li.appendChild(btn);
  return li;
}

export function renderActiveStrip(root: HTMLElement, opts: ActiveStripOptions): void {
  const { signal, onOpen } = opts;
  function render(): void {
    if (signal.aborted) return;
    const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusedId =
      focused !== null && root.contains(focused) ? focused.dataset["activeId"] : undefined;
    const cards = activeNow(
      membersStore.getState().members,
      voiceStore.getState().voiceUsers,
      channelsStore.getState().channels,
      peopleScope(),
    );
    root.replaceChildren(...cards.map((p) => card(p, onOpen)));
    root.hidden = cards.length === 0;
    if (focusedId !== undefined) {
      root.querySelector<HTMLElement>(`[data-active-id="${focusedId}"]`)?.focus();
    }
  }
  watchPeople(render, signal);
  render();
}
