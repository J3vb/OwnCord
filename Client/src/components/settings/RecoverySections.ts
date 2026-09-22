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
import type { RecoveryKitStatus } from "@lib/api";
import type { SettingsOverlayOptions } from "../SettingsOverlay";

const MUTED = "color:var(--text-muted);font-size:13px;margin-bottom:12px";
const ERROR = "color:var(--red);font-size:13px;margin-bottom:8px";

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
    { style: "color:var(--yellow, #faa61a);font-size:13px;margin-bottom:8px;font-weight:600" },
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
  let copyResetTimer: ReturnType<typeof setTimeout> | null = null;
  copyBtn.addEventListener(
    "click",
    () => {
      const restore = (label: string): void => {
        setText(copyBtn, label);
        if (copyResetTimer !== null) clearTimeout(copyResetTimer);
        copyResetTimer = setTimeout(() => {
          setText(copyBtn, opts.copyLabel);
          copyResetTimer = null;
        }, 1500);
      };
      // Read the node, not a captured copy: after clear() there is nothing
      // left to copy, and no closure keeps the secret alive.
      const text = code.textContent ?? "";
      if (text === "") return;
      void navigator.clipboard
        .writeText(text)
        .then(() => restore("Copied!"))
        .catch(() => restore("Copy failed"));
    },
    { signal },
  );
  appendChildren(element, warning, code, copyBtn);

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
    placeholder: "Enter your password",
    style: "margin-bottom:12px",
    "data-testid": `${opts.testIdPrefix}-password`,
  });
  const errorEl = createElement("div", {
    style: ERROR,
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
    "Cancel",
  );
  appendChildren(btnRow, submitBtn, cancelBtn);
  appendChildren(area, pwInput, errorEl, btnRow);

  const close = (): void => {
    area.style.display = "none";
    trigger.style.display = "";
    pwInput.value = "";
    setText(errorEl, "");
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
  cancelBtn.addEventListener("click", close, { signal });
  submitBtn.addEventListener(
    "click",
    () => {
      const pw = pwInput.value;
      if (pw.length === 0) {
        setText(errorEl, "Password is required.");
        return;
      }
      pwInput.value = "";
      setText(errorEl, "");
      submitBtn.disabled = true;
      setText(submitBtn, opts.busyLabel);
      void opts
        .onSubmit(pw)
        .then(close)
        .catch((err: unknown) => {
          setText(errorEl, err instanceof Error ? err.message : "Request failed.");
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
    "Done",
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
  const description = createElement(
    "div",
    { style: MUTED },
    "Emergency recovery codes let you sign in without your authenticator app. " +
      "Generating a new set invalidates the old one.",
  );
  const slot = buildRevealSlot(signal);
  const confirm = buildPasswordConfirm(
    {
      triggerLabel: "Regenerate recovery codes",
      submitLabel: "Regenerate",
      busyLabel: "Regenerating...",
      testIdPrefix: "totp-regenerate",
      onSubmit: async (password) => {
        const codes = await options.onRegenerateRecoveryCodes(password);
        if (signal.aborted) return;
        slot.show(
          buildShownOnce(
            {
              warning: "Save these recovery codes now — you won't see them again:",
              text: codes.join("\n"),
              codeTestId: "totp-regenerated-codes",
              copyTestId: "totp-copy-regenerated-codes",
              copyLabel: "Copy Codes",
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
  if (status === null) return { text: "Checking\u2026", enrolled: false };
  if (status.enrolled) return { text: "Enrolled", enrolled: true };
  if (status.used_at !== null && status.used_at !== undefined) {
    return { text: "Used", enrolled: false };
  }
  return { text: "Not set up", enrolled: false };
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
    "Recovery Kit",
  );
  const badge = createElement("span", {
    "data-testid": "recovery-kit-status",
    style:
      "font-size:12px;padding:2px 8px;border-radius:4px;font-weight:600;" +
      "background:var(--bg-active);color:var(--text-muted)",
  });
  appendChildren(headerRow, header, badge);

  const description = createElement(
    "div",
    { style: MUTED },
    "A recovery kit signs you back in if you lose your password and your two-factor device. " +
      "Keep it offline: anyone with it and your username can take over this account. " +
      "Creating a new kit replaces the old one, and a kit works once.",
  );
  const statusError = createElement("div", { style: ERROR });
  const slot = buildRevealSlot(signal);

  function paint(status: RecoveryKitStatus | null): void {
    const { text, enrolled } = statusLabel(status);
    setText(badge, text);
    badge.style.background = enrolled ? "var(--green, #3ba55d)" : "var(--bg-active)";
    badge.style.color = enrolled ? "#fff" : "var(--text-muted)";
    confirm.setTriggerLabel(enrolled ? "Replace recovery kit" : "Create recovery kit");
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
        setText(statusError, "Could not load the recovery kit status.");
      });
  }

  const confirm = buildPasswordConfirm(
    {
      triggerLabel: "Create recovery kit",
      submitLabel: "Create",
      busyLabel: "Creating...",
      testIdPrefix: "recovery-kit",
      onSubmit: async (password) => {
        const issue = await options.onEnrolRecoveryKit(password);
        if (signal.aborted) return;
        refresh();
        if (issue.kit_secret === undefined || issue.kit_secret === "") {
          throw new Error("The server did not return a recovery kit secret.");
        }
        slot.show(
          buildShownOnce(
            {
              warning:
                "Save this recovery kit secret now — you won't see it again. " +
                "Store it somewhere safe and offline:",
              text: issue.kit_secret,
              codeTestId: "recovery-kit-secret",
              copyTestId: "recovery-kit-copy",
              copyLabel: "Copy Secret",
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
