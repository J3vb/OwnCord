/**
 * Account recovery controls for the Account tab: the shown-once secret
 * reveal, the recovery-kit section and emergency-code regeneration.
 *
 * Everything revealed here is a recovery root for the account. It is shown
 * once, never logged, never written to any storage, and wiped from the DOM
 * when the user dismisses it or leaves the tab (the build signal aborts on a
 * tab switch and on closing the overlay).
 */

import { createElement, appendChildren, setText } from "@lib/dom";
import { errorText } from "@lib/api";
import type { RecoveryKitStatus } from "@lib/api";
import type { SettingsOverlayOptions } from "../SettingsOverlay";
import { accountText as t } from "../../i18n/account";

const MUTED = "color:var(--text-muted);font-size:13px;margin-bottom:12px";
// --text-danger is the qualified error-text token; --red (the fill) reads
// 3.35:1 on --bg-primary, below Q1's 4.5:1 (B9-2 UI contract).
const ERROR = "color:var(--text-danger);font-size:13px;margin-bottom:8px";

export interface ShownOnce {
  readonly element: HTMLDivElement;
  /** Remove the secret from the DOM. Idempotent. */
  clear(): void;
}

/**
 * A secret shown exactly once, with a copy button. The text is wiped when
 * `signal` aborts or `clear()` runs, so it does not outlive the section.
 */
export function buildShownOnce(
  opts: {
    readonly warning: string;
    readonly text: string;
    readonly codeTestId: string;
    readonly copyTestId: string;
    readonly copyLabel: string;
  },
  signal: AbortSignal,
): ShownOnce {
  const element = createElement("div", {});
  const warning = createElement(
    "div",
    { style: "color:var(--text-warning);font-size:13px;margin-bottom:8px;font-weight:600" },
    opts.warning,
  );
  const code = createElement(
    "code",
    {
      style:
        "display:block;background:var(--bg-active);padding:8px 12px;border-radius:6px;" +
        "font-family:monospace;font-size:12px;white-space:pre-wrap;margin-bottom:8px;" +
        "color:var(--text-primary);user-select:all",
      "data-testid": opts.codeTestId,
    },
    opts.text,
  );
  const copyBtn = createElement(
    "button",
    { class: "ac-btn", style: "margin-bottom:12px", "data-testid": opts.copyTestId },
    opts.copyLabel,
  );
  // The copy result is announced once, without moving focus (B9-23): the
  // button's own label change is a repaint a screen reader may miss on a
  // control that is still the focus. The region holds no secret.
  const copyStatus = createElement("div", { class: "sr-only", role: "status" });
  let copyResetTimer: ReturnType<typeof setTimeout> | null = null;
  copyBtn.addEventListener(
    "click",
    () => {
      const restore = (label: string): void => {
        setText(copyBtn, label);
        setText(copyStatus, label);
        if (copyResetTimer !== null) clearTimeout(copyResetTimer);
        copyResetTimer = setTimeout(() => {
          setText(copyBtn, opts.copyLabel);
          setText(copyStatus, "");
          copyResetTimer = null;
        }, 1500);
      };
      // Read the node, not a captured copy: after clear() there is nothing
      // left to copy, and no closure keeps the secret alive.
      const text = code.textContent ?? "";
      if (text === "") return;
      void navigator.clipboard
        .writeText(text)
        .then(() => restore(t("recovery.copied")))
        .catch(() => restore(t("recovery.copyFailed")));
    },
    { signal },
  );
  appendChildren(element, warning, code, copyBtn, copyStatus);

  const clear = (): void => {
    code.textContent = "";
    element.replaceChildren();
    if (copyResetTimer !== null) clearTimeout(copyResetTimer);
  };
  signal.addEventListener("abort", clear, { once: true });
  return { element, clear };
}

/**
 * A button that opens a password prompt; `onSubmit` runs with the password,
 * which is cleared from the input as soon as it is read.
 */
