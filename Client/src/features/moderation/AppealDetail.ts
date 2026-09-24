/**
 * One appeal in the Moderation Center (B9-17): the appealed action, the
 * appellant's statement, and the take/decide controls or the recorded result.
 *
 * Only what the server returned is shown, and nothing from the report queue:
 * no evidence, no internal notes. A linked report is offered only when the
 * server returned its id for this reader, and opens in Reports, where its own
 * read is authorized again.
 *
 * Controls mirror B9-12: take the appeal first, and only its holder decides
 * it; another moderator's appeal is never taken over (assignment is never
 * forced). The moderator who issued the action is offered the same controls
 * with the server's rule stated: it refuses them (SELF_REVIEW) while another
 * moderator can review, and records the sole-moderator exception itself.
 *
 * The decision note is the appellant's to read, so it is labelled as such
 * and kept apart from report notes. A decided appeal shows the outcome the
 * server recorded, and what an overturn does for that kind of action.
 *
 * This module only renders and reports intent; AppealQueue.ts sends the
 * write, guards against a second submit and re-reads the result.
 */

import type { AppealDecision } from "@lib/api";
import { appendChildren, createElement, setText } from "@lib/dom";
import { moderationText as t } from "../../i18n/moderation";
import type { AppealDetail } from "./api";
import { dateText, memberName } from "./Evidence";
import { muted } from "./History";

export type AppealWrite =
  | { readonly kind: "assign" }
  | { readonly kind: "decide"; readonly outcome: AppealDecision; readonly note: string };

export interface AppealDraft {
  note: string;
  outcome: AppealDecision | null;
}

export interface AppealDetailOptions {
  readonly detail: AppealDetail;
  /** The signed-in account's id. */
  readonly me: number;
  /** The unsaved decision for this appeal, kept while the view is live. */
  readonly draft: AppealDraft;
  /** Whether the write was accepted; one runs at a time. */
  readonly onWrite: (write: AppealWrite) => boolean;
  /** Open the linked report in Reports. */
  readonly onOpenReport: (id: string) => void;
  readonly signal: AbortSignal;
}

export interface AppealDetailView {
  readonly element: HTMLElement;
  /** Takes focus when the appeal opens. */
  readonly heading: HTMLElement;
  /** Whether this render offers the decision form (so a draft still has a home). */
  readonly takesInput: boolean;
}

const KINDS = {
  warning: "kind.warning",
  timeout: "kind.timeout",
  removal: "kind.removal",
  ban: "kind.ban",
} as const;

const STATES = {
  open: "appeal.state.open",
  assigned: "appeal.state.assigned",
  upheld: "appeal.state.upheld",
  overturned: "appeal.state.overturned",
  withdrawn: "appeal.state.withdrawn",
} as const;

/** What an overturn does, per kind: before (the form) and after (the result). */
const EFFECTS = {
  timeout: ["appeal.effect.timeout", "appeal.result.timeout"],
  ban: ["appeal.effect.ban", "appeal.result.ban"],
  warning: ["appeal.effect.warning", "appeal.result.warning"],
  removal: ["appeal.effect.removal", "appeal.result.removal"],
} as const;

const OUTCOMES = {
  upheld: "appeal.outcome.upheld",
  overturned: "appeal.outcome.overturned",
} as const satisfies Record<AppealDecision, string>;

/** The server's own bound (Server/service/appeal.go appealNoteMaxRunes); UTF-16 units never exceed runes. */
const NOTE_MAX = 2000;

export function kindText(kind: string): string {
  return t(Object.hasOwn(KINDS, kind) ? KINDS[kind as keyof typeof KINDS] : "kind.other");
}

export function appealStateText(state: string): string {
  return t(
    Object.hasOwn(STATES, state) ? STATES[state as keyof typeof STATES] : "appeal.state.unknown",
  );
}

function effect(kind: string, when: 0 | 1): string | null {
  return Object.hasOwn(EFFECTS, kind) ? t(EFFECTS[kind as keyof typeof EFFECTS][when]) : null;
}

/** A member by id: "You", a deleted account (0) or their current name. */
export function personText(id: number, me: number): string {
  if (id === 0) return t("name.erased");
  return id === me ? t("name.you") : memberName(id);
}

/** Label and value pairs, as a definition list. */
function facts(rows: readonly (readonly [string, string])[]): HTMLDListElement {
  const dl = createElement("dl", { class: "mod-report-facts" });
  for (const [label, value] of rows) {
    appendChildren(dl, createElement("dt", {}, label), createElement("dd", {}, value));
  }
  return dl;
}

