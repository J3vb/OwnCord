/**
 * The Warn dialog: one required reason that is sent to a member as a warning.
 *
 * The request is the caller's (`submit`: the cleaned reason). This module owns
 * what the answer means:
 * - Success closes the dialog and confirms with a toast.
 * - A rejection (outranked, no permission, member gone, a refused reason, a
 *   lost reply) shows the error under the field and keeps the dialog open with
 *   the typed reason, ready to send again.
 * One request is in flight at a time, so a double submit sends once.
 *
 * The reason is collapsed to one line and counted in characters before it is
 * sent, so what is checked is what is sent; the server stays the authority.
 */

import { errorText } from "@lib/api";
import { isImeCommit } from "@lib/text/ime";
import { createElement, setText } from "@lib/dom";
import { createModal, type ModalInstance } from "@lib/ui/modalFactory";
import { attachLimitHint, collapseSpaces, lineHintText, runeCount } from "@lib/text/nameLimits";
import type { ToastType } from "@lib/ui/toastContainer";
import { shellText } from "../../i18n/shell";
import { moderationText as t } from "../../i18n/moderation";

/** Server/service/moderation.go reasonMaxRunes. */
export const WARN_REASON_MAX = 500;

export interface WarnDialogOptions {
  /** Display name, for the title. */
  readonly name: string;
  /** Handle, for the toast. */
  readonly username: string;
  /** Sends one request with the reason. Rejects with the failure. */
  readonly submit: (reason: string) => Promise<unknown>;
  readonly notify: (message: string, type: ToastType) => void;
  /** Closes the dialog with its owner. */
  readonly signal?: AbortSignal;
  readonly fallbackFocus?: () => HTMLElement | null;
}

/** Control characters become spaces (the server refuses them), then spaces collapse. */
const cleanReason = (raw: string): string => collapseSpaces(raw.replace(/\p{Cc}+/gu, " "));

export function openWarnDialog(options: WarnDialogOptions): ModalInstance {
  const { name, username, notify } = options;

  const titleId = "warn-dialog-title";
  const content = createElement("div");
  const header = createElement("div", { class: "modal-header" });
  header.append(createElement("h3", { id: titleId }, t("warnDialog.title", { name })));

  const body = createElement("div", { class: "modal-body" });
  const input = createElement("input", {
    id: "warn-dialog-input",
    class: "form-input",
    type: "text",
    autocomplete: "off",
    required: "",
    "data-testid": "warn-input",
  });
  const hint = attachLimitHint(input, {
    max: WARN_REASON_MAX,
    hint: lineHintText(WARN_REASON_MAX),
    countCharacters: true,
    id: "warn-dialog-hint",
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  hint.el.dataset["testid"] = "warn-hint";
  const group = createElement("div", { class: "form-group" });
  group.append(
    createElement(
      "label",
      { class: "form-label", for: "warn-dialog-input" },
      t("warnDialog.label"),
    ),
    input,
    hint.el,
  );

  const status = createElement("div", {
    class: "form-group",
    role: "alert",
    style: "color: var(--text-danger); font-size: 13px; display: none;",
    "data-testid": "warn-status",
  });
  body.append(createElement("p", {}, t("warnDialog.body")), group, status);

  const footer = createElement("div", { class: "modal-footer" });
  const cancel = createElement(
    "button",
    { class: "btn-modal-cancel", type: "button", "data-testid": "warn-cancel" },
    shellText("common.cancel"),
  );
  const send = createElement(
    "button",
    { class: "btn-modal-save", type: "button", "data-testid": "warn-send" },
    t("warnDialog.send"),
  );
  footer.append(cancel, send);
  content.append(header, body, footer);

  let closed = false;
  let inFlight = false;

  const modal = createModal({
    content,
    ariaLabelledBy: titleId,
    overlayAttrs: { "data-testid": "warn-dialog" },
    // A stray backdrop click must not drop a typed reason.
    closeOnBackdrop: false,
    onClose: () => {
      closed = true;
    },
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.fallbackFocus === undefined ? {} : { fallbackFocus: options.fallbackFocus }),
  });

  function showStatus(text: string): void {
    status.style.display = "block";
    setText(status, text);
  }

  function setBusy(busy: boolean): void {
    inFlight = busy;
    input.disabled = busy;
    send.disabled = busy;
    setText(send, t(busy ? "warnDialog.sending" : "warnDialog.send"));
  }

  async function submitReason(): Promise<void> {
    if (inFlight) return;
    const reason = cleanReason(input.value);
    if (reason === "") {
      hint.showError(t("warnDialog.required"));
      input.focus();
      return;
    }
    if (runeCount(reason) > WARN_REASON_MAX) {
      hint.showError(t("warnDialog.tooLong", { max: WARN_REASON_MAX }));
      input.focus();
      return;
    }
    status.style.display = "none";
    setBusy(true);
    try {
      await options.submit(reason);
    } catch (err) {
      // The dialog may have closed with its owner while the request ran.
      if (closed) {
        notify(errorText(err, t("warnDialog.failed")), "error");
        return;
      }
      setBusy(false);
      showStatus(errorText(err, t("warnDialog.failed")));
      input.focus();
      return;
    }
    notify(t("warnDialog.warned", { username }), "success");
    modal.close();
  }

  cancel.addEventListener("click", () => modal.close());
  send.addEventListener("click", () => void submitReason());
  input.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key !== "Enter" || isImeCommit(e)) return;
    e.preventDefault();
    void submitReason();
  });
  input.focus();

  return modal;
}