function buildPasswordConfirm(
  opts: {
    readonly triggerLabel: string;
    readonly submitLabel: string;
    readonly busyLabel: string;
    readonly testIdPrefix: string;
    readonly onSubmit: (password: string) => Promise<void>;
  },
  signal: AbortSignal,
): { readonly element: HTMLDivElement; setTriggerLabel(label: string): void } {
  const element = createElement("div", {});
  const trigger = createElement(
    "button",
    { class: "ac-btn", "data-testid": `${opts.testIdPrefix}-btn` },
    opts.triggerLabel,
  );
  const area = createElement("div", { style: "display:none" });
  const pwInput = createElement("input", {
    class: "form-input",
    type: "password",
    placeholder: t("totp.passwordPlaceholder"),
    style: "margin-bottom:12px",
    "data-testid": `${opts.testIdPrefix}-password`,
  });
  const errorEl = createElement("div", {
    style: ERROR,
    role: "alert",
    "data-testid": `${opts.testIdPrefix}-error`,
  });
  const btnRow = createElement("div", { style: "display:flex;gap:8px" });
  const submitBtn = createElement(
    "button",
    { class: "ac-btn", "data-testid": `${opts.testIdPrefix}-submit` },
    opts.submitLabel,
  );
  const cancelBtn = createElement(
    "button",
    { class: "ac-btn", style: "background:var(--bg-active)" },
    t("recovery.cancel"),
  );
  appendChildren(btnRow, submitBtn, cancelBtn);
  appendChildren(area, pwInput, errorEl, btnRow);

  const close = (hadFocus = area.contains(document.activeElement)): void => {
    // The submit button that was focused is inside `area`, which is about to
    // hide; focus the trigger that replaces it so focus never falls to <body>
    // (B9-23). Only reclaim focus if it was inside this area.
    area.style.display = "none";
    trigger.style.display = "";
    pwInput.value = "";
    setText(errorEl, "");
    if (hadFocus) trigger.focus();
  };
  trigger.addEventListener(
    "click",
    () => {
      trigger.style.display = "none";
      area.style.display = "block";
      pwInput.focus();
    },
    { signal },
  );
  cancelBtn.addEventListener("click", () => close(), { signal });
  submitBtn.addEventListener(
    "click",
    () => {
      const pw = pwInput.value;
      if (pw.length === 0) {
        setText(errorEl, t("password.required"));
        return;
      }
      pwInput.value = "";
      setText(errorEl, "");
      const hadFocus = area.contains(document.activeElement);
      submitBtn.disabled = true;
      setText(submitBtn, opts.busyLabel);
      void opts
        .onSubmit(pw)
        .then(() => close(hadFocus))
        .catch((err: unknown) => {
          setText(errorEl, errorText(err, t("recovery.requestFailed")));
        })
        .finally(() => {
          submitBtn.disabled = false;
          setText(submitBtn, opts.submitLabel);
        });
    },
    { signal },
  );
  appendChildren(element, trigger, area);
  return { element, setTriggerLabel: (label) => setText(trigger, label) };
}

/**
 * A reveal slot plus its "Done" button. `show()` replaces any
 * previous reveal; the Done button and the signal both wipe it.
 */
function buildRevealSlot(signal: AbortSignal): {
  readonly element: HTMLDivElement;
  show(reveal: ShownOnce): void;
} {
  const element = createElement("div", {});
  let current: ShownOnce | null = null;
  const done = createElement(
    "button",
    { class: "ac-btn", "data-testid": "shown-once-done" },
    t("recovery.done"),
  );
  done.style.display = "none";
  const dismiss = (): void => {
    current?.clear();
    current = null;
    element.replaceChildren();
    done.style.display = "none";
  };
  done.addEventListener("click", dismiss, { signal });
  signal.addEventListener("abort", dismiss, { once: true });
  const wrapper = createElement("div", {});
  appendChildren(wrapper, element, done);
  return {
    element: wrapper,
    show(reveal) {
      dismiss();
      current = reveal;
      element.appendChild(reveal.element);
      done.style.display = "";
    },
  };
}

// ---------------------------------------------------------------------------
// Emergency recovery codes (2FA enabled)
// ---------------------------------------------------------------------------

