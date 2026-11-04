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
  const dot = createElement("div", { class: "mi-status" });
  dot.setAttribute("aria-label", applyStatusIndicator(dot, person.status, person.mobile));
  dot.setAttribute("role", "img");
  avatar.appendChild(dot);
  return avatar;
}

/** Redraw on a roster, presence, block, channel or voice-seat change, until `signal` aborts. */
export function watchPeople(render: () => void, signal: AbortSignal): void {
  const unsubs = [
    membersStore.subscribeSelector((s) => s.members, render),
    blocksStore.subscribeSelector((s) => s.blockedByMe, render),
    channelsStore.subscribeSelector((s) => s.channels, render),
    // Who sits in which channel only: a speaking tick replaces voiceUsers too.
    voiceStore.subscribeSelector(
      (s) =>
        [...s.voiceUsers].map(([id, users]) => `${id}:${[...users.keys()].join(",")}`).join(";"),
      render,
    ),
  ];
  signal.addEventListener("abort", () => unsubs.forEach((u) => u()), { once: true });
}
