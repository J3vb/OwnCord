/** Account tab: the password form and the two-factor sections. */

import { createElement, appendChildren, setText, focusIsOurs } from "@lib/dom";
import { errorText } from "@lib/api";
import type { SettingsOverlayOptions } from "./SettingsOverlay";
import { outcomeEl, showOutcome } from "./helpers";
import { createStatusRow, setStatusIcon, createRevealToggle } from "./status";
import { accountText as t } from "../../i18n/account";
import { createLogger } from "@lib/logger";

const log = createLogger("AccountTab");

// ---------------------------------------------------------------------------
// Password section builder
// ---------------------------------------------------------------------------

/** A labelled password field for the password-change form. */
function passwordField(
  id: string,
  label: string,
  placeholder: string,
): { wrapper: HTMLDivElement; input: HTMLInputElement } {
  const wrapper = createElement("div", {});
  const labelEl = createElement("label", { class: "form-label", for: id }, label);
  const input = createElement("input", {
    class: "form-input",
    type: "password",
    id,
    placeholder,
    style: "margin:4px 0 12px",
  });
  appendChildren(wrapper, labelEl, input);
  return { wrapper, input };
}

export function buildPasswordSection(
  options: SettingsOverlayOptions,
  signal: AbortSignal,
  tokensChanged?: EventTarget,
): HTMLLIElement {
  const { row, icon, result, body } = createStatusRow(
    t("password.sectionTitle"),
    "password-section",
  );
  setStatusIcon(icon, "ok");
  setText(result, t("password.set"));
  // The form opens on demand: changing a password is rare.
  const wrapper = createElement("div", {});
  row.insertBefore(
    createRevealToggle(t("password.changeToggle"), wrapper, signal, "password-change-toggle"),
    body,
  );
  body.appendChild(wrapper);

  const oldField = passwordField("pw-old", t("password.old"), t("password.old"));
  const newField = passwordField("pw-new", t("password.new"), t("password.new"));
  const confirmField = passwordField("pw-confirm", t("password.confirm"), t("password.confirm"));
  const oldPw = oldField.input;
  const newPw = newField.input;
  const confirmPw = confirmField.input;
  const pwError = outcomeEl("error", "pw-change-status");
  pwError.style.marginBottom = "8px";
  const pwBtn = createElement("button", { class: "ac-btn" }, t("password.change"));
  // Ticked by default: a password change after a suspected leak should end
  // every credential. Hidden only once the list confirms there are no tokens;
  // until then, or when the list fails, the default still applies (revoking
  // nothing is harmless) and a failed list shows the option.
  const revokeTokensRow = createElement("label", {
    class: "form-check",
    "data-testid": "pw-revoke-api-tokens-row",
  });
  const revokeTokensBox = createElement("input", {
    type: "checkbox",
    "data-testid": "pw-revoke-api-tokens",
  });
  revokeTokensBox.checked = options.onListApiTokens !== undefined;
  // Once the user has set the box, a later refresh never overrides it.
  let userSetBox = false;
  revokeTokensBox.addEventListener("change", () => (userSetBox = true), { signal });
  appendChildren(
    revokeTokensRow,
    revokeTokensBox,
    createElement("span", {}, t("password.revokeApiTokens")),
  );
  revokeTokensRow.hidden = true;
  revokeTokensRow.style.marginBottom = "12px";
  let refreshGen = 0;
  const refreshTokenOption = (): void => {
    const listTokens = options.onListApiTokens;
    if (listTokens === undefined) return;
    const gen = ++refreshGen;
    void listTokens()
      .then((tokens) => {
        if (signal.aborted || gen !== refreshGen) return;
        const hasTokens = tokens.length > 0;
        // Confirmed none: nothing to revoke. Newly shown: back to the default.
        if (!hasTokens) revokeTokensBox.checked = false;
        else if (revokeTokensRow.hidden && !userSetBox) revokeTokensBox.checked = true;
        revokeTokensRow.hidden = !hasTokens;
      })
      .catch((err: unknown) => {
        if (signal.aborted || gen !== refreshGen) return;
        log.warn("Failed to list API tokens", err);
        revokeTokensRow.hidden = false;
      });
  };
  refreshTokenOption();
  tokensChanged?.addEventListener("change", refreshTokenOption, { signal });
  let pwSuccessTimer: ReturnType<typeof setTimeout> | null = null;

  pwBtn.addEventListener(
    "click",
    () => {
      const oldVal = oldPw.value;
      const newVal = newPw.value;
      const confirmVal = confirmPw.value;

      showOutcome(pwError, "error", "");
      if (oldVal.length === 0) {
        setText(pwError, t("password.enterCurrent"));
        return;
      }
      if (newVal.length < 8) {
        setText(pwError, t("password.tooShort"));
        return;
      }
      if (newVal !== confirmVal) {
        setText(pwError, t("password.mismatch"));
        return;
      }
      setText(pwError, "");
      // In-flight state: a second click would burn an attempt against the
      // server's lockout counter with the same credentials.
      pwBtn.disabled = true;
      setText(pwBtn, t("password.changing"));
      const finish = (): void => {
        pwBtn.disabled = false;
        setText(pwBtn, t("password.change"));
        if (focusIsOurs(pwBtn)) pwBtn.focus();
      };
      const revokeApiTokens = revokeTokensBox.checked;
      void options
        .onChangePassword(oldVal, newVal, revokeApiTokens)
        .then((outcome) => {
          oldPw.value = "";
          newPw.value = "";
          confirmPw.value = "";
          if (revokeApiTokens) {
            if (tokensChanged === undefined) refreshTokenOption();
            else tokensChanged.dispatchEvent(new Event("change"));
          }
          if (pwSuccessTimer !== null) {
            clearTimeout(pwSuccessTimer);
            pwSuccessTimer = null;
          }
          const warning = outcome?.warning;
          if (warning !== undefined && warning !== "") {
            // A partial success: the password changed, but the
            // other sessions could not be revoked. The warning is the
            // instruction to revoke them by hand, so it stays in the form
            // — no green "changed successfully", no three-second fade.
            showOutcome(pwError, "warning", warning);
          } else {
            showOutcome(pwError, "success", t("password.changed"));
            pwSuccessTimer = setTimeout(() => {
              showOutcome(pwError, "error", "");
              pwSuccessTimer = null;
            }, 3000);
          }
          finish();
        })
        .catch((err: unknown) => {
          showOutcome(pwError, "error", errorText(err, t("password.changeFailed")));
          finish();
        });
    },
    { signal },
  );

  appendChildren(
    wrapper,
    oldField.wrapper,
    newField.wrapper,
    confirmField.wrapper,
    revokeTokensRow,
    pwError,
    pwBtn,
  );
  return row;
}
export { buildTotpSection, totpSecretOf } from "./AccountTotp";
