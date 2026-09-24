/**
 * A report's moderator actions in the Moderation Center (B9-13): warn or time
 * out the reported account with the report linked, and lift a timeout taken
 * with it.
 *
 * Offered like the review (Workflow.ts): warning and timeout only to the
 * moderator holding an open report, never on the reader's own filing. Lifting
 * is offered while this report's timeout is still running, unless another
 * moderator holds the report. The client can't see ranks, so the server's
 * refusal of a member ranked at or above the reader is shown, not predicted.
 *
 * The length is one number with a unit (Q10), checked against the server's
 * bounds before sending; that check is about input, not authority. This module
 * only renders and reports intent: Queue.ts sends the write, shows the server's
 * answer (a timeout's voice half included) and reads the report again.
 */

import { appendChildren, createElement, setText } from "@lib/dom";
import { moderationText as t } from "../../i18n/moderation";
import { activeTimeoutEnd, type ReportDetail } from "./api";
import { dateText } from "./Evidence";
import { muted } from "./History";

/** The length units, with their catalog keys. */
export const UNITS = {
  minutes: { seconds: 60, labelKey: "unit.minutes", lengthKey: "length.minutes" },
  hours: { seconds: 3600, labelKey: "unit.hours", lengthKey: "length.hours" },
  days: { seconds: 86400, labelKey: "unit.days", lengthKey: "length.days" },
} as const;

export type LengthUnit = keyof typeof UNITS;

export type ActionWrite =
  | { readonly kind: "warning"; readonly reason: string }
  | {
      readonly kind: "timeout";
      readonly reason: string;
      readonly amount: number;
      readonly unit: LengthUnit;
    }
  | { readonly kind: "lift"; readonly userId: number };

/** What the reader typed, kept by Queue.ts across re-reads of the same report. */
export interface ActionDraft {
  warn: string;
  reason: string;
  amount: string;
  unit: LengthUnit;
}

export const emptyActionDraft = (): ActionDraft => ({
  warn: "",
  reason: "",
  amount: "",
  unit: "minutes",
});

/** Server/service/moderation.go's timeout bounds: 1 minute to 28 days. */
const MIN_SECONDS = 60;
const MAX_SECONDS = 28 * 86400;
/** Server/service/moderation.go reasonMaxRunes; UTF-16 units never exceed runes. */
const REASON_MAX = 500;

export interface ActionOptions {
  readonly detail: ReportDetail;
  /** The signed-in account's id. */
  readonly me: number;
  readonly draft: ActionDraft;
  /** Whether the write was accepted; one runs at a time. */
  readonly onWrite: (write: ActionWrite) => boolean;
  readonly signal: AbortSignal;
  /** For tests: the time a running timeout is measured against. */
  readonly now?: number;
}

export interface ActionView {
  readonly element: HTMLElement | null;
  /** Whether this render offers the reason fields (so a draft still has a home). */
  readonly takesInput: boolean;
}

/** The whole number of `unit` in `amount`, when it is one within the server's bounds. */
export function lengthSeconds(amount: string, unit: LengthUnit): number | null {
  if (!/^\d+$/.test(amount.trim())) return null;
  const seconds = Number(amount.trim()) * UNITS[unit].seconds;
  return seconds >= MIN_SECONDS && seconds <= MAX_SECONDS ? seconds : null;
}

/** The server refuses control characters in a reason. */
const cleanReason = (raw: string): string => raw.replace(/\p{Cc}+/gu, " ").trim();

const hint = (id: string, text: string): HTMLParagraphElement => {
  const p = createElement("p", { id, class: "mod-evidence-status" });
  setText(p, text);
  return p;
};

let actSeq = 0;

