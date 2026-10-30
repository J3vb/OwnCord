/**
 * IncomingCallBanner — the toast-like strip that appears when somebody rings a
 * DM you are in.
 *
 * It is deliberately a banner and not a modal: a ring is an offer, not a
 * demand, and a modal would block the app until the 30s timer expired. Accept
 * joins the DM's voice channel; Decline tells the ringer to stop.
 *
 * All state lives in @lib/voice/callRing — this only draws whatever it is handed.
 */

import { Disposable } from "@lib/disposable";
import { createElement, appendChildren, setText, clearChildren } from "@lib/dom";
import type { MountableComponent } from "@lib/text/safeRender";
import type { RingState } from "@lib/voice/callRing";
import type { AvatarSubject } from "@lib/avatar";
import { createAvatarElement } from "@components/message-list/avatar";
import { dmStore, dmDisplayName } from "@stores/dm.store";
import { membersStore } from "@stores/members.store";
import { voiceText } from "../i18n/voice";
import { dmCallText } from "../i18n/dmCall";

export interface IncomingCallBannerOptions {
  /** `withVideo` is true for "Join with video": the camera turns on at join. */
  readonly onAccept: (withVideo: boolean) => void;
  readonly onDecline: () => void;
}

export interface IncomingCallBannerComponent extends MountableComponent {
  /** Show the banner for a ring, or hide it with null. */
  readonly setRing: (state: RingState | null) => void;
}

/** Who to draw: the member record, else the DM's participant, else the bare name. */
function callerSubject(state: RingState): AvatarSubject {
  const member = membersStore.getState().members.get(state.fromUserId);
  if (member !== undefined) {
    return {
      username: member.username,
      displayName: member.displayName,
      avatar: member.avatar,
    };
  }
  const dm = dmStore.getState().channels.find((c) => c.channelId === state.channelId);
  const p = dm?.participants.find((x) => x.id === state.fromUserId);
  if (p !== undefined) {
    return { username: p.username, displayName: p.displayName ?? null, avatar: p.avatar };
  }
  return { username: state.fromUsername };
}

export function createIncomingCallBanner(
  options: IncomingCallBannerOptions,
): IncomingCallBannerComponent {
  const disposable = new Disposable();

  const root = createElement("div", {
    class: "incoming-call-banner",
    role: "alert",
    "data-testid": "incoming-call-banner",
  });
  root.style.display = "none";

  // The caller's avatar, repainted per ring. It replaces the phone icon, so the
  // slot keeps its place and only its content changes.
  const avatarSlot = createElement("div", { class: "incoming-call-avatar-slot" });

  const info = createElement("div", { class: "incoming-call-info" });
  const title = createElement("div", {
    class: "incoming-call-title",
    "data-testid": "incoming-call-title",
  });
  const subtitle = createElement(
    "div",
    { class: "incoming-call-subtitle" },
    voiceText("call.incoming"),
  );
  appendChildren(info, title, subtitle);

  const acceptBtn = createElement(
    "button",
    {
      class: "btn btn-primary incoming-call-accept",
      type: "button",
      "data-testid": "incoming-call-accept",
    },
    voiceText("call.accept"),
  );
  acceptBtn.addEventListener("click", () => options.onAccept(false), {
    signal: disposable.signal,
  });

  const videoBtn = createElement(
    "button",
    {
      class: "btn btn-ghost incoming-call-accept-video",
      type: "button",
      "data-testid": "incoming-call-accept-video",
    },
    dmCallText("acceptVideo"),
  );
  videoBtn.addEventListener("click", () => options.onAccept(true), {
    signal: disposable.signal,
  });

  const declineBtn = createElement(
    "button",
    {
      class: "btn btn-danger incoming-call-decline",
      type: "button",
      "data-testid": "incoming-call-decline",
    },
    voiceText("call.decline"),
  );
  declineBtn.addEventListener("click", () => options.onDecline(), { signal: disposable.signal });

  const actions = createElement("div", { class: "incoming-call-actions" });
  appendChildren(actions, acceptBtn, videoBtn, declineBtn);
  appendChildren(root, avatarSlot, info, actions);

  function setRing(state: RingState | null): void {
    if (state === null) {
      root.style.display = "none";
      setText(title, "");
      clearChildren(avatarSlot);
      return;
    }
    const dm = dmStore.getState().channels.find((c) => c.channelId === state.channelId);
    // setText, never innerHTML: the username and group name are user-controlled.
    if (dm?.isGroup === true) {
      // A group call is called by the group; who rang goes underneath.
      setText(title, dmDisplayName(dm));
      setText(subtitle, voiceText("call.isCalling", { name: state.fromUsername }));
    } else {
      setText(title, voiceText("call.isCalling", { name: state.fromUsername }));
      setText(subtitle, voiceText("call.incoming"));
    }
    clearChildren(avatarSlot);
    avatarSlot.appendChild(
      createAvatarElement(callerSubject(state), {
        className: "incoming-call-avatar",
        attrs: { "data-testid": "incoming-call-avatar" },
      }),
    );
    root.style.display = "";
  }

  return {
    mount(container: Element): void {
      container.appendChild(root);
    },
    destroy(): void {
      disposable.destroy();
      root.remove();
    },
    setRing,
  };
}
