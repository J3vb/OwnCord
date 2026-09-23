/**
 * The local report form (B9-10, BPR-070): report a message, one of its
 * attachments, or a user to this server's moderators.
 *
 * The target is the caller's actual local identifier; the server derives the
 * subject from it and authorizes visibility, duplicates and the rate limit
 * (Server/service/report.go). Nothing here guesses target metadata, uploads a
 * screenshot, or sends anywhere but this server's POST /api/v1/reports.
 *
 * Cancel, Escape, the backdrop, or the owner going away (channel switch,
 * sign-out) closes the dialog and aborts a pending send; a result that lands
 * after that is dropped. Closing returns focus to the opener (createModal).
 */

import { ApiClientError } from "@lib/api";
import type { ApiClient, ReportReason, ReportTargetType } from "@lib/api";
import { Disposable } from "@lib/disposable";
import { appendChildren, createElement, setText } from "@lib/dom";
import { createIcon } from "@lib/icons";
import { createModal, type ModalInstance } from "@lib/modalFactory";
import { showToast } from "@lib/toast";
import { reportsText as t } from "../../i18n/reports";

/** The server's reason codes, in the order the form lists them. */
export const REPORT_REASONS: readonly ReportReason[] = [
  "spam",
  "harassment",
  "nsfw_unlabelled",
  "illegal",
  "other",
];

/** The server's bound on `detail`, in code points (maxDetailRunes). */
export const MAX_REPORT_DETAIL = 2000;

export interface ReportTarget {
  readonly type: ReportTargetType;
  /** The local identifier the server resolves: message id, upload id or user id. */
  readonly id: string;
  /** How the target choice names it; unused when it is the only target. */
  readonly label: string;
}

export interface ReportDialogOptions {
  readonly api: Pick<ApiClient, "fileReport">;
  readonly title: string;
  /** The first is preselected; more than one renders a choice between them. */
  readonly targets: readonly [ReportTarget, ...ReportTarget[]];
  /** The owner's lifetime: aborting it closes the dialog and cancels a send. */
  readonly signal: AbortSignal;
  /** Focus target on close when the opener has gone (its row re-rendered). */
  readonly fallbackFocus?: () => HTMLElement | null;
}

type DetailCheck =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly error: "error.detailTooLong" | "error.detailControl" };

/**
 * The detail the server accepts, or why not. The server refuses every C0
 * control character and DEL, so line breaks and tabs from the textarea become
 * spaces; anything else is the user's to remove.
 */
export function checkReportDetail(raw: string): DetailCheck {
  const value = raw.replace(/[\r\n\t]+/g, " ").trim();
  // eslint-disable-next-line no-control-regex -- mirrors the server's hasControlChar
  if (/[\u0000-\u001f\u007f]/.test(value)) return { ok: false, error: "error.detailControl" };
  if ([...value].length > MAX_REPORT_DETAIL) return { ok: false, error: "error.detailTooLong" };
  return { ok: true, value };
}

/** Catalog text for a refused or failed send. Never echoes the server's message. */
export function reportFailureText(err: unknown): string {
  if (err instanceof ApiClientError) {
    switch (err.code) {
      case "DUPLICATE_REPORT":
        return t("error.duplicate");
      case "RATE_LIMITED":
        return t("error.rateLimited");
      case "NOT_FOUND":
        return t("error.notFound");
      case "INVALID_INPUT":
        return t("error.invalid");
    }
  }
  return t("error.failed");
}

let dialogSeq = 0;

function radioOption(name: string, value: string, label: string, checked: boolean) {
  const row = createElement("label", { class: "report-option" });
  const input = createElement("input", { type: "radio", name, value });
  input.checked = checked;
  appendChildren(row, input, createElement("span", {}, label));
  return { row, input };
}

function markInvalid(inputs: readonly HTMLElement[], on: boolean): void {
  for (const input of inputs) {
    if (on) input.setAttribute("aria-invalid", "true");
    else input.removeAttribute("aria-invalid");
  }
}

