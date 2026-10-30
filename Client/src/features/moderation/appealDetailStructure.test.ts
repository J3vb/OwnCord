// The markup and wording of one appeal: which facts are listed, what each
// state offers, and the attributes assistive tech and the stylesheet rely on.
import { afterEach, describe, expect, it, vi } from "vitest";
import { moderationText as t } from "../../i18n/moderation";
import type { AppealDetail } from "./api";
import {
  buildAppealDetail,
  type AppealDetailOptions,
  type AppealDetailView,
  type AppealDraft,
  type AppealWrite,
} from "./AppealDetail";
import { dateText } from "./Evidence";

afterEach(() => {
  document.body.replaceChildren();
});

const ME = 7;
const OTHER = 8;
const APPELLANT = 9;

const D_FILED = "2026-09-20 10:00:00";
const D_ISSUED = "2026-09-18 08:30:00";
const D_UNTIL = "2026-09-25 08:30:00";
const D_LIFTED = "2026-09-19 12:00:00";
const D_ACK = "2026-09-18 09:00:00";
const D_DECIDED = "2026-09-21 11:00:00";

function appeal(over: Partial<AppealDetail> = {}, action: Partial<AppealDetail["action"]> = {}) {
  const base: AppealDetail = {
    id: "ap1",
    appellantId: APPELLANT,
    state: "open",
    assigneeId: 0,
    decidedBy: 0,
    body: "Please reconsider.",
    decisionNote: "",
    createdAt: D_FILED,
    decidedAt: null,
    action: {
      kind: "timeout",
      actorId: OTHER,
      reason: "flooding",
      createdAt: D_ISSUED,
      expiresAt: null,
      acknowledgedAt: null,
      liftedAt: null,
    },
    reportId: null,
  };
  return { ...base, ...over, action: { ...base.action, ...action } };
}

interface Built {
  readonly view: AppealDetailView;
  readonly writes: AppealWrite[];
  readonly opened: string[];
  readonly draft: AppealDraft;
  readonly abort: AbortController;
  readonly onWrite: ReturnType<typeof vi.fn>;
}

function build(
  detail: AppealDetail,
  over: Partial<Omit<AppealDetailOptions, "detail" | "signal">> & { accept?: boolean } = {},
): Built {
  const writes: AppealWrite[] = [];
  const opened: string[] = [];
  const abort = new AbortController();
  const draft: AppealDraft = over.draft ?? { note: "", outcome: null };
  const onWrite = vi.fn((w: AppealWrite) => {
    writes.push(w);
    return over.accept ?? true;
  });
  const view = buildAppealDetail({
    detail,
    me: over.me ?? ME,
    draft,
    onWrite: over.onWrite ?? onWrite,
    onOpenReport: over.onOpenReport ?? ((id) => opened.push(id)),
    signal: abort.signal,
  });
  document.body.appendChild(view.element);
  return { view, writes, opened, draft, abort, onWrite };
}

const q = <T extends Element>(root: ParentNode, sel: string): T => root.querySelector<T>(sel)!;
const qa = <T extends Element>(root: ParentNode, sel: string): T[] => [
  ...root.querySelectorAll<T>(sel),
];
const work = (b: Built): HTMLElement =>
  q<HTMLElement>(b.view.element, "[data-testid=mod-appeal-work]");
const factRows = (dl: Element): string[][] =>
  qa<HTMLElement>(dl, "dt").map((dt, i) => [
    dt.textContent,
    qa<HTMLElement>(dl, "dd")[i]!.textContent,
  ]);
const detailFacts = (b: Built): string[][] => factRows(qa(b.view.element, "dl")[0]!);
const actionFacts = (b: Built): string[][] => factRows(qa(b.view.element, "dl")[1]!);
const paragraphs = (root: ParentNode): string[] =>
  qa<HTMLElement>(root, "p").map((p) => p.textContent);

