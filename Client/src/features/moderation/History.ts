/**
 * A report's internal notes and immutable history in the Moderation Center
 * (B9-12). Both are read-only: the server records every step and nothing here
 * offers to edit or remove one.
 *
 * Notes are moderator-only text and stay in their own section; the history
 * names who did what and when, and a moderator action's reason is labelled as
 * the text the member was shown. An erased actor, a report closed because its
 * subject was erased (its notes deleted with the account) and notes removed by
 * the retention sweep are shown as facts, not as a failed read. Erasing the
 * subject of an already-closed report also deletes its notes, which the view
 * can't tell apart from retention, so the closed-report line names both.
 */

import { appendChildren, createElement } from "@lib/dom";
import { moderationText as t } from "../../i18n/moderation";
import { reasonLabel } from "../reports/myReports";
import type { HistoryEntry, ReportDetail } from "./api";
import { dateText, memberName } from "./Evidence";

const OUTCOMES = {
  actioned: "outcome.actioned",
  no_action: "outcome.no_action",
  duplicate: "outcome.duplicate",
  subject_erased: "outcome.subject_erased",
} as const;

const KINDS = {
  warning: "kind.warning",
  timeout: "kind.timeout",
  removal: "kind.removal",
  ban: "kind.ban",
} as const;

/** The catalog key for a server code, or `fallback` for a code this client doesn't know. */
function keyFor<M extends Record<string, string>, F extends string>(
  map: M,
  code: string,
  fallback: F,
): M[keyof M] | F {
  return Object.hasOwn(map, code) ? (map[code] as M[keyof M]) : fallback;
}

export function outcomeText(outcome: string): string {
  return t(keyFor(OUTCOMES, outcome, "outcome.unknown"));
}

/** A muted line of explanation. */
export function muted(text: string): HTMLParagraphElement {
  return createElement("p", { class: "mod-evidence-status" }, text);
}

function actorName(id: number, me: number): string {
  if (id === 0) return t("name.erased");
  return id === me ? t("name.you") : memberName(id);
}

function entryText(e: HistoryEntry, me: number): string {
  if (e.kind === "action") {
    const kind = t(keyFor(KINDS, e.action, "kind.other"));
    return t("history.action", { name: actorName(e.actorId, me), kind });
  }
  const name = actorName(e.actorId, me);
  switch (e.action) {
    case "created":
      return t("history.created", { reason: reasonLabel(e.detail) });
    case "assigned":
      return t("history.assigned", { name });
    case "noted":
      return t("history.noted", { name });
    case "closed":
      return t("history.closed", { name, outcome: outcomeText(e.detail) });
  }
  return t("history.other", { name });
}

function renderEntry(e: HistoryEntry, me: number): HTMLLIElement {
  const li = createElement("li", { class: "mod-history-item" });
  appendChildren(
    li,
    createElement("span", { class: "mod-history-what" }, entryText(e, me)),
    createElement("span", { class: "mod-history-when" }, dateText(e.at)),
  );
  if (e.kind === "action") {
    if (e.reason !== "") {
      li.appendChild(
        createElement(
          "p",
          { class: "mod-history-reason" },
          t("history.reason", { reason: e.reason }),
        ),
      );
    }
    if (e.liftedAt !== null) {
      li.appendChild(
        createElement(
          "span",
          { class: "mod-history-when" },
          t("history.lifted", { date: dateText(e.liftedAt) }),
        ),
      );
    }
  }
  return li;
}

function notesSection(detail: ReportDetail, me: number): HTMLElement[] {
  const heading = createElement("h4", {}, t("notes.title"));
  // The server never sends a reporter the notes on their own report.
  if (detail.reporterId === me) return [heading, muted(t("notes.hidden"))];
  if (detail.notes.length === 0) {
    const noted = detail.history.some((e) => e.kind === "event" && e.action === "noted");
    if (!noted || detail.closedAt === null) return [heading, muted(t("notes.none"))];
    return [heading, muted(t(detail.state === "subject_erased" ? "notes.erased" : "notes.pruned"))];
  }
  const list = createElement("ol", { class: "mod-notes" });
  for (const n of detail.notes) {
    const li = createElement("li", { class: "mod-note" });
    appendChildren(
      li,
      createElement(
        "span",
        { class: "mod-history-when" },
        t("notes.by", {
          name: actorName(n.authorId, me),
          date: dateText(n.createdAt),
        }),
      ),
      createElement("p", { class: "mod-note-body" }, n.body),
    );
    list.appendChild(li);
  }
  return [heading, list];
}

/** The notes and history sections, in reading order, for `detail`. */
export function buildHistory(detail: ReportDetail, me: number): HTMLElement[] {
  const history =
    detail.history.length === 0
      ? muted(t("history.none"))
      : createElement("ol", { class: "mod-history", "data-testid": "mod-history" });
  for (const e of detail.history) history.appendChild(renderEntry(e, me));
  return [
    ...notesSection(detail, me),
    createElement("h4", {}, t("history.title")),
    muted(t("history.hint")),
    history,
  ];
}
