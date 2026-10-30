/**
 * The Change Nickname dialog: one input, prefilled with the member's
 * current nickname, that sets another member's server nickname; Reset clears
 * it.
 *
 * The request is the caller's (`submit`: a name, or null to clear). This
 * module owns what the answer means:
 * - Success closes the dialog. The row changes when the server's `user_update`
 *   arrives, never from here.
 * - A rejection (a refusal such as a name taken by a username, a rate limit,
 *   or a lost reply after the server already committed) shows the error under
 *   the input and keeps the dialog open. Sending again is safe: the route is
 *   idempotent.
 * One request is in flight at a time, so a double submit sends once.
 *
 * The text is collapsed (`collapseSpaces`) and counted in characters before it
 * is sent, so what is checked is what is sent; the server stays the authority.
 */

import { errorText } from "@lib/api";
import { isImeCommit } from "@lib/text/ime";
import { createElement, setText } from "@lib/dom";
import { createModal, type ModalInstance } from "@lib/modalFactory";
import {
  attachLimitHint,
  collapseSpaces,
  lineHintText,
  MAX_DISPLAY_NAME_LEN,
  runeCount,
} from "@lib/text/nameLimits";
import type { ToastType } from "@components/Toast";
import { shellText } from "../../i18n/shell";
import { moderationText as t } from "../../i18n/moderation";

export interface NicknameDialogOptions {
  /** Display name, for the title. */
  readonly name: string;
  /** Handle, for the toast. */
  readonly username: string;
  /** The nickname now; null when the member has none. */
  readonly current: string | null;
  /** Sends one request: the new nickname, or null to clear it. Rejects with the failure. */
  readonly submit: (displayName: string | null) => Promise<unknown>;
  readonly notify: (message: string, type: ToastType) => void;
  /** Closes the dialog with its owner. */
  readonly signal?: AbortSignal;
  readonly fallbackFocus?: () => HTMLElement | null;
}

export function openNicknameDialog(options: NicknameDialogOptions): ModalInstance {
  const { name, username, notify } = options;

  const titleId = "nickname-dialog-title";
  const content = createElement("div");
  const header = createElement("div", { class: "modal-header" });
  header.append(createElement("h3", { id: titleId }, t("nicknameDialog.title", { name })));

  const body = createElement("div", { class: "modal-body" });
  const input = createElement("input", {
    id: "nickname-dialog-input",
    class: "form-input",
    type: "text",
    autocomplete: "off",
    "data-testid": "nickname-input",
  });
  input.value = options.current ?? "";
  const hint = attachLimitHint(input, {
    max: MAX_DISPLAY_NAME_LEN,
    hint: lineHintText(MAX_DISPLAY_NAME_LEN),
    countCharacters: true,
    id: "nickname-dialog-hint",
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  hint.el.dataset["testid"] = "nickname-hint";
  const group = createElement("div", { class: "form-group" });
  group.append(
    createElement(
      "label",
      { class: "form-label", for: "nickname-dialog-input" },
      t("nicknameDialog.label"),
    ),
    input,
    hint.el,
  );

  const status = createElement("div", {
    class: "form-group",
    role: "alert",
    style: "color: var(--text-danger); font-size: 13px; display: none;",
    "data-testid": "nickname-status",
  });
  body.append(createElement("p", {}, t("nicknameDialog.body")), group, status);

  const footer = createElement("div", { class: "modal-footer" });
  const reset = createElement(
    "button",
    { class: "btn-ghost", type: "button", "data-testid": "nickname-reset" },
    t("nicknameDialog.reset"),
  );
  const cancel = createElement(
    "button",
    { class: "btn-modal-cancel", type: "button", "data-testid": "nickname-cancel" },
    shellText("common.cancel"),
  );
  const save = createElement(
    "button",
    { class: "btn-primary", type: "button", "data-testid": "nickname-save" },
    t("nicknameDialog.save"),
  );
  footer.append(reset, cancel, save);
  content.append(header, body, footer);

  let closed = false;
  let inFlight = false;

  const modal = createModal({
    content,
    ariaLabelledBy: titleId,
    overlayAttrs: { "data-testid": "nickname-dialog" },
    // A stray backdrop click must not drop a typed name.
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
    reset.disabled = busy;
    save.disabled = busy;
    setText(save, t(busy ? "nicknameDialog.saving" : "nicknameDialog.save"));
  }

  async function send(displayName: string | null): Promise<void> {
    if (inFlight) return;
    status.style.display = "none";
    setBusy(true);
    try {
      await options.submit(displayName);
    } catch (err) {
      // The server may have committed before the reply was lost; the dialog
      // stays open and the same request can be sent again.
      if (closed) {
        notify(failureText(err), "error");
        return;
      }
      setBusy(false);
      showStatus(failureText(err));
      input.focus();
      return;
    }
    notify(
      t(displayName === null ? "nicknameDialog.cleared" : "nicknameDialog.changed", { username }),
      "success",
    );
    modal.close();
  }

  function submitText(): void {
    if (inFlight) return;
    const text = collapseSpaces(input.value);
    if (runeCount(text) > MAX_DISPLAY_NAME_LEN) {
      hint.showError(t("nicknameDialog.tooLong", { max: MAX_DISPLAY_NAME_LEN }));
      input.focus();
      return;
    }
    // An empty field clears, as Reset does.
    void send(text === "" ? null : text);
  }

  cancel.addEventListener("click", () => modal.close());
  reset.addEventListener("click", () => void send(null));
  save.addEventListener("click", submitText);
  input.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key !== "Enter" || isImeCommit(e)) return;
    e.preventDefault();
    submitText();
  });
  input.focus();
  input.select();

  return modal;
}

/** The server names the field `display_name`; this dialog calls it a nickname. */
function failureText(err: unknown): string {
  return errorText(err, t("nicknameDialog.failed")).replace(
    /^display_name\b/i,
    t("nicknameDialog.label"),
  );
}
