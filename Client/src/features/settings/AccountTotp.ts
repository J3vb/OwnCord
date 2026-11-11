/** Account tab two-factor section: enrolment, setup key display and disabling. */

import { createElement, appendChildren, setText, focusIsOurs } from "@lib/dom";
import { errorText, ApiClientError } from "@lib/api";
import { authStore } from "@stores/auth.store";
import type { SettingsOverlayOptions } from "./SettingsOverlay";
import { buildShownOnce, buildRegenerateCodes } from "./RecoverySections";
import { outcomeEl } from "./helpers";
import { createStatusRow, setStatusIcon, type StatusKind } from "./status";
import { accountText as t } from "../../i18n/account";
import { RestErrorCode } from "@lib/protocolTypes";
import { createLogger } from "@lib/logger";
import { copyThenRelabel } from "@lib/ui/clipboard";
import { isPhoneLayout } from "@lib/ui/bottomSheet";

const log = createLogger("AccountTab");

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

/** The secret an otpauth:// link carries, or null when it has none. */
export function totpSecretOf(uri: string): string | null {
  const match = /[?&]secret=([^&#]+)/i.exec(uri);
  if (match === null) return null;
  try {
    return decodeURIComponent(match[1]!).replaceAll(/\s+/g, "").toUpperCase();
  } catch {
    return null;
  }
}

/** The key in groups of four, as authenticator apps show it. */
const groupKey = (key: string): string => key.replaceAll(/(.{4})(?=.)/g, "$1 ");

/**
 * The enrolment's setup key: a QR code to scan, the key itself with a Copy
 * button for typing it in (first on a phone, which cannot scan its own
 * screen), and the full link behind a disclosure.
 */
function buildTotpSetupKey(uri: string, signal: AbortSignal): HTMLElement[] {
  const phone = isPhoneLayout();
  const secret = totpSecretOf(uri);

  const linkBox = createElement("details", { class: "disclose totp-link" });
  const summary = createElement("summary", {}, t("totp.showLink"));
  const link = createElement(
    "code",
    { class: "totp-link-value", "data-testid": "totp-qr-uri" },
    uri,
  );
  linkBox.append(summary, link);
  // Without a key the link is the only fallback to a QR that cannot be drawn.
  if (secret === null) linkBox.open = true;

  const qrBlock = createElement("div", { class: "totp-qr", "data-testid": "totp-qr" });
  // The encoder loads with the enrolment, not with Settings.
  void import("@lib/ui/qrCode").then(
    ({ qrCodeSvg }) => {
      if (signal.aborted) return;
      const qr = qrCodeSvg(uri, t("totp.qrLabel"));
      if (qr === null) {
        linkBox.open = true;
        return;
      }
      const frame = createElement("div", { class: "totp-qr-code" });
      frame.appendChild(qr);
      qrBlock.append(createElement("div", { class: "totp-setup-label" }, t("totp.scanQr")), frame);
    },
    (err: unknown) => {
      log.warn("QR encoder failed to load", { error: String(err) });
      if (!signal.aborted) linkBox.open = true;
    },
  );

  const keyBlock = createElement("div", { class: "totp-key" });
  if (secret !== null) {
    const keyText = createElement(
      "code",
      { class: "totp-key-value", "data-testid": "totp-secret" },
      groupKey(secret),
    );
    const copyBtn = createElement(
      "button",
      { class: "ac-btn secondary", type: "button", "data-testid": "totp-copy-key" },
      t("totp.copyKey"),
    );
    copyBtn.addEventListener(
      "click",
      () =>
        copyThenRelabel(
          secret,
          copyBtn,
          { idle: t("totp.copyKey"), done: t("totp.keyCopied"), failed: t("totp.copyFailed") },
          { signal },
        ),
      { signal },
    );
    const keyRow = createElement("div", { class: "totp-key-row" });
    keyRow.append(keyText, copyBtn);
    keyBlock.append(
      createElement(
        "div",
        { class: "totp-setup-label" },
        phone ? t("totp.enterKey") : t("totp.orEnterKey"),
      ),
      keyRow,
    );
  }

  return phone ? [keyBlock, qrBlock, linkBox] : [qrBlock, keyBlock, linkBox];
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

  const elements: HTMLElement[] = buildTotpSetupKey(result.qr_uri, signal);

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