export function buildActionForms(o: ActionOptions): ActionView {
  const { detail, me, draft, signal } = o;
  const open = detail.state === "open" || detail.state === "assigned";
  const holding = open && detail.assigneeId === me;
  const runningUntil = activeTimeoutEnd(detail, o.now ?? Date.now());
  const lifts = runningUntil !== null && (holding || !open);
  if (detail.subjectId <= 0 || detail.reporterId === me || (!holding && !lifts)) {
    return { element: null, takesInput: false };
  }

  const seq = ++actSeq;
  const element = createElement("section", {
    class: "mod-work",
    "aria-labelledby": `mod-act-${seq}`,
    "data-testid": "mod-act",
  });
  element.appendChild(createElement("h4", { id: `mod-act-${seq}` }, t("act.title")));

  const buttons: HTMLButtonElement[] = [];
  const send = (write: ActionWrite): void => {
    if (!o.onWrite(write)) return;
    for (const b of buttons) b.setAttribute("aria-disabled", "true");
  };
  const button = (label: string, key: string, type: "button" | "submit"): HTMLButtonElement => {
    const b = createElement("button", { type, class: "btn-modal-save", "data-focus": key }, label);
    buttons.push(b);
    return b;
  };
  /** A single-line reason; `key` names its draft field. */
  const reasonField = (id: string, key: "warn" | "reason", label: string): HTMLElement[] => {
    const input = createElement("input", {
      id,
      type: "text",
      class: "form-input",
      maxlength: String(REASON_MAX),
      autocomplete: "off",
      "aria-describedby": `${id}-hint`,
      "data-focus": key,
    });
    input.value = draft[key];
    input.addEventListener("input", () => (draft[key] = input.value), { signal });
    return [
      createElement("label", { for: id }, label),
      hint(`${id}-hint`, t("act.reasonHint")),
      input,
    ];
  };

  if (holding) {
    element.appendChild(muted(t("act.hint")));

    const warnForm = createElement("form", { class: "mod-work-form", novalidate: "" });
    appendChildren(
      warnForm,
      ...reasonField(`mod-warn-${seq}`, "warn", t("act.warnLabel")),
      button(t("act.warn"), "warn-submit", "submit"),
    );
    warnForm.addEventListener(
      "submit",
      (e) => {
        e.preventDefault();
        send({ kind: "warning", reason: cleanReason(draft.warn) });
      },
      { signal },
    );

    const timeoutForm = createElement("form", { class: "mod-work-form", novalidate: "" });
    const lengthId = `mod-length-${seq}`;
    const amount = createElement("input", {
      id: lengthId,
      type: "number",
      class: "form-input",
      min: "1",
      step: "1",
      inputmode: "numeric",
      "aria-describedby": `${lengthId}-hint ${lengthId}-error`,
      "data-focus": "amount",
    });
    amount.value = draft.amount;
    const unit = createElement("select", {
      id: `${lengthId}-unit`,
      class: "form-input",
      "data-focus": "unit",
    });
    for (const [value, u] of Object.entries(UNITS)) {
      unit.appendChild(createElement("option", { value }, t(u.labelKey)));
    }
    unit.value = draft.unit;
    const lengthError = createElement("p", {
      id: `${lengthId}-error`,
      class: "form-error",
      role: "alert",
    });
    amount.addEventListener(
      "input",
      () => {
        draft.amount = amount.value;
        setText(lengthError, "");
        amount.removeAttribute("aria-invalid");
      },
      { signal },
    );
    unit.addEventListener("change", () => (draft.unit = unit.value as LengthUnit), { signal });
    timeoutForm.addEventListener(
      "submit",
      (e) => {
        e.preventDefault();
        if (lengthSeconds(amount.value, draft.unit) === null) {
          setText(lengthError, t("act.lengthInvalid"));
          amount.setAttribute("aria-invalid", "true");
          amount.focus();
          return;
        }
        send({
          kind: "timeout",
          reason: cleanReason(draft.reason),
          amount: Number(amount.value.trim()),
          unit: draft.unit,
        });
      },
      { signal },
    );
    appendChildren(
      timeoutForm,
      ...reasonField(`mod-timeout-${seq}`, "reason", t("act.timeoutLabel")),
      createElement("label", { for: lengthId }, t("act.lengthLabel")),
      hint(`${lengthId}-hint`, t("act.timeoutHint")),
      amount,
      createElement("label", { for: unit.id }, t("act.unitLabel")),
      unit,
      lengthError,
      button(t("act.timeout"), "timeout-submit", "submit"),
    );
    appendChildren(element, warnForm, timeoutForm);
  }

  if (lifts) {
    const liftForm = createElement("div", { class: "mod-work-form" });
    const lift = button(t("act.lift"), "lift", "button");
    lift.setAttribute("aria-describedby", `mod-lift-${seq}`);
    lift.addEventListener("click", () => send({ kind: "lift", userId: detail.subjectId }), {
      signal,
    });
    appendChildren(
      liftForm,
      hint(`mod-lift-${seq}`, t("act.running", { date: dateText(runningUntil) })),
      lift,
    );
    element.appendChild(liftForm);
  }

  return { element, takesInput: holding };
}