const decisionForm = (b: Built): HTMLFormElement => q<HTMLFormElement>(work(b), "form");
const outcomeRadios = (b: Built): HTMLInputElement[] =>
  qa<HTMLInputElement>(decisionForm(b), "input[type=radio]");
const noteField = (b: Built): HTMLTextAreaElement =>
  q<HTMLTextAreaElement>(decisionForm(b), "[data-testid=mod-appeal-note]");
const submitDecision = (b: Built): Event => {
  const e = new Event("submit", { bubbles: true, cancelable: true });
  decisionForm(b).dispatchEvent(e);
  return e;
};
const idNumber = (b: Built): number => Number(b.view.heading.id.split("-").pop());

function assigned(over: Partial<AppealDetail["action"]> = {}, extra: Partial<AppealDetail> = {}) {
  return appeal({ state: "assigned", assigneeId: ME, ...extra }, over);
}

describe("appeal landmarks", () => {
  it("labels the section by its focusable heading and numbers each appeal once", () => {
    const first = build(appeal());
    const second = build(appeal());
    const { element, heading } = first.view;
    expect(element.tagName).toBe("SECTION");
    expect(element.className).toBe("mod-report");
    expect(element.dataset["testid"]).toBe("mod-appeal");
    expect(heading.tagName).toBe("H3");
    expect(heading.id).toMatch(/^mod-appeal-\d+$/);
    expect(element.getAttribute("aria-labelledby")).toBe(heading.id);
    expect(heading.getAttribute("tabindex")).toBe("-1");
    expect(heading.textContent).toBe(t("appeal.title", { kind: t("kind.timeout") }));
    expect(idNumber(second)).toBe(idNumber(first) + 1);
    expect(idNumber(first)).toBeGreaterThan(0);
  });

  it("labels the decision section by its own heading", () => {
    const b = build(appeal());
    const w = work(b);
    expect(w.tagName).toBe("SECTION");
    expect(w.className).toBe("mod-work");
    const h4 = q<HTMLElement>(w, "h4");
    expect(h4.textContent).toBe(t("appeal.work.title"));
    expect(h4.id).toMatch(/^mod-appeal-work-\d+$/);
    expect(w.getAttribute("aria-labelledby")).toBe(h4.id);
  });

  it("lists facts as definition lists the stylesheet can find", () => {
    const b = build(appeal());
    const lists = qa<HTMLElement>(b.view.element, "dl");
    expect(lists).toHaveLength(2);
    for (const dl of lists) expect(dl.className).toBe("mod-report-facts");
  });
});

