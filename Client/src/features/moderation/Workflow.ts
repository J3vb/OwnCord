/**
 * A report's review controls in the Moderation Center (B9-12): take the
 * report, add an internal note, close it with an outcome.
 *
 * Only what the server would accept from this reader is offered. The reporter
 * of a report gets no controls (the server refuses their writes); a report
 * someone else is reviewing offers none either, so one moderator never
 * overwrites another's review, and taking a report is never forced. A closed
 * report has no controls: there is no reopen and no editing of history.
 *
 * This module only renders and reports intent; Queue.ts sends the write,
 * guards against a second submit and reconciles the result with a fresh read.
 */

import type { ModerationOutcome } from "@lib/api";
import { appendChildren, createElement, setText } from "@lib/dom";
import { moderationText as t } from "../../i18n/moderation";
import type { ReportDetail } from "./api";
import { muted, outcomeText } from "./History";

export type WorkflowWrite =
  | { readonly kind: "assign" }
  | { readonly kind: "note"; readonly body: string }
  | { readonly kind: "close"; readonly outcome: ModerationOutcome };

export interface WorkflowOptions {
  readonly detail: ReportDetail;
  /** The signed-in account's id. */
  readonly me: number;
  /** The unsaved note for this report, kept while the view is live. */
  readonly draft: string;
  readonly onDraft: (text: string) => void;
  /** The outcome chosen for this report, kept with the draft. */
  readonly outcome: ModerationOutcome | null;
  readonly onOutcome: (outcome: ModerationOutcome) => void;
  /** Whether the write was accepted; one runs at a time. */
  readonly onWrite: (write: WorkflowWrite) => boolean;
  readonly signal: AbortSignal;
}

export interface WorkflowView {
  readonly element: HTMLElement;
  /** Whether this render offers the note field (so a draft still has a home). */
  readonly takesNotes: boolean;
}

const OUTCOMES: readonly ModerationOutcome[] = ["actioned", "no_action", "duplicate"];

/** The server's own bound (Server/service/report.go maxNoteRunes); UTF-16 units never exceed runes. */
const NOTE_MAX = 4000;

let workSeq = 0;

export function buildWorkflow(o: WorkflowOptions): WorkflowView {
  const { detail, me, signal } = o;
  const seq = ++workSeq;
  const element = createElement("section", {
    class: "mod-work",
    "aria-labelledby": `mod-work-${seq}`,
    "data-testid": "mod-work",
  });
  element.appendChild(createElement("h4", { id: `mod-work-${seq}` }, t("work.title")));

  const open = detail.state === "open" || detail.state === "assigned";
  if (!open) {
    element.appendChild(muted(t("work.closedHint")));
    return { element, takesNotes: false };
  }
  if (detail.reporterId === me) {
    element.appendChild(muted(t("work.ownReport")));
    return { element, takesNotes: false };
  }

  const buttons: HTMLButtonElement[] = [];
  /** Queue.ts lets one write run at a time; the next render comes from the fresh read. */
  const send = (write: WorkflowWrite): void => {
    if (!o.onWrite(write)) return;
    for (const b of buttons) b.setAttribute("aria-disabled", "true");
  };
  const button = (label: string, key: string, type: "button" | "submit"): HTMLButtonElement => {
    const b = createElement("button", { type, class: "btn-modal-save", "data-focus": key }, label);
    buttons.push(b);
    return b;
  };

  if (detail.assigneeId === 0) {
    const take = button(t("work.assign"), "assign", "button");
    take.addEventListener("click", () => send({ kind: "assign" }), { signal });
    appendChildren(element, muted(t("work.unassigned")), take);
    return { element, takesNotes: false };
  }
  if (detail.assigneeId !== me) {
    element.appendChild(muted(t("work.other")));
    return { element, takesNotes: false };
  }
  element.appendChild(muted(t("work.mine")));

  // Internal note.
  const noteForm = createElement("form", { class: "mod-work-form", novalidate: "" });
  const noteId = `mod-note-${seq}`;
  const noteHint = createElement("p", { id: `${noteId}-hint`, class: "mod-evidence-status" });
  setText(noteHint, t("work.noteHint"));
  const noteError = createElement("p", {
    id: `${noteId}-error`,
    class: "form-error",
    role: "alert",
  });
  const note = createElement("textarea", {
    id: noteId,
    class: "form-input",
    rows: "3",
    maxlength: String(NOTE_MAX),
    "aria-describedby": `${noteId}-hint ${noteId}-error`,
    "data-focus": "note",
    "data-testid": "mod-note-input",
  });
  note.value = o.draft;
  note.addEventListener(
    "input",
    () => {
      o.onDraft(note.value);
      if (note.value.trim() !== "") {
        setText(noteError, "");
        note.removeAttribute("aria-invalid");
      }
    },
    { signal },
  );
  const addNote = button(t("work.addNote"), "note-submit", "submit");
  noteForm.addEventListener(
    "submit",
    (e) => {
      e.preventDefault();
      // The server refuses control characters, line breaks included.
      const body = note.value.replace(/[\t\n\v\f\r]+/g, " ").trim();
      if (body === "") {
        setText(noteError, t("work.noteEmpty"));
        note.setAttribute("aria-invalid", "true");
        note.focus();
        return;
      }
      send({ kind: "note", body });
    },
    { signal },
  );
  appendChildren(
    noteForm,
    createElement("label", { for: noteId }, t("work.noteLabel")),
    noteHint,
    note,
    noteError,
    addNote,
  );

  // Close with an outcome; nothing is preselected.
  const closeForm = createElement("form", { class: "mod-work-form", novalidate: "" });
  const fieldset = createElement("fieldset", { class: "mod-work-outcomes" });
  fieldset.appendChild(createElement("legend", {}, t("work.outcomeLabel")));
  const radios: HTMLInputElement[] = [];
  for (const outcome of OUTCOMES) {
    const id = `mod-outcome-${seq}-${outcome}`;
    const radio = createElement("input", {
      type: "radio",
      id,
      name: `mod-outcome-${seq}`,
      value: outcome,
      "data-focus": `outcome-${outcome}`,
    });
    radio.checked = outcome === o.outcome;
    radios.push(radio);
    const label = createElement("label", { for: id, class: "mod-work-outcome" });
    appendChildren(label, radio, createElement("span", {}, outcomeText(outcome)));
    fieldset.appendChild(label);
  }
  const closeHint = createElement("p", {
    id: `mod-close-${seq}-hint`,
    class: "mod-evidence-status",
  });
  setText(closeHint, t("work.closedHint"));
  const closeError = createElement("p", {
    id: `mod-close-${seq}-error`,
    class: "form-error",
    role: "alert",
  });
  fieldset.setAttribute("aria-describedby", closeError.id);
  const close = button(t("work.close"), "close", "submit");
  close.setAttribute("aria-describedby", closeHint.id);
  for (const r of radios) {
    r.addEventListener(
      "change",
      () => {
        setText(closeError, "");
        o.onOutcome(r.value as ModerationOutcome);
      },
      { signal },
    );
  }
  closeForm.addEventListener(
    "submit",
    (e) => {
      e.preventDefault();
      const chosen = radios.find((r) => r.checked);
      if (chosen === undefined) {
        setText(closeError, t("work.outcomeEmpty"));
        radios[0]?.focus();
        return;
      }
      send({ kind: "close", outcome: chosen.value as ModerationOutcome });
    },
    { signal },
  );
  appendChildren(closeForm, fieldset, closeHint, closeError, close);

  appendChildren(element, noteForm, closeForm);
  return { element, takesNotes: true };
}