export function openReportDialog(options: ReportDialogOptions): ModalInstance {
  const { api, title, targets, signal } = options;
  const id = `report-${++dialogSeq}`;
  const sending = new Disposable();
  let pending = false;

  const heading = createElement("h3", { id: `${id}-title` }, title);
  const closeBtn = createElement("button", {
    type: "button",
    class: "modal-close",
    "aria-label": t("dialog.close"),
  });
  closeBtn.appendChild(createIcon("x", 14));
  const header = createElement("div", { class: "modal-header" });
  appendChildren(header, heading, closeBtn);

  const body = createElement("div", { class: "modal-body" });
  body.appendChild(createElement("p", { class: "report-note" }, t("dialog.privacy")));

  const targetInputs: HTMLInputElement[] = [];
  if (targets.length > 1) {
    const set = createElement("fieldset", { class: "report-choice" });
    set.appendChild(createElement("legend", { class: "form-label" }, t("dialog.target")));
    targets.forEach((target, i) => {
      const { row, input } = radioOption(`${id}-target`, String(i), target.label, i === 0);
      targetInputs.push(input);
      set.appendChild(row);
    });
    body.appendChild(set);
  }

  const reasonErrId = `${id}-reason-error`;
  const reasonSet = createElement("fieldset", { class: "report-choice" });
  reasonSet.appendChild(createElement("legend", { class: "form-label" }, t("dialog.reason")));
  const reasonInputs = REPORT_REASONS.map((reason) => {
    // i18n-exempt: a catalog key built from a server code, not copy
    const { row, input } = radioOption(`${id}-reason`, reason, t(`reason.${reason}`), false);
    input.setAttribute("aria-describedby", reasonErrId);
    reasonSet.appendChild(row);
    return input;
  });
  const reasonError = createElement("div", { class: "form-error", id: reasonErrId, role: "alert" });
  reasonSet.appendChild(reasonError);
  body.appendChild(reasonSet);

  const detailId = `${id}-detail`;
  const detailGroup = createElement("div", { class: "form-group" });
  const detailLabel = createElement("label", { class: "form-label", for: detailId });
  setText(detailLabel, t("dialog.detail"));
  const detail = createElement("textarea", {
    class: "form-input report-detail",
    id: detailId,
    rows: "3",
    "aria-describedby": `${detailId}-hint ${detailId}-error`,
  });
  const detailHint = createElement("div", { class: "report-note", id: `${detailId}-hint` });
  setText(detailHint, t("dialog.detailHint", { max: MAX_REPORT_DETAIL }));
  const detailError = createElement("div", {
    class: "form-error",
    id: `${detailId}-error`,
    role: "alert",
  });
  appendChildren(detailGroup, detailLabel, detail, detailHint, detailError);
  body.appendChild(detailGroup);

  const status = createElement("div", { class: "form-status", role: "status" });
  const failure = createElement("div", { class: "form-error", role: "alert" });
  appendChildren(body, status, failure);

  const cancelBtn = createElement("button", { type: "button", class: "btn-modal-cancel" });
  setText(cancelBtn, t("dialog.cancel"));
  const submitBtn = createElement("button", { type: "submit", class: "btn-modal-save" });
  setText(submitBtn, t("dialog.submit"));
  const footer = createElement("div", { class: "modal-footer" });
  appendChildren(footer, cancelBtn, submitBtn);

  const form = createElement("form", { class: "report-form", novalidate: "" });
  appendChildren(form, body, footer);
  const content = createElement("div");
  appendChildren(content, header, form);

  const modal = createModal({
    content,
    className: "report-dialog",
    ariaLabelledBy: heading.id,
    signal,
    onClose: () => sending.destroy(),
    ...(options.fallbackFocus !== undefined ? { fallbackFocus: options.fallbackFocus } : {}),
  });

  const own = { signal: sending.signal };
  closeBtn.addEventListener("click", () => modal.close(), own);
  cancelBtn.addEventListener("click", () => modal.close(), own);

  function setPending(on: boolean): void {
    pending = on;
    if (on) {
      // aria-disabled, not disabled: disabling the focused button drops focus.
      submitBtn.setAttribute("aria-busy", "true");
      submitBtn.setAttribute("aria-disabled", "true");
    } else {
      submitBtn.removeAttribute("aria-busy");
      submitBtn.removeAttribute("aria-disabled");
    }
    setText(status, on ? t("dialog.sending") : "");
  }

  async function submit(): Promise<void> {
    if (pending) return;
    setText(failure, "");
    const reason = reasonInputs.find((input) => input.checked)?.value as ReportReason | undefined;
    const checked = checkReportDetail(detail.value);
    setText(reasonError, reason === undefined ? t("error.reasonRequired") : "");
    markInvalid(reasonInputs, reason === undefined);
    setText(
      detailError,
      checked.ok
        ? ""
        : checked.error === "error.detailTooLong"
          ? t(checked.error, { max: MAX_REPORT_DETAIL })
          : t(checked.error),
    );
    markInvalid([detail], !checked.ok);
    if (reason === undefined) {
      reasonInputs[0]?.focus();
      return;
    }
    if (!checked.ok) {
      detail.focus();
      return;
    }

    const choice = targetInputs.findIndex((input) => input.checked);
    const target = targets[Math.max(choice, 0)] ?? targets[0];
    setPending(true);
    try {
      await api.fileReport(
        { target_type: target.type, target_id: target.id, reason, detail: checked.value },
        sending.signal,
      );
    } catch (err) {
      if (sending.signal.aborted) return;
      setPending(false);
      setText(failure, reportFailureText(err));
      return;
    }
    if (sending.signal.aborted) return;
    modal.close();
    showToast(t("dialog.sent"), "success");
  }

  form.addEventListener(
    "submit",
    (e) => {
      e.preventDefault();
      void submit();
    },
    own,
  );

  (targetInputs[0] ?? reasonInputs[0])?.focus();
  return modal;
}
