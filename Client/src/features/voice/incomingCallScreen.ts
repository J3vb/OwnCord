/**
 * IncomingCallScreen: the ring of a DM call as a full-screen view on a phone.
 * The caller's large picture and name, then big round Decline and Accept
 * buttons, and a smaller "Join with video".
 *
 * It draws what it is handed and calls back; the banner that opens it owns the
 * ring's lifetime (timeout, decline and accept all stay in lib/voice/callRing).
 * Back, and Escape, only hide this view down to the banner: the ring goes on.
 * It is loaded on first use, so the banner stays small. The banner hands it
 * the avatar renderer, which lives with the components.
 */

import { Disposable } from "../../lib/disposable";
import { createElement, appendChildren, setText } from "../../lib/dom";
import { createIcon, type IconName } from "../../lib/icons";
import { isImeCommit } from "../../lib/text/ime";
import type { AvatarSubject } from "../../lib/ui/avatar";
import { applyDialogSemantics, focusDialog, trapFocus } from "../../lib/ui/a11y";
import { claimBack } from "../../lib/ui/backHistory";
import { voiceText } from "../../i18n/voice";
import { dmCallText } from "../../i18n/dmCall";

/** What the screen shows for the ringing call. */
export interface IncomingCallView {
  readonly title: string;
  readonly subtitle: string;
  readonly subject: AvatarSubject;
}

export interface IncomingCallScreenOptions {
  readonly view: IncomingCallView;
  /** `withVideo` is true for "Join with video". */
  readonly onAccept: (withVideo: boolean) => void;
  readonly onDecline: () => void;
  /** Back or Escape: hide this view; the ring is untouched. */
  readonly onHide: () => void;
  /** Draws the caller's large picture. */
  readonly renderAvatar: (subject: AvatarSubject) => HTMLElement;
  /** Where focus goes when the view closes and its opener is gone. */
  readonly fallbackFocus?: () => HTMLElement | null;
}

export interface IncomingCallScreen {
  /** Draw a changed ring (a redial, or the caller renamed). */
  update(view: IncomingCallView): void;
  /** Take the view down. Safe to repeat. */
  close(): void;
}

function roundButton(
  kind: "accept" | "decline",
  icon: IconName,
  label: string,
  onClick: () => void,
  signal: AbortSignal,
): HTMLElement {
  const wrap = createElement("div", { class: "incoming-call-screen__choice" });
  const btn = createElement("button", {
    type: "button",
    class: `incoming-call-screen__round incoming-call-screen__round--${kind}`,
    "aria-label": label,
    "data-testid": `incoming-call-screen-${kind}`,
  });
  btn.appendChild(createIcon(icon, 32));
  btn.addEventListener("click", onClick, { signal });
  wrap.append(btn, createElement("span", { class: "incoming-call-screen__label" }, label));
  return wrap;
}

export function openIncomingCallScreen(options: IncomingCallScreenOptions): IncomingCallScreen {
  const owner = new Disposable();
  const signal = owner.signal;

  const root = createElement("div", {
    class: "incoming-call-screen",
    "data-testid": "incoming-call-screen",
  });
  applyDialogSemantics(root, { label: voiceText("call.incoming") });

  const avatarSlot = createElement("div", { class: "incoming-call-screen__avatar-slot" });
  const title = createElement("div", {
    class: "incoming-call-screen__title",
    "data-testid": "incoming-call-screen-title",
  });
  const subtitle = createElement("div", { class: "incoming-call-screen__subtitle" });
  const who = createElement("div", { class: "incoming-call-screen__who" });
  appendChildren(who, avatarSlot, title, subtitle);

  const choices = createElement("div", { class: "incoming-call-screen__choices" });
  appendChildren(
    choices,
    roundButton("decline", "phone-off", voiceText("call.decline"), options.onDecline, signal),
    roundButton("accept", "phone", voiceText("call.accept"), () => options.onAccept(false), signal),
  );
  const videoBtn = createElement(
    "button",
    {
      type: "button",
      class: "incoming-call-screen__video",
      "data-testid": "incoming-call-screen-accept-video",
    },
    dmCallText("acceptVideo"),
  );
  videoBtn.addEventListener("click", () => options.onAccept(true), { signal });

  appendChildren(root, who, choices, videoBtn);

  function draw(view: IncomingCallView): void {
    // setText, never innerHTML: the names are user-controlled.
    setText(title, view.title);
    setText(subtitle, view.subtitle);
    avatarSlot.replaceChildren(options.renderAvatar(view.subject));
  }
  draw(options.view);

  document.body.appendChild(root);
  const restoreFocus = focusDialog(root, options.fallbackFocus);
  trapFocus(root, signal);
  root.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "Escape" || e.defaultPrevented || isImeCommit(e)) return;
      e.preventDefault();
      options.onHide();
    },
    { signal },
  );
  // Back hides the view, as a sheet closes on it. The claim is dropped before
  // `onBack` runs, and the owner's cleanup releases it again harmlessly.
  const claim = claimBack(() => options.onHide(), signal);
  owner.addCleanup(() => {
    claim.release();
    root.remove();
    // Only focus the screen left behind: a button that moved focus on
    // purpose keeps it.
    const active = document.activeElement;
    if (active === null || active === document.body) restoreFocus();
  });

  return {
    update: draw,
    close: () => owner.destroy(),
  };
}
