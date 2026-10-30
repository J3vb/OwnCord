/**
 * ChannelPasswordDialog — asks for a voice channel's password before a join.
 * The password lives only in the input: it is handed to `onSubmit` once and the
 * dialog closes, so nothing here (or in a store) keeps it. A wrong or rate
 * limited try is shown by opening a fresh dialog with `error` set.
 */

import { Disposable } from "@lib/disposable";
import { appendChildren, createElement, setText } from "@lib/dom";
import { isImeCommit } from "@lib/text/ime";
import { createModal, type ModalInstance } from "@lib/modalFactory";
import type { MountableComponent } from "@lib/text/safeRender";
import { connectText } from "../i18n/connect";
import { voiceText } from "../i18n/voice";

/** The server's ceiling for a channel password, mirrored on the input. */
const MAX_PASSWORD_LENGTH = 64;

/** Why the dialog opens again after a try. */
export type PasswordProblem = "wrong" | "rateLimited";

export interface ChannelPasswordDialogOptions {
  readonly channelName: string;
  /** Why the last try failed, shown under the input; null on a first ask. */
  readonly problem: PasswordProblem | null;
  /** Called once with what was typed; the dialog closes right after. */
  readonly onSubmit: (password: string) => void;
  /** However the dialog ended: submit, cancel, Escape, the backdrop, `destroy()`. */
  readonly onClose: () => void;
}

export function createChannelPasswordDialog(
  options: ChannelPasswordDialogOptions,
): MountableComponent {
  const disposable = new Disposable();
  let instance: ModalInstance | null = null;

  function mount(container: Element): void {
    const header = createElement("div", { class: "modal-header" });
    appendChildren(
      header,
      createElement("h3", { id: "channel-password-title" }, voiceText("passwordDialog.title")),
    );

    const body = createElement("div", { class: "modal-body" });
    const intro = createElement(
      "p",
      { style: "margin: 0 0 12px;" },
      voiceText("passwordDialog.body", { channel: options.channelName }),
    );
    const group = createElement("div", { class: "form-group" });
    const label = createElement(
      "label",
      { class: "form-label", for: "channel-password-input" },
      voiceText("passwordDialog.label"),
    );
    const input = createElement("input", {
      id: "channel-password-input",
      class: "form-input",
      type: "password",
      autocomplete: "off",
      maxlength: String(MAX_PASSWORD_LENGTH),
      "data-testid": "channel-password-input",
    });
    const errorEl = createElement("div", {
      id: "channel-password-error",
      role: "alert",
      style: "color: var(--text-danger); font-size: 13px; margin-top: 6px;",
      "data-testid": "channel-password-error",
    });
    if (options.problem === null) {
      errorEl.style.display = "none";
    } else {
      setText(
        errorEl,
        voiceText(
          options.problem === "wrong" ? "passwordDialog.wrong" : "passwordDialog.rateLimited",
        ),
      );
      input.setAttribute("aria-invalid", "true");
      input.setAttribute("aria-describedby", "channel-password-error");
    }
    appendChildren(group, label, input, errorEl);
    appendChildren(body, intro, group);

    const footer = createElement("div", { class: "modal-footer" });
    const cancelBtn = createElement(
      "button",
      { class: "btn-modal-cancel", type: "button", "data-testid": "channel-password-cancel" },
      connectText("common.cancel"),
    );
    const joinBtn = createElement(
      "button",
      { class: "btn-modal-save", type: "button", "data-testid": "channel-password-submit" },
      voiceText("passwordDialog.join"),
    );
    joinBtn.disabled = true;
    appendChildren(footer, cancelBtn, joinBtn);

    const content = createElement("div");
    appendChildren(content, header, body, footer);
    const modal = createModal(
      {
        content,
        ariaLabelledBy: "channel-password-title",
        overlayAttrs: { "data-testid": "channel-password-dialog" },
        onClose: () => {
          // Nothing typed outlives the dialog.
          input.value = "";
          disposable.destroy();
          options.onClose();
        },
      },
      container,
    );
    instance = modal;

    let submitted = false;
    const submit = (): void => {
      if (submitted || input.value === "") return;
      submitted = true;
      const password = input.value;
      modal.close();
      options.onSubmit(password);
    };
    input.addEventListener(
      "input",
      () => {
        joinBtn.disabled = input.value === "";
      },
      { signal: disposable.signal },
    );
    input.addEventListener(
      "keydown",
      (e) => {
        if (e.key !== "Enter" || e.repeat || isImeCommit(e)) return;
        e.preventDefault();
        submit();
      },
      { signal: disposable.signal },
    );
    joinBtn.addEventListener("click", submit, { signal: disposable.signal });
    cancelBtn.addEventListener("click", () => modal.close(), { signal: disposable.signal });
    input.focus();
  }

  function destroy(): void {
    instance?.destroy();
    instance = null;
  }

  return { mount, destroy };
}
