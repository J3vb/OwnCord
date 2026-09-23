/**
 * "My reports" in the Settings Safety tab (B9-10, Q2): the caller's own
 * reports from GET /api/v1/reports/mine — kind, reason, where each one stands
 * and when. The summary is all there is: evidence, assignee and notes are not
 * in it, and nothing here reads the moderation queue to fill a gap. A field
 * the server leaves empty or unknown shows as unavailable.
 *
 * Every request is bound to the tab's signal; a result that lands after the
 * tab is closed or switched away is dropped.
 */

import type { ApiClient, OwnReportSummary } from "@lib/api";
import { appendChildren, clearChildren, createElement, setText } from "@lib/dom";
import { parseTimestamp } from "@components/message-list/formatting";
import { formatDate } from "../../i18n/format";
import { reportsText as t } from "../../i18n/reports";

type StateKey =
  | "state.open"
  | "state.assigned"
  | "state.actioned"
  | "state.no_action"
  | "state.duplicate"
  | "state.subject_erased"
  | "state.unknown";

/** Where a report stands, from its state and (once closed) its outcome. */
export function reportStateKey(row: Pick<OwnReportSummary, "state" | "outcome">): StateKey {
  switch (row.state) {
    case "open":
    case "assigned":
    case "subject_erased":
      // i18n-exempt: a catalog key built from a server code, not copy
      return `state.${row.state}`;
    case "resolved":
    case "dismissed":
      switch (row.outcome) {
        case "actioned":
        case "no_action":
        case "duplicate":
        case "subject_erased":
          // i18n-exempt: a catalog key built from a server code, not copy
          return `state.${row.outcome}`;
      }
  }
  return "state.unknown";
}

function targetLabel(type: string): string {
  switch (type) {
    case "message":
    case "user":
    case "attachment":
      // i18n-exempt: a catalog key built from a server code, not copy
      return t(`target.${type}`);
  }
  return type;
}

function reasonLabel(reason: string): string {
  switch (reason) {
    case "spam":
    case "harassment":
    case "nsfw_unlabelled":
    case "illegal":
    case "other":
      // i18n-exempt: a catalog key built from a server code, not copy
      return t(`reason.${reason}`);
  }
  return reason;
}

function dateText(raw: string | null): string {
  const date = raw === null || raw === "" ? null : parseTimestamp(raw);
  return date === null || Number.isNaN(date.getTime())
    ? t("mine.dateUnavailable")
    : formatDate(date, { dateStyle: "medium", timeStyle: "short" });
}

function renderRow(row: OwnReportSummary): HTMLLIElement {
  const item = createElement("li", { class: "my-reports-item" });
  const what = createElement("div", { class: "my-reports-what" });
  setText(
    what,
    t("mine.item", { target: targetLabel(row.target_type), reason: reasonLabel(row.reason) }),
  );
  const state = createElement("div", { class: "my-reports-state" });
  setText(state, t(reportStateKey(row)));
  const when = createElement("div", { class: "my-reports-when" });
  const filed = t("mine.filed", { date: dateText(row.created_at) });
  setText(
    when,
    row.closed_at === null
      ? filed
      : `${filed} · ${t("mine.closed", { date: dateText(row.closed_at) })}`,
  );
  appendChildren(item, what, state, when);
  return item;
}

let sectionSeq = 0;

/** The "My reports" section. Loads on build; the tab rebuilds it on every open. */
export function buildMyReportsSection(
  signal: AbortSignal,
  api: Pick<ApiClient, "getMyReports">,
): HTMLElement {
  const titleId = `my-reports-${++sectionSeq}`;
  const section = createElement("section", { class: "my-reports", "aria-labelledby": titleId });
  const heading = createElement("h2", { id: titleId, tabindex: "-1" }, t("mine.title"));
  const desc = createElement("p", { class: "setting-desc" }, t("mine.desc"));
  // Both live regions exist before their text changes, so each change is read.
  const status = createElement("div", { class: "my-reports-status", role: "status" });
  const failure = createElement("div", { class: "form-error", role: "alert" });
  const retry = createElement("button", { type: "button", class: "btn-modal-save" });
  setText(retry, t("mine.retry"));
  retry.hidden = true;
  const list = createElement("ul", { class: "my-reports-list" });
  appendChildren(section, heading, desc, status, failure, retry, list);

  let loading = false;
  function load(): void {
    if (loading) return;
    loading = true;
    section.setAttribute("aria-busy", "true");
    retry.setAttribute("aria-disabled", "true");
    setText(failure, "");
    setText(status, t("mine.loading"));
    api.getMyReports(signal).then(
      (rows) => {
        if (signal.aborted) return;
        const retryHadFocus = document.activeElement === retry;
        loading = false;
        section.removeAttribute("aria-busy");
        retry.hidden = true;
        clearChildren(list);
        for (const row of rows) list.appendChild(renderRow(row));
        setText(status, rows.length === 0 ? t("mine.empty") : "");
        // The Retry button is gone; keep focus in the section.
        if (retryHadFocus) heading.focus();
      },
      () => {
        if (signal.aborted) return;
        loading = false;
        section.removeAttribute("aria-busy");
        retry.removeAttribute("aria-disabled");
        retry.hidden = false;
        setText(status, "");
        setText(failure, t("mine.error"));
      },
    );
  }
  retry.addEventListener("click", load, { signal });
  load();
  return section;
}