describe("appeal facts", () => {
  it("lists who filed it, its state, assignee and when for an undecided appeal", () => {
    const b = build(appeal());
    expect(detailFacts(b)).toEqual([
      [t("appeal.fact.appellant"), expect.any(String)],
      [t("fact.state"), t("appeal.state.open")],
      [t("fact.assignee"), t("fact.unassigned")],
      [t("fact.filed"), dateText(D_FILED)],
    ]);
  });

  it("names the assignee once someone has taken it", () => {
    expect(detailFacts(build(appeal({ state: "assigned", assigneeId: ME })))[2]).toEqual([
      t("fact.assignee"),
      t("name.you"),
    ]);
    expect(detailFacts(build(appeal({ state: "assigned", assigneeId: 0 })))[2]?.[1]).toBe(
      t("fact.unassigned"),
    );
  });

  it("adds who decided and when once the appeal is upheld or overturned", () => {
    for (const state of ["upheld", "overturned"]) {
      const b = build(appeal({ state, decidedBy: ME, decidedAt: D_DECIDED }));
      expect(detailFacts(b).slice(4)).toEqual([
        [t("appeal.fact.decidedBy"), t("name.you")],
        [t("appeal.fact.decided"), dateText(D_DECIDED)],
      ]);
    }
    for (const state of ["open", "assigned", "withdrawn"]) {
      expect(detailFacts(build(appeal({ state, decidedAt: D_DECIDED }))).length).toBe(4);
    }
  });

  it("lists the appealed action with its issuer, time and reason", () => {
    const b = build(appeal());
    expect(q<HTMLElement>(b.view.element, "h4").textContent).toBe(t("appeal.action.title"));
    expect(actionFacts(b)).toEqual([
      [t("appeal.action.by"), expect.any(String)],
      [t("appeal.action.at"), dateText(D_ISSUED)],
      [t("appeal.action.reason"), "flooding"],
    ]);
  });

  it("says when no reason was given", () => {
    const b = build(appeal({}, { reason: "" }));
    expect(actionFacts(b)[2]).toEqual([t("appeal.action.reason"), t("appeal.action.noReason")]);
  });

  it("shows an expiry only while the action has not been lifted", () => {
    expect(actionFacts(build(appeal({}, { expiresAt: D_UNTIL }))).slice(3)).toEqual([
      [t("appeal.action.until"), dateText(D_UNTIL)],
    ]);
    expect(actionFacts(build(appeal({}, { expiresAt: null }))).length).toBe(3);
    expect(
      actionFacts(build(appeal({}, { expiresAt: D_UNTIL, liftedAt: D_LIFTED }))).slice(3),
    ).toEqual([[t("appeal.action.lifted"), dateText(D_LIFTED)]]);
    expect(
      actionFacts(build(appeal({}, { expiresAt: null, liftedAt: D_LIFTED }))).slice(3),
    ).toEqual([[t("appeal.action.lifted"), dateText(D_LIFTED)]]);
  });

  it("shows when the member acknowledged the action", () => {
    expect(actionFacts(build(appeal({}, { acknowledgedAt: D_ACK }))).slice(3)).toEqual([
      [t("appeal.action.acknowledged"), dateText(D_ACK)],
    ]);
    expect(
      actionFacts(build(appeal({}, { liftedAt: D_LIFTED, acknowledgedAt: D_ACK }))).slice(3),
    ).toEqual([
      [t("appeal.action.lifted"), dateText(D_LIFTED)],
      [t("appeal.action.acknowledged"), dateText(D_ACK)],
    ]);
  });
});

describe("appeal statement and linked report", () => {
  it("shows the statement, or says there is none", () => {
    const withBody = build(appeal({ body: "I was not flooding." }));
    const p = q<HTMLElement>(withBody.view.element, "p.mod-report-note");
    expect(p.textContent).toBe("I was not flooding.");
    const without = build(appeal({ body: "" }));
    expect(qa(without.view.element, "p.mod-report-note")).toHaveLength(0);
    expect(paragraphs(without.view.element)).toContain(t("appeal.statement.none"));
    expect(paragraphs(withBody.view.element)).not.toContain(t("appeal.statement.none"));
  });

  it("offers no report link unless the server returned a report", () => {
    const b = build(appeal());
    expect(qa(b.view.element, "[data-focus=report]")).toHaveLength(0);
    expect(b.view.element.textContent).not.toContain(t("appeal.report.title"));
  });

  it("opens the linked report by its id, and stops once the view is gone", () => {
    const b = build(appeal({ reportId: "rep-9" }));
    const open = q<HTMLButtonElement>(b.view.element, "[data-focus=report]");
    expect(open.tagName).toBe("BUTTON");
    expect(open.type).toBe("button");
    expect(open.className).toBe("btn-modal-save");
    expect(open.textContent).toBe(t("appeal.report.open"));
    expect(b.view.element.textContent).toContain(t("appeal.report.title"));
    expect(paragraphs(b.view.element)).toContain(t("appeal.report.hint"));
    open.click();
    expect(b.opened).toEqual(["rep-9"]);
    b.abort.abort();
    open.click();
    expect(b.opened).toEqual(["rep-9"]);
  });
});

