/**
 * One report's detail and evidence in the Moderation Center (B9-11).
 *
 * Only what the server returned is shown: the snapshot it captured when the
 * report was sent, never a read of the channel's live history. Every field is
 * set as text, so a link, an image or an embed in the evidence is never
 * loaded. An attachment is a reference (name, type, size): the file is not
 * part of the report and nothing here fetches it or offers it back.
 */

import { formatByteSize } from "@lib/connectionStats";
import { appendChildren, createElement, setText } from "@lib/dom";
import { parseTimestamp } from "@components/message-list/formatting";
import { channelsStore } from "@stores/channels.store";
import { memberDisplayName, membersStore } from "@stores/members.store";
import { formatDate } from "../../i18n/format";
import { moderationText as t } from "../../i18n/moderation";
import { reportsText } from "../../i18n/reports";
import { reasonLabel, reportStateKey, targetLabel } from "../reports/myReports";
import type { EvidenceRow, QueueItem, ReportDetail } from "./api";

export function dateText(raw: string | null): string {
  const date = raw === null || raw === "" ? null : parseTimestamp(raw);
  return date === null || Number.isNaN(date.getTime())
    ? t("date.unavailable")
    : formatDate(date, { dateStyle: "medium", timeStyle: "short" });
}

export function reportTitle(item: Pick<QueueItem, "targetType" | "reason">): string {
  return reportsText("mine.item", {
    target: targetLabel(item.targetType),
    reason: reasonLabel(item.reason),
  });
}

export function stateText(row: { readonly state: string; readonly outcome: string }): string {
  return reportsText(reportStateKey(row));
}

/** A server-supplied name, or a fallback when the account is gone. */
export function nameText(name: string): string {
  return name === "" ? t("name.unknown") : name;
}

export function memberName(id: number): string {
  const member = membersStore.getState().members.get(id);
  return member === undefined ? t("name.unknown") : memberDisplayName(member);
}

function renderRow(row: EvidenceRow): HTMLLIElement {
  const item = createElement("li", { class: "mod-evidence-item" });
  const head = createElement("div", { class: "mod-evidence-head" });
  head.appendChild(
    createElement("span", { class: "mod-evidence-author" }, memberName(row.authorId)),
  );
  if (row.seq === 0) {
    item.classList.add("mod-evidence-reported");
    head.appendChild(
      createElement("span", { class: "mod-evidence-marker" }, t("evidence.reported")),
    );
  }
  const text =
    row.content === ""
      ? createElement("p", { class: "mod-evidence-text mod-evidence-empty" }, t("evidence.noText"))
      : createElement("p", { class: "mod-evidence-text" }, row.content);
  appendChildren(item, head, text);
  if (row.attachments.length > 0) {
    const files = createElement("ul", { class: "mod-evidence-files" });
    for (const a of row.attachments) {
      files.appendChild(
        createElement(
          "li",
          {},
          t("evidence.attachment", {
            name: a.filename,
            type: a.mime === "" ? t("name.unknown") : a.mime,
            size: formatByteSize(a.size, 1024, "KB", 1),
          }),
        ),
      );
    }
    item.appendChild(files);
  }
  return item;
}

export interface ReportDetailView {
  readonly element: HTMLElement;
  /** Takes focus when the detail opens. */
  readonly heading: HTMLElement;
}

let detailSeq = 0;

/**
 * Build the detail for `item`. `mountGate` puts the NSFW consent gate into
 * the slot it is given when the evidence waits on this account's consent.
 */
export function buildReportDetail(
  item: QueueItem,
  detail: ReportDetail,
  mountGate: (slot: HTMLElement, channelId: number, channelName: string) => void,
): ReportDetailView {
  const id = `mod-report-${++detailSeq}`;
  const element = createElement("section", {
    class: "mod-report",
    "aria-labelledby": id,
    "data-testid": "mod-report",
  });
  const heading = createElement("h3", { id, tabindex: "-1" }, reportTitle(item));

  const facts = createElement("dl", { class: "mod-report-facts" });
  const fact = (label: string, value: string): void => {
    appendChildren(facts, createElement("dt", {}, label), createElement("dd", {}, value));
  };
  fact(t("fact.subject"), nameText(item.subjectName));
  fact(t("fact.reporter"), nameText(item.reporterName));
  fact(t("fact.state"), stateText(detail));
  fact(
    t("fact.assignee"),
    detail.assigneeId === 0 ? t("fact.unassigned") : memberName(detail.assigneeId),
  );
  fact(t("fact.filed"), dateText(detail.createdAt));
  if (detail.closedAt !== null) fact(t("fact.closed"), dateText(detail.closedAt));
  appendChildren(element, heading, facts);

  if (detail.detail !== "") {
    appendChildren(
      element,
      createElement("h4", {}, t("detail.reporterNote")),
      createElement("p", { class: "mod-report-note" }, detail.detail),
    );
  }

  element.appendChild(createElement("h4", {}, t("evidence.title")));
  const evidence = detail.evidence;
  if (evidence.kind === "unavailable") {
    element.appendChild(
      createElement("p", { class: "mod-evidence-status" }, t("evidence.unavailable")),
    );
  } else if (evidence.kind === "consent") {
    const slot = createElement("div", { class: "mod-evidence-gate" });
    appendChildren(
      element,
      createElement("p", { class: "mod-evidence-status" }, t("evidence.consent")),
      slot,
    );
    const channelName =
      channelsStore.getState().channels.get(evidence.channelId)?.name ??
      t("evidence.channelFallback");
    mountGate(slot, evidence.channelId, channelName);
  } else if (evidence.rows.length === 0) {
    element.appendChild(createElement("p", { class: "mod-evidence-status" }, t("evidence.none")));
  } else {
    const captured = createElement("p", { class: "mod-evidence-status" });
    setText(captured, t("evidence.captured", { date: dateText(evidence.rows[0]!.capturedAt) }));
    const list = createElement("ol", { class: "mod-evidence" });
    for (const row of evidence.rows) list.appendChild(renderRow(row));
    appendChildren(element, captured, list);
    if (evidence.rows.some((r) => r.attachments.length > 0)) {
      element.appendChild(
        createElement("p", { class: "mod-evidence-status" }, t("evidence.byReference")),
      );
    }
  }
  return { element, heading };
}
