/**
 * IncomingCallBanner — the toast-like strip that appears when somebody rings a
 * DM you are in.
 *
 * It is deliberately a banner and not a modal: a ring is an offer, not a
 * demand, and a modal would block the app until the 30s timer expired. Accept
 * joins the DM's voice channel; Decline tells the ringer to stop.
 *
 * All state lives in @lib/call-ring — this only draws whatever it is handed.
 */

import { createElement, appendChildren, setText } from "@lib/dom";
import { createIcon } from "@lib/icons";
import type { MountableComponent } from "@lib/safe-render";
import type { RingState } from "@lib/call-ring";

export interface IncomingCallBannerOptions {
  readonly onAccept: () => void;
  readonly onDecline: () => void;
}

export interface IncomingCallBannerComponent extends MountableComponent {
  /** Show the banner for a ring, or hide it with null. */
  readonly setRing: (state: RingState | null) => void;
}

export function createIncomingCallBanner(
  options: IncomingCallBannerOptions,
): IncomingCallBannerComponent {
  const ac = new AbortController();

  const root = createElement("div", {
    class: "incoming-call-banner",
    role: "alert",
    "data-testid": "incoming-call-banner",
  });
  root.style.display = "none";

  const icon = createElement("div", { class: "incoming-call-icon" });
  icon.appendChild(createIcon("phone", 20));

  const info = createElement("div", { class: "incoming-call-info" });
  const title = createElement("div", {
    class: "incoming-call-title",
    "data-testid": "incoming-call-title",
  });
  const subtitle = createElement("div", { class: "incoming-call-subtitle" }, "Incoming call");
  appendChildren(info, title, subtitle);

  const acceptBtn = createElement(
    "button",
    {
      class: "btn btn-primary incoming-call-accept",
      type: "button",
      "data-testid": "incoming-call-accept",
    },
    "Accept",
  );
  acceptBtn.addEventListener("click", () => options.onAccept(), { signal: ac.signal });

  const declineBtn = createElement(
    "button",
    {
      class: "btn btn-danger incoming-call-decline",
      type: "button",
      "data-testid": "incoming-call-decline",
    },
    "Decline",
  );
  declineBtn.addEventListener("click", () => options.onDecline(), { signal: ac.signal });

  const actions = createElement("div", { class: "incoming-call-actions" });
  appendChildren(actions, acceptBtn, declineBtn);
  appendChildren(root, icon, info, actions);

  function setRing(state: RingState | null): void {
    if (state === null) {
      root.style.display = "none";
      setText(title, "");
      return;
    }
    // setText, never innerHTML: the username is user-controlled.
    setText(title, `${state.fromUsername} is calling`);
    root.style.display = "";
  }

  return {
    mount(container: Element): void {
      container.appendChild(root);
    },
    destroy(): void {
      ac.abort();
      root.remove();
    },
    setRing,
  };
}