describe("a decided or closed appeal", () => {
  it("states an upheld outcome and offers nothing to do", () => {
    const b = build(appeal({ state: "upheld", decidedBy: OTHER, decisionNote: "Clear breach." }));
    const result = q<HTMLElement>(work(b), "[data-testid=mod-appeal-result]");
    expect(result.textContent).toBe(t("appeal.result.upheld"));
    expect(paragraphs(work(b))).not.toContain(t("appeal.result.timeout"));
    expect(qa(work(b), "button, form")).toHaveLength(0);
    expect(q<HTMLElement>(work(b), "p.mod-report-note").textContent).toBe("Clear breach.");
    expect(paragraphs(work(b))).toContain(t("appeal.result.appellant"));
    expect(b.view.takesInput).toBe(false);
  });

  it("states an overturn with what it did for that kind of action", () => {
    for (const kind of ["timeout", "ban", "warning", "removal"] as const) {
      const b = build(appeal({ state: "overturned" }, { kind }));
      expect(q<HTMLElement>(work(b), "[data-testid=mod-appeal-result]").textContent).toBe(
        t("appeal.result.overturned"),
      );
      expect(paragraphs(work(b))).toContain(t(`appeal.result.${kind}`));
    }
    const other = build(appeal({ state: "overturned" }, { kind: "mute" }));
    expect(paragraphs(work(other))).toEqual([
      t("appeal.result.overturned"),
      t("appeal.result.noNote"),
      t("appeal.result.appellant"),
    ]);
  });

  it("says when no note went to the appellant", () => {
    const b = build(appeal({ state: "overturned", decisionNote: "" }));
    expect(paragraphs(work(b))).toContain(t("appeal.result.noNote"));
    expect(qa(work(b), "p.mod-report-note")).toHaveLength(0);
    expect(work(b).textContent).toContain(t("appeal.result.note"));
  });

  it("only says that a withdrawn appeal cannot be decided", () => {
    const b = build(appeal({ state: "withdrawn" }));
    expect(paragraphs(work(b))).toEqual([t("appeal.result.withdrawn")]);
    expect(qa(work(b), "button, form")).toHaveLength(0);
    expect(b.view.takesInput).toBe(false);
  });

  it("treats a state it does not know as closed", () => {
    const b = build(appeal({ state: "archived" }));
    expect(paragraphs(work(b))).toEqual([t("appeal.state.unknown")]);
    expect(qa(work(b), "button, form")).toHaveLength(0);
    expect(b.view.takesInput).toBe(false);
  });
});

describe("taking an appeal", () => {
  it("offers to take an unassigned appeal", () => {
    const b = build(appeal());
    expect(paragraphs(work(b))).toEqual([t("appeal.work.unassigned")]);
    const take = q<HTMLButtonElement>(work(b), "button");
    expect(take.type).toBe("button");
    expect(take.className).toBe("btn-modal-save");
    expect(take.dataset["focus"]).toBe("assign");
    expect(take.textContent).toBe(t("appeal.work.assign"));
    expect(b.view.takesInput).toBe(false);
    take.click();
    expect(b.writes).toEqual([{ kind: "assign" }]);
    expect(take.getAttribute("aria-disabled")).toBe("true");
  });

  it("leaves the button usable when the write was not accepted", () => {
    const b = build(appeal(), { accept: false });
    const take = q<HTMLButtonElement>(work(b), "button");
    take.click();
    expect(b.writes).toEqual([{ kind: "assign" }]);
    expect(take.hasAttribute("aria-disabled")).toBe(false);
  });

  it("does not send once the view is gone", () => {
    const b = build(appeal());
    b.abort.abort();
    q<HTMLButtonElement>(work(b), "button").click();
    expect(b.writes).toEqual([]);
  });

  it("leaves another moderator's appeal alone", () => {
    const b = build(appeal({ state: "assigned", assigneeId: OTHER }));
    expect(paragraphs(work(b))).toEqual([t("appeal.work.other")]);
    expect(qa(work(b), "button, form")).toHaveLength(0);
    expect(b.view.takesInput).toBe(false);
  });

  it("reminds a moderator reviewing their own action of the server's rule", () => {
    const own = build(appeal({}, { actorId: ME }));
    expect(paragraphs(work(own))[0]).toBe(t("appeal.work.ownAction"));
    const others = build(appeal({}, { actorId: OTHER }));
    expect(paragraphs(work(others))).not.toContain(t("appeal.work.ownAction"));
    const erased = build(appeal({}, { actorId: 0 }), { me: 0 });
    expect(paragraphs(work(erased))).not.toContain(t("appeal.work.ownAction"));
    const erasedForMe = build(appeal({}, { actorId: 0 }));
    expect(paragraphs(work(erasedForMe))).not.toContain(t("appeal.work.ownAction"));
  });
});