/** Regenerate the emergency recovery codes: password-confirmed, shown once. */
export function buildRegenerateCodes(
  options: SettingsOverlayOptions,
  signal: AbortSignal,
): HTMLDivElement {
  const wrapper = createElement("div", { style: "margin-top:16px" });
  const description = createElement("div", { style: MUTED }, t("recovery.codesDescription"));
  const slot = buildRevealSlot(signal);
  const confirm = buildPasswordConfirm(
    {
      triggerLabel: t("recovery.regenerate"),
      submitLabel: t("recovery.regenerateSubmit"),
      busyLabel: t("recovery.regenerating"),
      testIdPrefix: "totp-regenerate",
      onSubmit: async (password) => {
        const codes = await options.onRegenerateRecoveryCodes(password);
        if (signal.aborted) return;
        slot.show(
          buildShownOnce(
            {
              warning: t("recovery.codesWarning"),
              text: codes.join("\n"),
              codeTestId: "totp-regenerated-codes",
              copyTestId: "totp-copy-regenerated-codes",
              copyLabel: t("recovery.copyCodes"),
            },
            signal,
          ),
        );
      },
    },
    signal,
  );
  appendChildren(wrapper, description, confirm.element, slot.element);
  return wrapper;
}

// ---------------------------------------------------------------------------
// Recovery kit
// ---------------------------------------------------------------------------

function statusLabel(status: RecoveryKitStatus | null): {
  readonly text: string;
  readonly enrolled: boolean;
} {
  if (status === null) return { text: t("recovery.checking"), enrolled: false };
  if (status.enrolled) return { text: t("recovery.enrolled"), enrolled: true };
  if (status.used_at !== null && status.used_at !== undefined) {
    return { text: t("recovery.used"), enrolled: false };
  }
  return { text: t("recovery.notSetUp"), enrolled: false };
}

export function buildRecoveryKitSection(
  options: SettingsOverlayOptions,
  signal: AbortSignal,
): HTMLDivElement {
  const wrapper = createElement("div", { "data-testid": "recovery-kit-section" });
  const separator = createElement("div", { class: "settings-separator" });
  const headerRow = createElement("div", {
    style: "display:flex;align-items:center;gap:8px;margin-bottom:4px",
  });
  const header = createElement(
    "div",
    { class: "settings-section-title", style: "margin-bottom:0" },
    t("recovery.kitTitle"),
  );
  const badge = createElement("span", {
    "data-testid": "recovery-kit-status",
    style:
      "font-size:12px;padding:2px 8px;border-radius:4px;font-weight:600;" +
      "background:var(--bg-tertiary);color:var(--text-muted)",
  });
  appendChildren(headerRow, header, badge);

  const description = createElement("div", { style: MUTED }, t("recovery.kitDescription"));
  const statusError = createElement("div", { style: ERROR, role: "alert" });
  const slot = buildRevealSlot(signal);

  function paint(status: RecoveryKitStatus | null): void {
    const { text, enrolled } = statusLabel(status);
    // Qualified status tokens rather than white on the --green fill (3.2:1,
    // below Q1's 4.5:1); the badge's word carries the state (B9-23).
    setText(badge, text);
    badge.style.background = "var(--bg-tertiary)";
    badge.style.color = enrolled ? "var(--text-positive)" : "var(--text-muted)";
    confirm.setTriggerLabel(enrolled ? t("recovery.replaceKit") : t("recovery.createKit"));
  }

  function refresh(): void {
    void options
      .onGetRecoveryKitStatus()
      .then((status) => {
        if (signal.aborted) return;
        setText(statusError, "");
        paint(status);
      })
      .catch(() => {
        if (signal.aborted) return;
        setText(statusError, t("recovery.kitStatusFailed"));
      });
  }

  const confirm = buildPasswordConfirm(
    {
      triggerLabel: t("recovery.createKit"),
      submitLabel: t("recovery.create"),
      busyLabel: t("recovery.creating"),
      testIdPrefix: "recovery-kit",
      onSubmit: async (password) => {
        const issue = await options.onEnrolRecoveryKit(password);
        if (signal.aborted) return;
        refresh();
        if (issue.kit_secret === undefined || issue.kit_secret === "") {
          throw new Error(t("recovery.secretMissing"));
        }
        slot.show(
          buildShownOnce(
            {
              warning: t("recovery.secretWarning"),
              text: issue.kit_secret,
              codeTestId: "recovery-kit-secret",
              copyTestId: "recovery-kit-copy",
              copyLabel: t("recovery.copySecret"),
            },
            signal,
          ),
        );
      },
    },
    signal,
  );

  paint(null);
  refresh();
  appendChildren(
    wrapper,
    separator,
    headerRow,
    description,
    statusError,
    confirm.element,
    slot.element,
  );
  return wrapper;
}