let appealSeq = 0;

export function buildAppealDetail(o: AppealDetailOptions): AppealDetailView {
  const { detail, me, signal } = o;
  const seq = ++appealSeq;
  const element = createElement("section", {
    class: "mod-report",
    "aria-labelledby": `mod-appeal-${seq}`,
    "data-testid": "mod-appeal",
  });
  const heading = createElement(
    "h3",
    { id: `mod-appeal-${seq}`, tabindex: "-1" },
    t("appeal.title", { kind: kindText(detail.action.kind) }),
  );

  const decided = detail.state === "upheld" || detail.state === "overturned";
  appendChildren(
    element,
    heading,
    facts([
      [t("appeal.fact.appellant"), personText(detail.appellantId, me)],
      [t("fact.state"), appealStateText(detail.state)],
      [
        t("fact.assignee"),
        detail.assigneeId === 0 ? t("fact.unassigned") : personText(detail.assigneeId, me),
      ],
      [t("fact.filed"), dateText(detail.createdAt)],
      ...(decided
        ? ([
            [t("appeal.fact.decidedBy"), personText(detail.decidedBy, me)],
            [t("appeal.fact.decided"), dateText(detail.decidedAt)],
          ] as const)
        : []),
    ]),
  );

  const a = detail.action;
  element.appendChild(createElement("h4", {}, t("appeal.action.title")));
  element.appendChild(
    facts([
      [t("appeal.action.by"), personText(a.actorId, me)],
      [t("appeal.action.at"), dateText(a.createdAt)],
      [t("appeal.action.reason"), a.reason === "" ? t("appeal.action.noReason") : a.reason],
      ...(a.expiresAt !== null && a.liftedAt === null
        ? ([[t("appeal.action.until"), dateText(a.expiresAt)]] as const)
        : []),
      ...(a.liftedAt !== null
        ? ([[t("appeal.action.lifted"), dateText(a.liftedAt)]] as const)
        : []),
      ...(a.acknowledgedAt !== null
        ? ([[t("appeal.action.acknowledged"), dateText(a.acknowledgedAt)]] as const)
        : []),
    ]),
  );

  element.appendChild(createElement("h4", {}, t("appeal.statement.title")));
  element.appendChild(
    detail.body === ""
      ? muted(t("appeal.statement.none"))
      : createElement("p", { class: "mod-report-note" }, detail.body),
  );

  if (detail.reportId !== null) {
    const reportId = detail.reportId;
    const open = createElement(
      "button",
      { type: "button", class: "btn-modal-save", "data-focus": "report" },
      t("appeal.report.open"),
    );
    open.addEventListener("click", () => o.onOpenReport(reportId), { signal });
    appendChildren(
      element,
      createElement("h4", {}, t("appeal.report.title")),
      muted(t("appeal.report.hint")),
      open,
    );
  }

  const work = createElement("section", {
    class: "mod-work",
    "aria-labelledby": `mod-appeal-work-${seq}`,
    "data-testid": "mod-appeal-work",
  });
  work.appendChild(createElement("h4", { id: `mod-appeal-work-${seq}` }, t("appeal.work.title")));
  element.appendChild(work);
  const done = (takesInput: boolean): AppealDetailView => ({ element, heading, takesInput });

  if (decided) {
    const outcome = detail.state === "upheld" ? "appeal.result.upheld" : "appeal.result.overturned";
    work.appendChild(createElement("p", { "data-testid": "mod-appeal-result" }, t(outcome)));
    const after = detail.state === "overturned" ? effect(a.kind, 1) : null;
    if (after !== null) work.appendChild(muted(after));
    appendChildren(
      work,
      createElement("h4", {}, t("appeal.result.note")),
      detail.decisionNote === ""
        ? muted(t("appeal.result.noNote"))
        : createElement("p", { class: "mod-report-note" }, detail.decisionNote),
      muted(t("appeal.result.appellant")),
    );
    return done(false);
  }
  if (detail.state === "withdrawn") {
    work.appendChild(muted(t("appeal.result.withdrawn")));
    return done(false);
  }
  if (detail.state !== "open" && detail.state !== "assigned") {
    work.appendChild(muted(t("appeal.state.unknown")));
    return done(false);
  }

  const buttons: HTMLButtonElement[] = [];
  /** AppealQueue.ts lets one write run at a time; the next render comes from the fresh read. */
  const send = (write: AppealWrite): void => {
    if (!o.onWrite(write)) return;
    for (const b of buttons) b.setAttribute("aria-disabled", "true");
  };
  const button = (label: string, key: string, type: "button" | "submit"): HTMLButtonElement => {
    const b = createElement("button", { type, class: "btn-modal-save", "data-focus": key }, label);
    buttons.push(b);
    return b;
  };
  if (a.actorId !== 0 && a.actorId === me) work.appendChild(muted(t("appeal.work.ownAction")));

  if (detail.assigneeId === 0) {
    const take = button(t("appeal.work.assign"), "assign", "button");
    take.addEventListener("click", () => send({ kind: "assign" }), { signal });
    appendChildren(work, muted(t("appeal.work.unassigned")), take);
    return done(false);
  }
  if (detail.assigneeId !== me) {
    work.appendChild(muted(t("appeal.work.other")));
    return done(false);
  }
  work.appendChild(muted(t("appeal.work.mine")));

  // Decide: nothing is preselected.
  const form = createElement("form", { class: "mod-work-form", novalidate: "" });
  const fieldset = createElement("fieldset", { class: "mod-work-outcomes" });
  fieldset.appendChild(createElement("legend", {}, t("appeal.work.outcomeLabel")));
  const radios: HTMLInputElement[] = [];
  for (const [outcome, labelKey] of Object.entries(OUTCOMES)) {
    const id = `mod-appeal-${seq}-${outcome}`;
    const radio = createElement("input", {
      type: "radio",
      id,
      name: `mod-appeal-outcome-${seq}`,
      value: outcome,
      "data-focus": `outcome-${outcome}`,
    });
    radio.checked = outcome === o.draft.outcome;
    radios.push(radio);
    const label = createElement("label", { for: id, class: "mod-work-outcome" });
    appendChildren(label, radio, createElement("span", {}, t(labelKey)));
    fieldset.appendChild(label);
  }
  const before = effect(a.kind, 0);
  const effectHint = createElement("p", {
    id: `mod-appeal-${seq}-effect`,
    class: "mod-evidence-status",
  });
  setText(effectHint, before ?? "");
  const outcomeError = createElement("p", {
    id: `mod-appeal-${seq}-outcome-error`,
    class: "form-error",
    role: "alert",
  });
  fieldset.setAttribute("aria-describedby", `${effectHint.id} ${outcomeError.id}`);

  const noteId = `mod-appeal-${seq}-note`;
  const noteHint = createElement("p", { id: `${noteId}-hint`, class: "mod-evidence-status" });
  setText(noteHint, t("appeal.work.noteHint"));
  const note = createElement("textarea", {
    id: noteId,
    class: "form-input",
    rows: "3",
    maxlength: String(NOTE_MAX),
    "aria-describedby": `${noteId}-hint`,
    "data-focus": "note",
    "data-testid": "mod-appeal-note",
  });
  note.value = o.draft.note;
  note.addEventListener(
    "input",
    () => {
      o.draft.note = note.value;
    },
    { signal },
  );
  for (const r of radios) {
    r.addEventListener(
      "change",
      () => {
        setText(outcomeError, "");
        o.draft.outcome = r.value as AppealDecision;
      },
      { signal },
    );
  }
  const decideHint = createElement("p", {
    id: `mod-appeal-${seq}-final`,
    class: "mod-evidence-status",
  });
  setText(decideHint, t("appeal.work.decideHint"));
  const decide = button(t("appeal.work.decide"), "decide", "submit");
  decide.setAttribute("aria-describedby", decideHint.id);
  form.addEventListener(
    "submit",
    (e) => {
      e.preventDefault();
      const chosen = radios.find((r) => r.checked);
      if (chosen === undefined) {
        setText(outcomeError, t("appeal.work.outcomeEmpty"));
        radios[0]?.focus();
        return;
      }
      // The server refuses control characters, line breaks included.
      // eslint-disable-next-line no-control-regex -- matching control characters is the point
      const text = note.value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
      send({ kind: "decide", outcome: chosen.value as AppealDecision, note: text });
    },
    { signal },
  );
  appendChildren(
    form,
    fieldset,
    effectHint,
    outcomeError,
    createElement("label", { for: noteId }, t("appeal.work.noteLabel")),
    noteHint,
    note,
    decideHint,
    decide,
  );
  work.appendChild(form);
  return done(true);
}
