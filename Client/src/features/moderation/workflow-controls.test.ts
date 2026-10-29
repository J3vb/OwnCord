// B9-12: the review controls built for one report. Each case drives the
// controls through the DOM they render and the intent they report; the queue
// view that sends the write is covered elsewhere.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModerationOutcome } from "@lib/api";
import type { ReportDetail } from "./api";
import { buildWorkflow, type WorkflowOptions, type WorkflowWrite } from "./Workflow";

const ME = 7;
const OTHER = 8;
const REPORTER = 3;

function report(over: Partial<ReportDetail> = {}): ReportDetail {
  return {
    id: "r1",
    reporterId: REPORTER,
    subjectId: 4,
    targetType: "message",
    channelId: null,
    detail: "",
    state: "assigned",
    outcome: "",
    assigneeId: ME,
    createdAt: "2026-09-05 10:00:00",
    closedAt: null,
    evidence: { kind: "unavailable" },
    notes: [],
    history: [],
    ...over,
  };
}

let controller: AbortController;
let writes: WorkflowWrite[];
let drafts: string[];
let outcomes: ModerationOutcome[];

beforeEach(() => {
  controller = new AbortController();
  writes = [];
  drafts = [];
  outcomes = [];
  document.body.replaceChildren();
});

afterEach(() => {
  controller.abort();
  document.body.replaceChildren();
});

function build(over: Partial<ReportDetail> = {}, opts: Partial<WorkflowOptions> = {}) {
  const view = buildWorkflow({
    detail: report(over),
    me: ME,
    draft: "",
    onDraft: (text) => drafts.push(text),
    outcome: null,
    onOutcome: (o) => outcomes.push(o),
    onWrite: (w) => {
      writes.push(w);
      return true;
    },
    signal: controller.signal,
    ...opts,
  });
  document.body.appendChild(view.element);
  return view;
}

const $ = <T extends Element>(root: ParentNode, sel: string): T => {
  const el = root.querySelector<T>(sel);
  if (el === null) throw new Error(`missing ${sel}`);
  return el;
};

function submit(form: HTMLFormElement): Event {
  const e = new Event("submit", { cancelable: true, bubbles: true });
  form.dispatchEvent(e);
  return e;
}