describe("the decision form", () => {
  it("builds a form for the holder, with nothing preselected", () => {
    const b = build(assigned());
    expect(b.view.takesInput).toBe(true);
    expect(paragraphs(work(b))[0]).toBe(t("appeal.work.mine"));
    expect(decisionForm(b).className).toBe("mod-work-form");
    expect(decisionForm(b).getAttribute("novalidate")).toBe("");
    expect(outcomeRadios(b).map((r) => r.checked)).toEqual([false, false]);
  });

  it("groups two named outcomes, each labelled and focusable", () => {
    const b = build(assigned());
    const fieldset = q<HTMLElement>(decisionForm(b), "fieldset");
    expect(fieldset.className).toBe("mod-work-outcomes");
    expect(q<HTMLElement>(fieldset, "legend").textContent).toBe(t("appeal.work.outcomeLabel"));
    const [upheld, overturned] = outcomeRadios(b);
    expect([upheld?.value, overturned?.value]).toEqual(["upheld", "overturned"]);
    expect([upheld?.dataset["focus"], overturned?.dataset["focus"]]).toEqual([
      "outcome-upheld",
      "outcome-overturned",
    ]);
    expect(upheld?.name).toMatch(/^mod-appeal-outcome-\d+$/);
    expect(overturned?.name).toBe(upheld?.name);
    expect(upheld?.id).toMatch(/^mod-appeal-\d+-upheld$/);
    expect(overturned?.id).toMatch(/^mod-appeal-\d+-overturned$/);
    const labels = qa<HTMLLabelElement>(fieldset, "label");
    expect(labels.map((l) => l.className)).toEqual(["mod-work-outcome", "mod-work-outcome"]);
    expect(labels.map((l) => l.htmlFor)).toEqual([upheld?.id, overturned?.id]);
    expect(labels.map((l) => l.textContent)).toEqual([
      t("appeal.outcome.upheld"),
      t("appeal.outcome.overturned"),
    ]);
  });

  it("restores a kept draft's outcome and note", () => {
    const b = build(assigned(), { draft: { note: "kept words", outcome: "overturned" } });
    expect(outcomeRadios(b).map((r) => r.checked)).toEqual([false, true]);
    expect(noteField(b).value).toBe("kept words");
  });

  it("describes the fieldset by what an overturn does and by the outcome error", () => {
    const b = build(assigned({ kind: "ban" }));
    const fieldset = q<HTMLElement>(decisionForm(b), "fieldset");
    const [hint, error] = qa<HTMLElement>(decisionForm(b), "p").slice(0, 2);
    expect(hint?.textContent).toBe(t("appeal.effect.ban"));
    expect(hint?.className).toBe("mod-evidence-status");
    expect(hint?.id).toMatch(/^mod-appeal-\d+-effect$/);
    expect(error?.id).toMatch(/^mod-appeal-\d+-outcome-error$/);
    expect(error?.className).toBe("form-error");
    expect(error?.getAttribute("role")).toBe("alert");
    expect(error?.textContent).toBe("");
    expect(fieldset.getAttribute("aria-describedby")).toBe(`${hint?.id} ${error?.id}`);
  });

  it("states nothing about an overturn for an action kind without a stated effect", () => {
    const b = build(assigned({ kind: "mute" }));
    expect(qa<HTMLElement>(decisionForm(b), "p")[0]?.textContent).toBe("");
  });

  it("gives the note field its label, limits and hint", () => {
    const b = build(assigned());
    const field = noteField(b);
    expect(field.className).toBe("form-input");
    expect(field.id).toMatch(/^mod-appeal-\d+-note$/);
    expect(field.rows).toBe(3);
    expect(field.maxLength).toBe(2000);
    expect(field.dataset["focus"]).toBe("note");
    const label = q<HTMLLabelElement>(decisionForm(b), `label[for="${field.id}"]`);
    expect(label.textContent).toBe(t("appeal.work.noteLabel"));
    const hint = q<HTMLElement>(decisionForm(b), `#${field.id}-hint`);
    expect(hint.textContent).toBe(t("appeal.work.noteHint"));
    expect(hint.className).toBe("mod-evidence-status");
    expect(field.getAttribute("aria-describedby")).toBe(hint.id);
  });

  it("names the decide button and what recording it means", () => {
    const b = build(assigned());
    const decide = q<HTMLButtonElement>(decisionForm(b), "[data-focus=decide]");
    expect(decide.type).toBe("submit");
    expect(decide.className).toBe("btn-modal-save");
    expect(decide.textContent).toBe(t("appeal.work.decide"));
    const hint = q<HTMLElement>(decisionForm(b), `#${decide.getAttribute("aria-describedby")}`);
    expect(hint.textContent).toBe(t("appeal.work.decideHint"));
    expect(hint.className).toBe("mod-evidence-status");
    expect(hint.id).toMatch(/^mod-appeal-\d+-final$/);
  });

  it("keeps the typed note and chosen outcome in the draft while the view is live", () => {
    const b = build(assigned());
    noteField(b).value = "typed";
    noteField(b).dispatchEvent(new Event("input"));
    expect(b.draft.note).toBe("typed");
    outcomeRadios(b)[1]!.click();
    expect(b.draft.outcome).toBe("overturned");
    outcomeRadios(b)[0]!.click();
    expect(b.draft.outcome).toBe("upheld");
    b.abort.abort();
    noteField(b).value = "after";
    noteField(b).dispatchEvent(new Event("input"));
    outcomeRadios(b)[1]!.click();
    expect(b.draft.note).toBe("typed");
    expect(b.draft.outcome).toBe("upheld");
  });

  it("asks for an outcome first, focuses the first choice, and clears the ask once one is picked", () => {
    const b = build(assigned());
    expect(submitDecision(b).defaultPrevented).toBe(true);
    const error = q<HTMLElement>(decisionForm(b), "p.form-error");
    expect(error.textContent).toBe(t("appeal.work.outcomeEmpty"));
    expect(b.writes).toEqual([]);
    expect(document.activeElement).toBe(outcomeRadios(b)[0]);
    outcomeRadios(b)[1]!.click();
    expect(error.textContent).toBe("");
  });

  it("sends the outcome with the note flattened to one clean line", () => {
    const b = build(assigned());
    outcomeRadios(b)[1]!.click();
    noteField(b).value = "\na\r\n\tb\u007f\n";
    expect(submitDecision(b).defaultPrevented).toBe(true);
    expect(b.writes).toEqual([{ kind: "decide", outcome: "overturned", note: "a b" }]);
    expect(
      q<HTMLElement>(decisionForm(b), "[data-focus=decide]").getAttribute("aria-disabled"),
    ).toBe("true");
  });

  it("sends nothing after the view is gone", () => {
    const b = build(assigned());
    outcomeRadios(b)[0]!.click();
    b.abort.abort();
    submitDecision(b);
    expect(b.writes).toEqual([]);
  });
});
