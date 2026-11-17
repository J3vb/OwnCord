/**
 * What the People view and the phone's Active now strip share: who the lists
 * leave out, the avatar with its status dot, and the store changes that
 * redraw them.
 */

import { createElement } from "@lib/dom";
import { applyStatusIndicator } from "@lib/ui/statusIndicator";
import { authStore } from "@stores/auth.store";
import { blocksStore } from "@stores/blocks.store";
import { channelsStore } from "@stores/channels.store";
import { membersStore } from "@stores/members.store";
import { voiceStore } from "@stores/voice.store";
import { createAvatarElement, pickAvatarColor } from "../profiles/avatar";
import type { PeopleScope, PersonModel } from "./model";

export function peopleScope(): PeopleScope {
  return {
    selfId: authStore.getState().user?.id ?? null,
    blocked: blocksStore.getState().blockedByMe,
  };
}

export function personAvatar(person: PersonModel): HTMLElement {
  const avatar = createAvatarElement(
    { username: person.username, avatar: person.avatar },
    {
      className: "mi-avatar",
      background: pickAvatarColor(person.username),
      decorative: true,
      deferUntilVisible: true,
    },
  );
  avatar.dataset["avatarKey"] = avatarKey(person);
  const dot = createElement("div", { class: "mi-status" });
  dot.setAttribute("aria-label", applyStatusIndicator(dot, person.status, person.mobile));
  dot.setAttribute("role", "img");
  avatar.appendChild(dot);
  return avatar;
}

function avatarKey(person: PersonModel): string {
  return `${person.username}\n${person.avatar ?? ""}`;
}

/**
 * The avatar for `person`, reusing `current` when it shows the same picture
 * (only its status dot is redrawn): a new picture element per presence
 * update would rebind an animated avatar on every change.
 */
export function refreshPersonAvatar(current: Element | null, person: PersonModel): HTMLElement {
  if (current instanceof HTMLElement && current.dataset["avatarKey"] === avatarKey(person)) {
    const dot = current.querySelector<HTMLElement>(".mi-status");
    if (dot !== null) {
      dot.setAttribute("aria-label", applyStatusIndicator(dot, person.status, person.mobile));
      return current;
    }
  }
  return personAvatar(person);
}

/** The names of the server's channels, which Active now shows beside a voice seat. */
function channelNames(channels: ReadonlyMap<number, { name: string; type: string }>): string {
  let out = "";
  for (const [id, channel] of channels) if (channel.type !== "dm") out += `${id}:${channel.name};`;
  return out;
}

/**
 * Redraw on a roster, presence, block, channel-name or voice-seat change,
 * until `signal` aborts. A burst of changes redraws once, on the next frame.
 */
export function watchPeople(render: () => void, signal: AbortSignal): void {
  let frame = 0;
  const schedule = (): void => {
    if (frame !== 0 || signal.aborted) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (!signal.aborted) render();
    });
  };
  const unsubs = [
    membersStore.subscribeSelector((s) => s.members, schedule),
    blocksStore.subscribeSelector((s) => s.blockedByMe, schedule),
    // Names only: unread counts and read pointers replace the channels Map on every message.
    channelsStore.subscribeSelector((s) => channelNames(s.channels), schedule),
    // Who sits in which channel only: a speaking tick replaces voiceUsers too.
    voiceStore.subscribeSelector(
      (s) =>
        [...s.voiceUsers].map(([id, users]) => `${id}:${[...users.keys()].join(",")}`).join(";"),
      schedule,
    ),
  ];
  signal.addEventListener(
    "abort",
    () => {
      unsubs.forEach((u) => u());
      if (frame !== 0) cancelAnimationFrame(frame);
      frame = 0;
    },
    { once: true },
  );
}
