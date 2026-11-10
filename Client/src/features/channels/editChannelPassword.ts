/**
 * The password part of the edit-channel dialog (voice channels only). The
 * password is never shown or held anywhere but its input: the section knows
 * only whether one is set. Only a change the user made is sent, so saving
 * other fields never touches it.
 */

import { createElement, appendChildren } from "@lib/dom";
import { shellText } from "../../i18n/shell";

/** The server's ceiling for a channel password, mirrored on the input. */
export const MAX_CHANNEL_PASSWORD_LENGTH = 64;

type PasswordMode = "keep" | "change" | "remove";

export interface ChannelPasswordSection {
  readonly group: HTMLDivElement;
  /** Draw the current mode into the group, keeping focus in the input. */
  render(): void;
  /** What the password part of the PATCH carries, undefined when the user left it alone. */
  change(): string | undefined;
  /** Another admin set or removed the password while the dialog is open. */
  follow(nowSet: boolean): void;
}

export function createChannelPasswordSection(options: {
  readonly isSet: boolean;
  readonly isVoice: boolean;
  readonly signal: AbortSignal;
}): ChannelPasswordSection {
  const { isVoice, signal } = options;
  let passwordSet = options.isSet;
  let passwordMode: PasswordMode = "keep";
  const group = createElement("div", {
    class: "form-group",
    "data-testid": "edit-channel-password-group",
  });
  const passwordInput = createElement("input", {
    id: "edit-channel-password",
    class: "form-input",
    type: "password",
    autocomplete: "new-password",
    maxlength: String(MAX_CHANNEL_PASSWORD_LENGTH),
    "data-testid": "edit-channel-password-input",
  });
  const passwordButton = (label: string, testId: string, onClick: () => void): HTMLElement => {
    const btn = createElement(
      "button",
      { class: "btn-modal-cancel", type: "button", "data-testid": testId },
      label,
    );
    btn.addEventListener("click", onClick, { signal });
    return btn;
  };
  function setPasswordMode(mode: PasswordMode): void {
    passwordMode = mode;
    if (mode !== "change") passwordInput.value = "";
    render();
    // The control that was clicked is gone: land on the one that replaced it.
    const next =
      mode === "change"
        ? passwordInput
        : group.querySelector<HTMLElement>(
            mode === "remove"
              ? "[data-testid='edit-channel-password-keep']"
              : "[data-testid='edit-channel-password-change']",
          );
    next?.focus();
  }
  function render(): void {
    // Redrawing detaches the input, which drops focus a remote update would
    // otherwise take from someone typing.
    const hadFocus = document.activeElement === passwordInput;
    draw();
    if (hadFocus && passwordInput.isConnected) passwordInput.focus();
  }
  function draw(): void {
    const label = createElement(
      "label",
      { class: "form-label", for: "edit-channel-password" },
      shellText("channelForm.password"),
    );
    const hint = createElement(
      "div",
      { class: "form-hint" },
      shellText("channelForm.passwordHint"),
    );
    group.replaceChildren(label);
    if (!passwordSet) {
      appendChildren(group, passwordInput, hint);
      return;
    }
    if (passwordMode === "keep") {
      const row = createElement("div", { class: "form-row", style: "align-items: center;" });
      appendChildren(
        row,
        createElement(
          "span",
          { "data-testid": "edit-channel-password-set" },
          shellText("channelForm.passwordSet"),
        ),
        passwordButton(
          shellText("channelForm.passwordChange"),
          "edit-channel-password-change",
          () => setPasswordMode("change"),
        ),
        passwordButton(
          shellText("channelForm.passwordRemove"),
          "edit-channel-password-remove",
          () => setPasswordMode("remove"),
        ),
      );
      appendChildren(group, row, hint);
    } else if (passwordMode === "change") {
      appendChildren(
        group,
        passwordInput,
        passwordButton(shellText("channelForm.passwordKeep"), "edit-channel-password-keep", () =>
          setPasswordMode("keep"),
        ),
      );
    } else {
      appendChildren(
        group,
        createElement(
          "div",
          { class: "form-hint", "data-testid": "edit-channel-password-removed" },
          shellText("channelForm.passwordRemoved"),
        ),
        passwordButton(shellText("channelForm.passwordUndo"), "edit-channel-password-keep", () =>
          setPasswordMode("keep"),
        ),
      );
    }
  }
  function change(): string | undefined {
    if (!isVoice) return undefined;
    if (passwordSet && passwordMode === "remove") return "";
    if (passwordSet && passwordMode !== "change") return undefined;
    return passwordInput.value === "" ? undefined : passwordInput.value;
  }
  function follow(nowSet: boolean): void {
    if (nowSet === passwordSet) return;
    passwordSet = nowSet;
    // A flip to protected must not carry a half-typed value into "change".
    if (nowSet) passwordInput.value = "";
    else passwordMode = "keep";
    render();
  }

  return { group, render, change, follow };
}
