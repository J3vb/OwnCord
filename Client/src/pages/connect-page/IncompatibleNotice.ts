// IncompatibleNotice — the actionable, exitable state for a protocol-epoch
// mismatch on the connect page (B7-12, Decision 2).
//
// A dedicated component, not an UpdateNotifier state (which would teach
// "install" to say "update the server") and not the generic transient-error
// banner (which conflates a refusal with a session error). It states which
// side updates, with the two epoch numbers, and offers two exits: update the
// client (only when the client is the older side) or leave.

import { createElement, setText, appendChildren, clearChildren } from "@lib/dom";
import { connectText } from "../../i18n/connect";

export interface IncompatibleNoticeOptions {
  /** Called when the user chooses to update this client. */
  readonly onUpdate: (host: string) => void;
  /** Called when the user dismisses the notice. */
  readonly onLeave: () => void;
}

export interface IncompatibleNotice {
  readonly element: HTMLDivElement;
  /** Show the requirement for a selected/refused host. */
  show(host: string, serverEpoch: number | null, clientEpoch: number): void;
  hide(): void;
  destroy(): void;
}

/**
 * The server's own wording is the source of truth (`Server/ws/messages.go`):
 * "this client speaks protocol epoch N but the server needs M; update the
 * client" / "…update the server". Do not invent a second phrasing.
 */
function requirementText(host: string, serverEpoch: number | null, clientEpoch: number): string {
  if (serverEpoch !== null && serverEpoch > clientEpoch) {
    return connectText("incompatible.clientOlder", { host, clientEpoch, serverEpoch });
  }
  if (serverEpoch !== null) {
    return connectText("incompatible.serverOlder", { host, clientEpoch, serverEpoch });
  }
  return connectText("incompatible.unknown", { host });
}

export function createIncompatibleNotice(opts: IncompatibleNoticeOptions): IncompatibleNotice {
  // `visible` mirrors the connect page's error-banner precedent; the element
  // stays mounted and is shown by class, so a later show() needs no re-attach.
  const element = createElement("div", { class: "incompatible-notice", role: "alert" });
  let currentHost: string | null = null;

  function render(serverEpoch: number | null, clientEpoch: number): void {
    clearChildren(element);
    if (currentHost === null) return;

    const text = createElement("div", { class: "incompatible-notice-text" });
    setText(text, requirementText(currentHost, serverEpoch, clientEpoch));

    const actions = createElement("div", { class: "incompatible-notice-actions" });
    // The update exit is offered only when the client is the older side: an
    // older server's requirement cannot be resolved by installing this
    // client, and offering the updater there would update the wrong side.
    if (serverEpoch !== null && serverEpoch > clientEpoch) {
      const updateBtn = createElement("button", {
        class: "incompatible-notice-update btn-primary",
        type: "button",
      });
      setText(updateBtn, connectText("incompatible.updateClient"));
      updateBtn.addEventListener("click", () => {
        if (currentHost !== null) opts.onUpdate(currentHost);
      });
      actions.appendChild(updateBtn);
    }

    const leaveBtn = createElement("button", {
      class: "incompatible-notice-leave btn-ghost",
      type: "button",
    });
    setText(leaveBtn, connectText("incompatible.leave"));
    leaveBtn.addEventListener("click", () => {
      notice.hide();
      opts.onLeave();
    });
    appendChildren(actions, leaveBtn);

    appendChildren(element, text, actions);
  }

  const notice: IncompatibleNotice = {
    element,
    show(host: string, serverEpoch: number | null, clientEpoch: number): void {
      currentHost = host;
      render(serverEpoch, clientEpoch);
      element.classList.add("visible");
    },
    hide(): void {
      currentHost = null;
      element.classList.remove("visible");
      clearChildren(element);
    },
    destroy(): void {
      currentHost = null;
      element.classList.remove("visible");
      clearChildren(element);
    },
  };

  return notice;
}
