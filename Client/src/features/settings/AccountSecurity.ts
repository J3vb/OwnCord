/** Account tab: the password form and the two-factor sections. */

import { createElement, appendChildren, setText, focusIsOurs } from "@lib/dom";
import { errorText, ApiClientError } from "@lib/api";
import { authStore } from "@stores/auth.store";
import type { SettingsOverlayOptions } from "./SettingsOverlay";
import { buildShownOnce, buildRegenerateCodes } from "./RecoverySections";
import { outcomeEl, showOutcome } from "./helpers";
import { createStatusRow, setStatusIcon, createRevealToggle, type StatusKind } from "./status";
import { accountText as t } from "../../i18n/account";
import { RestErrorCode } from "@lib/protocolTypes";
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
      void options
        .onChangePassword(oldVal, newVal)
        .then((outcome) => {
          oldPw.value = "";
          newPw.value = "";
          confirmPw.value = "";
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

  appendChildren(wrapper, oldField.wrapper, newField.wrapper, confirmField.wrapper, pwError, pwBtn);
  return row;
}

// ---------------------------------------------------------------------------
// TOTP section builder
// ---------------------------------------------------------------------------

function buildTotpEnrollForm(
  options: SettingsOverlayOptions,
  signal: AbortSignal,
  onEnrolled: () => void,
): HTMLDivElement {
  const wrapper = createElement("div", {});

  const description = createElement(
    "div",
    {
      style: "color:var(--text-muted);font-size:13px;margin-bottom:12px",
    },
    t("totp.description"),
  );

  const enableBtn = createElement(
    "button",
    {
      class: "ac-btn",
      "data-testid": "totp-enable-btn",
    },
    t("totp.enable"),
  );

  const formArea = createElement("div", { style: "display:none" });
  const pwInput = createElement("input", {
    class: "form-input",
    type: "password",
    placeholder: t("totp.passwordPlaceholder"),
    style: "margin-bottom:12px",
    "data-testid": "totp-password-input",
  });
  const errorEl = outcomeEl("error", "totp-error");
  errorEl.style.marginBottom = "8px";
  const submitBtn = createElement("button", { class: "ac-btn" }, t("totp.submit"));

  appendChildren(formArea, pwInput, errorEl, submitBtn);

  const enrollArea = createElement("div", { style: "display:none" });

  enableBtn.addEventListener(
    "click",
    () => {
      enableBtn.style.display = "none";
      formArea.style.display = "block";
      pwInput.value = "";
      setText(errorEl, "");
      pwInput.focus();
    },
    { signal },
  );

  submitBtn.addEventListener(
    "click",
    () => {
      const pw = pwInput.value;
      if (pw.length === 0) {
        setText(errorEl, t("password.required"));
        return;
      }
      setText(errorEl, "");
      submitBtn.disabled = true;
      setText(submitBtn, t("totp.requesting"));

      void options
        .onEnableTotp(pw)
        .then((result) => {
          const restoreFocus = focusIsOurs(formArea);
          formArea.style.display = "none";
          buildTotpConfirmArea(enrollArea, options, pw, result, signal, onEnrolled);
          enrollArea.style.display = "block";
          submitBtn.disabled = false;
          setText(submitBtn, t("totp.submit"));
          if (restoreFocus) enrollArea.querySelector<HTMLElement>("button, input")?.focus();
        })
        .catch((err: unknown) => {
          setText(errorEl, errorText(err, t("totp.enableFailed")));
          submitBtn.disabled = false;
          setText(submitBtn, t("totp.submit"));
          if (focusIsOurs(submitBtn)) submitBtn.focus();
        });
    },
    { signal },
  );

  appendChildren(wrapper, description, enableBtn, formArea, enrollArea);
  return wrapper;
}

function buildTotpConfirmArea(
  container: HTMLDivElement,
  options: SettingsOverlayOptions,
  password: string,
  result: { qr_uri: string; backup_codes: string[] },
  signal: AbortSignal,
  onEnrolled: () => void,
): void {
  // Clear previous content immutably (remove children)
  while (container.firstChild) {
    container.removeChild(container.firstChild);
  }

  const qrLabel = createElement(
    "div",
    {
      style: "color:var(--text-muted);font-size:13px;margin-bottom:8px",
    },
    t("totp.scanUri"),
  );

  const qrUri = createElement(
    "code",
    {
      style:
        "display:block;background:var(--bg-active);padding:8px 12px;border-radius:6px;" +
        "font-family:monospace;font-size:12px;word-break:break-all;margin-bottom:12px;" +
        "color:var(--text-primary);user-select:all",
      "data-testid": "totp-qr-uri",
    },
    result.qr_uri,
  );

  const elements: HTMLElement[] = [qrLabel, qrUri];

  if (result.backup_codes.length > 0) {
    // These codes are shown exactly once — the confirm step replaces this view.
    // Say so, and give a one-click way to keep them.
    const reveal = buildShownOnce(
      {
        warning: t("totp.backupWarning"),
        text: result.backup_codes.join("\n"),
        codeTestId: "totp-backup-codes",
        copyTestId: "totp-copy-backup-codes",
        copyLabel: t("totp.copyCodes"),
      },
      signal,
    );
    elements.push(reveal.element);
  }

  const codeInput = createElement("input", {
    class: "form-input",
    type: "text",
    placeholder: t("totp.codePlaceholder"),
    maxlength: "6",
    style: "margin-bottom:12px",
    "data-testid": "totp-code-input",
  });

  const confirmError = outcomeEl("error", "totp-error");
  confirmError.style.marginBottom = "8px";

  const confirmBtn = createElement(
    "button",
    {
      class: "ac-btn",
      "data-testid": "totp-confirm-btn",
    },
    t("totp.verify"),
  );

  confirmBtn.addEventListener(
    "click",
    () => {
      const code = codeInput.value.trim();
      if (!/^\d{6}$/.test(code)) {
        setText(confirmError, t("totp.codeInvalid"));
        return;
      }
      setText(confirmError, "");
      confirmBtn.disabled = true;
      setText(confirmBtn, t("totp.verifying"));

      void options
        .onConfirmTotp(password, code)
        .then(() => {
          onEnrolled();
        })
        .catch((err: unknown) => {
          setText(confirmError, errorText(err, t("totp.enableFailed")));
          confirmBtn.disabled = false;
          setText(confirmBtn, t("totp.verify"));
          if (focusIsOurs(confirmBtn)) confirmBtn.focus();
        });
    },
    { signal },
  );

  elements.push(codeInput, confirmError, confirmBtn);
  appendChildren(container, ...elements);
}

function buildTotpDisableView(
  options: SettingsOverlayOptions,
  signal: AbortSignal,
  onDisabled: () => void,
): HTMLDivElement {
  const wrapper = createElement("div", {});

  const description = createElement(
    "div",
    {
      style: "color:var(--text-muted);font-size:13px;margin-bottom:12px",
    },
    t("totp.protected"),
  );

  const disableBtn = createElement(
    "button",
    {
      class: "ac-btn secondary destructive",
      "data-testid": "totp-disable-btn",
    },
    t("totp.disable"),
  );

  const confirmArea = createElement("div", { style: "display:none" });
  const pwInput = createElement("input", {
    class: "form-input",
    type: "password",
    placeholder: t("totp.passwordPlaceholder"),
    style: "margin-bottom:12px",
    "data-testid": "totp-password-input",
  });
  const errorEl = outcomeEl("error", "totp-error");
  errorEl.style.marginBottom = "8px";
  const btnRow = createElement("div", { style: "display:flex;gap:8px" });
  const confirmBtn = createElement(
    "button",
    { class: "ac-btn account-delete-btn" },
    t("totp.confirmDisable"),
  );
  const cancelBtn = createElement("button", { class: "ac-btn secondary" }, t("recovery.cancel"));
  appendChildren(btnRow, confirmBtn, cancelBtn);
  appendChildren(confirmArea, pwInput, errorEl, btnRow);

  disableBtn.addEventListener(
    "click",
    () => {
      disableBtn.style.display = "none";
      confirmArea.style.display = "block";
      pwInput.value = "";
      setText(errorEl, "");
      pwInput.focus();
    },
    { signal },
  );

  cancelBtn.addEventListener(
    "click",
    () => {
      confirmArea.style.display = "none";
      disableBtn.style.display = "";
      pwInput.value = "";
      setText(errorEl, "");
      if (focusIsOurs(confirmArea)) disableBtn.focus();
    },
    { signal },
  );

  confirmBtn.addEventListener(
    "click",
    () => {
      const pw = pwInput.value;
      if (pw.length === 0) {
        setText(errorEl, t("password.required"));
        return;
      }
      setText(errorEl, "");
      confirmBtn.disabled = true;
      setText(confirmBtn, t("totp.disabling"));

      void options
        .onDisableTotp(pw)
        .then(() => {
          onDisabled();
        })
        .catch((err: unknown) => {
          const requiredByServer =
            err instanceof ApiClientError && err.code === RestErrorCode.FORBIDDEN;
          setText(
            errorEl,
            requiredByServer ? t("totp.requiredByServer") : errorText(err, t("totp.disableFailed")),
          );
          confirmBtn.disabled = false;
          setText(confirmBtn, t("totp.confirmDisable"));
          if (focusIsOurs(confirmBtn)) confirmBtn.focus();
        });
    },
    { signal },
  );

  appendChildren(wrapper, description, disableBtn, confirmArea);
  return wrapper;
}

export function buildTotpSection(
  options: SettingsOverlayOptions,
  signal: AbortSignal,
  onState: (state: StatusKind) => void,
): HTMLLIElement {
  const { row, icon, result, body } = createStatusRow(t("totp.sectionTitle"), "totp-section");
  // The state word keeps its test hook; the hint says what "off" means.
  const statusBadge = createElement("span", {
    class: "status-state",
    "data-testid": "totp-status-badge",
  });
  const offHint = createElement("span", {}, t("totp.offHint"));
  result.append(statusBadge, " ", offHint);

  const contentArea = createElement("div", {});

  function render(afterSubmit = false): void {
    const enabled = authStore.getState().user?.totp_enabled === true;
    // The control the user just activated is being replaced, and removing it
    // drops focus to <body>. Unless the user has moved focus
    // elsewhere, move it to the first rebuilt control instead.
    const restoreFocus = afterSubmit && focusIsOurs(contentArea);

    // The words "Enabled"/"Disabled" carry the state; the icon only repeats it.
    statusBadge.textContent = enabled ? t("totp.enabled") : t("totp.disabled");
    offHint.hidden = enabled;
    const state: StatusKind = enabled ? "ok" : "warn";
    setStatusIcon(icon, state);
    onState(state);

    while (contentArea.firstChild) {
      contentArea.removeChild(contentArea.firstChild);
    }

    if (enabled) {
      contentArea.appendChild(buildTotpDisableView(options, signal, () => render(true)));
      contentArea.appendChild(buildRegenerateCodes(options, signal));
    } else {
      contentArea.appendChild(buildTotpEnrollForm(options, signal, () => render(true)));
    }
    if (restoreFocus) {
      contentArea.querySelector<HTMLElement>("button, [tabindex]")?.focus();
    }
  }

  render();

  // auth_ok never carries totp_enabled, so the store's value can be a stale
  // default until the profile has been read. Refresh when the
  // section opens; rebuild only if the answer differs from what is shown,
  // so a form the user already started is not thrown away.
  const shownEnabled = authStore.getState().user?.totp_enabled === true;
  void options
    .onRefreshTotpStatus()
    .then(() => {
      if ((authStore.getState().user?.totp_enabled === true) !== shownEnabled) render();
    })
    .catch((err) => {
      log.warn("Failed to refresh TOTP status — showing cached state", err);
    });

  body.appendChild(contentArea);
  return row;
}
