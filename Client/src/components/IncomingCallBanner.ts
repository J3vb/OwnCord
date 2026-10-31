/**
 * IncomingCallBanner — the toast-like strip that appears when somebody rings a
 * DM you are in.
 *
 * It is deliberately a banner and not a modal: a ring is an offer, not a
 * demand, and a modal would block the app until the 30s timer expired. Accept
 * joins the DM's voice channel; Decline tells the ringer to stop.
 *
 * On a phone a ring takes the whole screen instead (incomingCallScreen in
 * features/voice, loaded on first use). Back hides that view down to this banner and the ring goes on;
 * a redial of the same ring does not bring the view back.
 *
 * All state lives in @lib/voice/callRing — this only draws whatever it is handed.
 */

import { Disposable } from "@lib/disposable";
import { createElement, appendChildren, setText, clearChildren } from "@lib/dom";
import type { MountableComponent } from "@lib/text/safeRender";
import type { RingState } from "@lib/voice/callRing";
import type { AvatarSubject } from "@lib/ui/avatar";
import { isPhoneLayout, onPhoneLayoutChange } from "@lib/ui/bottomSheet";
import { createAvatarElement } from "@components/message-list/avatar";
import { dmStore, dmDisplayName } from "@stores/dm.store";
import { membersStore } from "@stores/members.store";
import { voiceText } from "../i18n/voice";
import { dmCallText } from "../i18n/dmCall";
import { createLazyScreen } from "./lazyScreen";
import type { IncomingCallScreen, IncomingCallView } from "../features/voice/incomingCallScreen";

export interface IncomingCallBannerOptions {
  /** `withVideo` is true for "Join with video": the camera turns on at join. */
  readonly onAccept: (withVideo: boolean) => void;
  readonly onDecline: () => void;
}

export interface IncomingCallBannerComponent extends MountableComponent {
  /** Show the banner for a ring, or hide it with null. `ringGoesOn` says a
   *  null only moves the ring to another surface (the DM call panel), so a
   *  full-screen view hidden with Back stays hidden when the ring comes back. */
  readonly setRing: (state: RingState | null, ringGoesOn?: boolean) => void;
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

/** What the ring shows: the caller (or the group, with the caller beneath). */
function view(state: RingState): IncomingCallView {
  const dm = dmStore.getState().channels.find((c) => c.channelId === state.channelId);
  return dm?.isGroup === true
    ? {
        title: dmDisplayName(dm),
        subtitle: voiceText("call.isCalling", { name: state.fromUsername }),
        subject: callerSubject(state),
      }
    : {
        title: voiceText("call.isCalling", { name: state.fromUsername }),
        subtitle: voiceText("call.incoming"),
        subject: callerSubject(state),
      };
}

const callScreen = createLazyScreen(
  "incoming-call-screen",
  () => import("../features/voice/incomingCallScreen"),
);

/** One ring, for telling a redial of it from a new one. */
function ringKey(state: RingState): string {
  return `${state.channelId}:${state.fromUserId}`;
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

  // The phone's full-screen ring, while it is up, and the ring it is for.
  let screen: IncomingCallScreen | null = null;
  let ring: RingState | null = null;
  /** The ring whose full-screen view was hidden with Back. */
  let hiddenFor: string | null = null;
  /** Bumped by every ring change, so a view still loading opens only for the
   *  ring that asked for it. */
  let ringGen = 0;

  function closeScreen(): void {
    screen?.close();
    screen = null;
  }

  /** Back or Escape on the full-screen view: the banner takes over. */
  function hideScreen(): void {
    if (ring !== null) hiddenFor = ringKey(ring);
    closeScreen();
    root.style.display = ring === null ? "none" : "";
  }

  /** On a phone, the full-screen view for a ring not hidden with Back. */
  function syncScreen(): void {
    if (ring === null || !isPhoneLayout() || hiddenFor === ringKey(ring)) {
      closeScreen();
      root.style.display = ring === null ? "none" : "";
      return;
    }
    if (screen !== null) {
      screen.update(view(ring));
      return;
    }
    const gen = ringGen;
    void callScreen
      .load(() => gen === ringGen)
      .then((mod) => {
        if (mod === null || disposable.signal.aborted || gen !== ringGen || screen !== null) return;
        if (ring === null || !isPhoneLayout()) return;
        screen = mod.openIncomingCallScreen({
          view: view(ring),
          onAccept: (withVideo) => options.onAccept(withVideo),
          onDecline: () => options.onDecline(),
          onHide: hideScreen,
          renderAvatar: (subject) =>
            createAvatarElement(subject, {
              className: "incoming-call-screen__avatar",
              attrs: { "data-testid": "incoming-call-screen-avatar" },
            }),
          fallbackFocus: () => null,
        });
        root.style.display = "none";
      });
  }

  function setRing(state: RingState | null, ringGoesOn = false): void {
    ring = state;
    ringGen += 1;
    if (state === null) {
      if (!ringGoesOn) hiddenFor = null;
      closeScreen();
      root.style.display = "none";
      setText(title, "");
      clearChildren(avatarSlot);
      return;
    }
    const shown = view(state);
    // setText, never innerHTML: the username and group name are user-controlled.
    setText(title, shown.title);
    setText(subtitle, shown.subtitle);
    clearChildren(avatarSlot);
    avatarSlot.appendChild(
      createAvatarElement(shown.subject, {
        className: "incoming-call-avatar",
        attrs: { "data-testid": "incoming-call-avatar" },
      }),
    );
    root.style.display = screen === null ? "" : "none";
    syncScreen();
  }

  // Turning the phone, or resizing past the breakpoint, swaps the surface.
  onPhoneLayoutChange(() => {
    if (ring !== null) syncScreen();
  }, disposable.signal);

  return {
    mount(container: Element): void {
      container.appendChild(root);
    },
    destroy(): void {
      closeScreen();
      disposable.destroy();
      root.remove();
    },
    setRing,
  };
}