function type(input: HTMLTextAreaElement, text: string): void {
  input.value = text;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

const heading = (el: HTMLElement): HTMLElement =>
  document.getElementById(el.getAttribute("aria-labelledby") ?? "")!;

const forms = (root: HTMLElement): HTMLFormElement[] =>
  Array.from(root.querySelectorAll<HTMLFormElement>("form"));

describe("review controls structure", () => {
  it("labels the section by its own heading and numbers each build apart", () => {
    const first = build();
    const second = build();
    expect(first.element.className).toBe("mod-work");
    expect(first.element.dataset["testid"]).toBe("mod-work");
    expect(heading(first.element).tagName).toBe("H4");
    expect(heading(first.element).textContent).toBe("Review");
    const a = Number(first.element.getAttribute("aria-labelledby")?.split("-").pop());
    const b = Number(second.element.getAttribute("aria-labelledby")?.split("-").pop());
    expect(a).toBeGreaterThanOrEqual(1);
    expect(b).toBe(a + 1);
    expect(heading(second.element)).not.toBe(heading(first.element));
  });

  it("offers no controls on a closed report", () => {
    const view = build({ state: "closed", outcome: "actioned" });
    expect(view.takesNotes).toBe(false);
    expect(view.element.querySelector("button, form")).toBeNull();
    expect(view.element.textContent).toContain("A closed report can't be reopened or changed.");
  });

  it("offers no controls on the reader's own report", () => {
    const view = build({ reporterId: ME, assigneeId: 0 });
    expect(view.takesNotes).toBe(false);
    expect(view.element.querySelector("button, form")).toBeNull();
    expect(view.element.textContent).toContain("You sent this report");
  });

  it("offers no controls while another moderator reviews", () => {
    const view = build({ assigneeId: OTHER });
    expect(view.takesNotes).toBe(false);
    expect(view.element.querySelector("button, form")).toBeNull();
    expect(view.element.textContent).toContain("Another moderator is reviewing");
  });

  it("offers only Take on an unassigned report and reports the intent on click", () => {
    const view = build({ state: "open", assigneeId: 0 });
    expect(view.takesNotes).toBe(false);
    expect(view.element.querySelector("form")).toBeNull();
    const take = $<HTMLButtonElement>(view.element, "button");
    expect(take.textContent).toBe("Take this report");
    expect(take.type).toBe("button");
    expect(take.className).toBe("btn-modal-save");
    expect(take.dataset["focus"]).toBe("assign");
    expect(view.element.textContent).toContain("No one is reviewing this report yet.");
    take.click();
    expect(writes).toEqual([{ kind: "assign" }]);
  });

  it("ignores the Take button once the owning view is gone", () => {
    const view = build({ state: "open", assigneeId: 0 });
    controller.abort();
    $<HTMLButtonElement>(view.element, "button").click();
    expect(writes).toEqual([]);
  });

  it("offers the note and close forms to the reviewing moderator", () => {
    const view = build();
    expect(view.takesNotes).toBe(true);
    expect(view.element.textContent).toContain("You're reviewing this report.");
    const [noteForm, closeForm] = forms(view.element);
    expect(forms(view.element)).toHaveLength(2);
    for (const f of [noteForm!, closeForm!]) {
      expect(f.className).toBe("mod-work-form");
      expect(f.getAttribute("novalidate")).toBe("");
    }
  });
});

describe("internal note form", () => {
  it("wires the label, hint, error and field together", () => {
    const view = build({}, { draft: "keep me" });
    const note = $<HTMLTextAreaElement>(view.element, "textarea");
    expect(note.value).toBe("keep me");
    expect(note.id).toMatch(/^mod-note-\d+$/);
    expect(note.className).toBe("form-input");
    expect(note.rows).toBe(3);
    expect(note.maxLength).toBe(4000);
    expect(note.dataset["focus"]).toBe("note");
    expect(note.dataset["testid"]).toBe("mod-note-input");
    const label = $<HTMLLabelElement>(view.element, "label[for]");
    expect(label.htmlFor).toBe(note.id);
    expect(label.textContent).toBe("Internal note");
    const [hintId, errorId] = (note.getAttribute("aria-describedby") ?? "").split(" ");
    expect(hintId).toBe(`${note.id}-hint`);
    expect(errorId).toBe(`${note.id}-error`);
    const hint = document.getElementById(hintId!)!;
    expect(hint.className).toBe("mod-evidence-status");
    expect(hint.textContent).toContain("Only moderators can read notes");
    const error = document.getElementById(errorId!)!;
    expect(error.className).toBe("form-error");
    expect(error.getAttribute("role")).toBe("alert");
    expect(error.textContent).toBe("");
    const add = $<HTMLButtonElement>($(view.element, "form"), "button");
    expect(add.type).toBe("submit");
    expect(add.className).toBe("btn-modal-save");
    expect(add.dataset["focus"]).toBe("note-submit");
    expect(add.textContent).toBe("Add note");
  });

  it("keeps the typed text as the draft", () => {
    const view = build();
    type($(view.element, "textarea"), "first");
    type($(view.element, "textarea"), "first draft");
    expect(drafts).toEqual(["first", "first draft"]);
  });

  it("refuses an empty note with a focused, announced error until real text is typed", () => {
    const view = build();
    const note = $<HTMLTextAreaElement>(view.element, "textarea");
    const error = document.getElementById(`${note.id}-error`)!;
    const noteForm = forms(view.element)[0]!;
    type(note, "   ");
    const e = submit(noteForm);
    expect(e.defaultPrevented).toBe(true);
    expect(writes).toEqual([]);
    expect(error.textContent).toBe("Write a note first.");
    expect(note.getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(note);

    // Whitespace alone is still empty, so the error stays.
    type(note, "  \n ");
    expect(error.textContent).toBe("Write a note first.");
    expect(note.getAttribute("aria-invalid")).toBe("true");

    type(note, "now there is text");
    expect(error.textContent).toBe("");
    expect(note.hasAttribute("aria-invalid")).toBe(false);
  });

  it("sends the note with line breaks and tabs folded to single spaces", () => {
    const view = build();
    const note = $<HTMLTextAreaElement>(view.element, "textarea");
    const noteForm = forms(view.element)[0]!;
    type(note, "  line one\r\n\r\nline two\tend\vtail\fmore  ");
    const e = submit(noteForm);
    expect(e.defaultPrevented).toBe(true);
    expect(writes).toEqual([{ kind: "note", body: "line one line two end tail more" }]);
    expect(note.hasAttribute("aria-invalid")).toBe(false);
  });

  it("ignores typing and submitting once the owning view is gone", () => {
    const view = build();
    const note = $<HTMLTextAreaElement>(view.element, "textarea");
    const noteForm = forms(view.element)[0]!;
    controller.abort();
    type(note, "late");
    submit(noteForm);
    expect(drafts).toEqual([]);
    expect(writes).toEqual([]);
  });
});

describe("close with an outcome", () => {
  it("lists the three outcomes unselected and tied to their labels", () => {
    const view = build();
    const closeForm = forms(view.element)[1]!;
    const radios = Array.from(closeForm.querySelectorAll<HTMLInputElement>("input[type=radio]"));
    expect(radios.map((r) => r.value)).toEqual(["actioned", "no_action", "duplicate"]);
    expect(radios.every((r) => !r.checked)).toBe(true);
    expect(new Set(radios.map((r) => r.name)).size).toBe(1);
    expect(radios[0]!.name).toMatch(/^mod-outcome-\d+$/);
    radios.forEach((r) => {
      expect(r.dataset["focus"]).toBe(`outcome-${r.value}`);
      expect(r.id).toBe(`${r.name}-${r.value}`);
      const label = $<HTMLLabelElement>(closeForm, `label[for="${r.id}"]`);
      expect(label.className).toBe("mod-work-outcome");
      expect(label.contains(r)).toBe(true);
    });
    expect(Array.from(closeForm.querySelectorAll("label span")).map((s) => s.textContent)).toEqual([
      "Action taken",
      "No action needed",
      "Already reported",
    ]);
    const fieldset = $<HTMLFieldSetElement>(closeForm, "fieldset");
    expect(fieldset.className).toBe("mod-work-outcomes");
    expect($(fieldset, "legend").textContent).toBe("Outcome");
  });

  it("pre-selects the outcome kept with the draft", () => {
    const view = build({}, { outcome: "duplicate" });
    const checked = Array.from(view.element.querySelectorAll<HTMLInputElement>("input:checked"));
    expect(checked.map((r) => r.value)).toEqual(["duplicate"]);
  });

  it("describes the close button and error for assistive technology", () => {
    const view = build();
    const closeForm = forms(view.element)[1]!;
    const fieldset = $<HTMLFieldSetElement>(closeForm, "fieldset");
    const error = document.getElementById(fieldset.getAttribute("aria-describedby")!)!;
    expect(error.id).toMatch(/^mod-close-\d+-error$/);
    expect(error.className).toBe("form-error");
    expect(error.getAttribute("role")).toBe("alert");
    const close = $<HTMLButtonElement>(closeForm, "button");
    expect(close.type).toBe("submit");
    expect(close.className).toBe("btn-modal-save");
    expect(close.dataset["focus"]).toBe("close");
    expect(close.textContent).toBe("Close report");
    const hint = document.getElementById(close.getAttribute("aria-describedby")!)!;
    expect(hint.id).toBe(error.id.replace("-error", "-hint"));
    expect(hint.className).toBe("mod-evidence-status");
    expect(hint.textContent).toContain("can't be reopened");
  });

  it("asks for an outcome, focusing the first one, until one is chosen", () => {
    const view = build();
    const closeForm = forms(view.element)[1]!;
    const radios = Array.from(closeForm.querySelectorAll<HTMLInputElement>("input[type=radio]"));
    const error = $(closeForm, ".form-error");
    const e = submit(closeForm);
    expect(e.defaultPrevented).toBe(true);
    expect(writes).toEqual([]);
    expect(error.textContent).toBe("Choose an outcome first.");
    expect(document.activeElement).toBe(radios[0]);

    radios[1]!.checked = true;
    radios[1]!.dispatchEvent(new Event("change", { bubbles: true }));
    expect(outcomes).toEqual(["no_action"]);
    expect(error.textContent).toBe("");

    submit(closeForm);
    expect(writes).toEqual([{ kind: "close", outcome: "no_action" }]);
  });

  it("ignores a choice and a submit once the owning view is gone", () => {
    const view = build();
    const closeForm = forms(view.element)[1]!;
    const radio = $<HTMLInputElement>(closeForm, "input[type=radio]");
    radio.checked = true;
    controller.abort();
    radio.dispatchEvent(new Event("change", { bubbles: true }));
    const e = submit(closeForm);
    expect(outcomes).toEqual([]);
    expect(writes).toEqual([]);
    expect(e.defaultPrevented).toBe(false);
  });
});

describe("one write at a time", () => {
  it("marks every button busy once the write is accepted", () => {
    const view = build();
    const note = $<HTMLTextAreaElement>(view.element, "textarea");
    type(note, "text");
    submit(forms(view.element)[0]!);
    const buttons = Array.from(view.element.querySelectorAll("button"));
    expect(buttons).toHaveLength(2);
    expect(buttons.map((b) => b.getAttribute("aria-disabled"))).toEqual(["true", "true"]);
  });

  it("leaves the buttons live when the write is refused", () => {
    const refuse = vi.fn(() => false);
    const view = build({}, { onWrite: refuse });
    type($(view.element, "textarea"), "text");
    submit(forms(view.element)[0]!);
    expect(refuse).toHaveBeenCalledOnce();
    const buttons = Array.from(view.element.querySelectorAll("button"));
    expect(buttons.some((b) => b.hasAttribute("aria-disabled"))).toBe(false);
  });
});
