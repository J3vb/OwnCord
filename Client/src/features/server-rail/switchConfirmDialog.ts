/**
 * "Switch to <server>?" before the session is torn down for another server,
 * with a "Don't ask again" box. The box is saved only on Switch: Cancel,
 * Escape and the backdrop change nothing.
 */

import { appendChildren, createElement } from "@lib/dom";
import { createConfirmModal, type ConfirmModalInstance } from "../dialogs/confirmModal";
import { serverRailText } from "../../i18n/serverRail";
import { setConfirmServerSwitch } from "./switchConfirmPref";

export interface ServerSwitchConfirmOptions {
  /** The target server's display name. */
  readonly name: string;
  readonly onConfirm: () => void;
  readonly onClose?: () => void;
  /** The owner's lifetime: an abort closes the dialog without switching. */
  readonly signal?: AbortSignal;
}

export function openServerSwitchConfirm(options: ServerSwitchConfirmOptions): ConfirmModalInstance {
  const dontAskRow = createElement("label", { class: "form-check server-switch-dont-ask" });
  const dontAskBox = createElement("input", {
    type: "checkbox",
    "data-testid": "server-switch-dont-ask",
  });
  appendChildren(
    dontAskRow,
    dontAskBox,
    createElement("span", {}, serverRailText("switchDontAsk")),
  );

  return createConfirmModal({
    title: serverRailText("switchTitle", { name: options.name }),
    body: [
      createElement("p", { id: "server-switch-body" }, serverRailText("switchBody")),
      dontAskRow,
    ],
    confirmLabel: serverRailText("switchConfirm"),
    tone: "primary",
    testId: "server-switch-dialog",
    confirmTestId: "server-switch-confirm",
    cancelTestId: "server-switch-cancel",
    describedBy: "server-switch-body",
    onConfirm: () => {
      if (dontAskBox.checked) setConfirmServerSwitch(false);
      options.onConfirm();
    },
    ...(options.onClose === undefined ? {} : { onClose: options.onClose }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
}
