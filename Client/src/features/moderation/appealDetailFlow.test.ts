// One appeal in the Appeals tab: how it is opened, kept, re-read, closed and
// written to. The server authorizes every read and write; these tests pin what
// the view keeps and drops around each answer, and where focus goes.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiClientError, type ModerationAppealDetail } from "@lib/api";
import {
  alertsOf,
  byId,
  detail,
  flush,
  h,
  heldDetail,
  loaded,
  opened,
  q,
  qa,
  reread,
  resetHarness,
  row,
  rows,
  teardownHarness,
  text,
  work,
} from "../../../tests/helpers/appeal-harness";
import { noteAppealChange } from "./store";

beforeEach(resetHarness);
afterEach(teardownHarness);

async function push(): Promise<void> {
  noteAppealChange();
  await flush();
}

/** The queue and the open appeal read again after a push, answered with `d`. */
async function pushWith(d: ModerationAppealDetail): Promise<void> {
  await push();
  await reread(d);
}

const detailStatus = (root: ParentNode) => qa<HTMLElement>(root, "p.mod-center-status")[1]!;
const detailFailure = (root: ParentNode) => qa<HTMLElement>(root, "p.form-error")[1]!;
const detailRetry = (root: ParentNode) => qa<HTMLButtonElement>(root, "button.btn-modal-save")[1]!;
const slot = (root: ParentNode) => q<HTMLElement>(root, "div.mod-report-slot")!;
const heading = (root: ParentNode) => q<HTMLElement>(slot(root), "h3")!;
const note = (root: ParentNode) => q<HTMLTextAreaElement>(root, "[data-testid=mod-appeal-note]")!;
const writeStatus = (root: ParentNode) => text(root, "mod-appeal-write-status");

function type(root: ParentNode, value: string): void {
  const input = note(root);
  input.value = value;
  input.dispatchEvent(new Event("input"));
}

function pick(root: ParentNode, outcome: "upheld" | "overturned"): void {
  q<HTMLInputElement>(root, `input[value=${outcome}]`)!.click();
}

function submit(root: ParentNode): void {
  q<HTMLFormElement>(work(root), "form")!.requestSubmit();
}

function decide(root: ParentNode, outcome: "upheld" | "overturned", words = ""): void {
  pick(root, outcome);
  type(root, words);
  submit(root);
}

const take = (root: ParentNode) => q<HTMLButtonElement>(work(root), "button")!;

const press = (target: Element, key: string) => {
  const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  target.dispatchEvent(e);
  return e;
};

describe("opening an appeal", () => {
  it("shows a loading message and a busy slot until the appeal arrives", async () => {
    const { root } = await loaded([row("a1")]);
    rows(root)[0]!.click();
    expect(detailStatus(root).textContent).toBe("Loading appeal…");
    expect(slot(root).getAttribute("aria-busy")).toBe("true");
    expect(slot(root).childElementCount).toBe(0);
    h.details[0]!.resolve(detail("a1"));
    await flush();
    expect(detailStatus(root).textContent).toBe("");
    expect(slot(root).hasAttribute("aria-busy")).toBe(false);
    expect(heading(root)).not.toBeNull();
  });

  it("moves focus to the appeal when the reader had not moved on", async () => {
    const { root } = await loaded([row("a1")]);
    rows(root)[0]!.click();
    h.details[0]!.resolve(detail("a1"));
    await flush();
    expect(document.activeElement).toBe(heading(root));
  });

  it("moves focus to the appeal from the row that was chosen", async () => {
    const { root } = await loaded([row("a1")]);
    rows(root)[0]!.focus();
    rows(root)[0]!.click();
    h.details[0]!.resolve(detail("a1"));
    await flush();
    expect(document.activeElement).toBe(heading(root));
  });

  it("leaves focus where the reader moved it while the appeal was loading", async () => {
    const { root } = await loaded([row("a1")]);
    rows(root)[0]!.click();
    byId(root, "mod-appeal-filter").focus();
    h.details[0]!.resolve(detail("a1"));
    await flush();
    expect(document.activeElement).toBe(byId(root, "mod-appeal-filter"));
  });

  it("focuses the heading of an appeal that is already open, without reading it again", async () => {
    const { root } = await opened(detail("a1"));
    byId(root, "mod-appeal-filter").focus();
    rows(root)[0]!.click();
    expect(document.activeElement).toBe(heading(root));
    expect(h.details).toHaveLength(1);
  });

  it("reads again, and cancels the older read, when the appeal is chosen again while it loads", async () => {
    const { root } = await loaded([row("a1")]);
    rows(root)[0]!.click();
    rows(root)[0]!.click();
    expect(h.details).toHaveLength(2);
    expect(h.details[0]!.signal!.aborted).toBe(true);
    expect(h.details[1]!.signal!.aborted).toBe(false);
  });

  it("clears the last write's message when another appeal is chosen", async () => {
    const { root } = await loaded([row("a1"), row("a2")]);
    rows(root)[0]!.click();
    h.details[0]!.resolve(detail("a1"));
    await flush();
    take(root).click();
    h.writes[0]!.resolve();
    await flush();
    expect(writeStatus(root)).toBe("You're now reviewing this appeal.");
    rows(root)[1]!.click();
    expect(writeStatus(root)).toBe("");
  });

  it("clears the last write's refusal when another appeal is chosen", async () => {
    const { root } = await loaded([row("a1"), row("a2")]);
    rows(root)[0]!.click();
    h.details[0]!.resolve(detail("a1"));
    await flush();
    take(root).click();
    h.writes[0]!.reject(new Error("network"));
    await flush();
    expect(alertsOf(root)).not.toBe("");
    rows(root)[1]!.click();
    expect(alertsOf(root)).toBe("");
  });

  it("starts the next appeal with an empty decision", async () => {
    const { root } = await loaded([row("a1"), row("a2")]);
    rows(root)[0]!.click();
    h.details[0]!.resolve(heldDetail("a1"));
    await flush();
    pick(root, "upheld");
    type(root, "for a1");
    rows(root)[1]!.click();
    h.details[1]!.resolve(heldDetail("a2"));
    await flush();
    expect(note(root).value).toBe("");
    expect(q<HTMLInputElement>(root, "input:checked")).toBeNull();
    rows(root)[0]!.click();
    h.details[2]!.resolve(heldDetail("a1"));
    await flush();
    expect(note(root).value).toBe("");
    expect(q<HTMLInputElement>(root, "input:checked")).toBeNull();
  });
});

describe("closing an appeal with Escape", () => {
  it("removes the appeal, returns focus to its row and leaves no message", async () => {
    const { root } = await opened(detail("a1"));
    expect(rows(root)[0]!.getAttribute("aria-current")).toBe("true");
    const e = press(heading(root), "Escape");
    expect(e.defaultPrevented).toBe(true);
    expect(q(root, "[data-testid=mod-appeal]")).toBeNull();
    expect(document.activeElement).toBe(rows(root)[0]);
    expect(rows(root)[0]!.hasAttribute("aria-current")).toBe(false);
    expect(detailStatus(root).textContent).toBe("");
    expect(detailFailure(root).textContent).toBe("");
    expect(detailRetry(root).hidden).toBe(true);
  });

  it("ignores other keys and a key press something else already handled", async () => {
    const { root } = await opened(detail("a1"));
    expect(press(heading(root), "Enter").defaultPrevented).toBe(false);
    heading(root).addEventListener("keydown", (e) => e.preventDefault());
    press(heading(root), "Escape");
    expect(q(root, "[data-testid=mod-appeal]")).not.toBeNull();
  });

  it("drops the unsaved decision with the appeal", async () => {
    const { root } = await opened(heldDetail("a1"));
    pick(root, "overturned");
    type(root, "words");
    press(heading(root), "Escape");
    rows(root)[0]!.click();
    h.details.at(-1)!.resolve(heldDetail("a1"));
    await flush();
    expect(note(root).value).toBe("");
    expect(q(root, "input:checked")).toBeNull();
  });

  it("keeps a write in flight from being sent twice after the appeal is closed and opened again", async () => {
    const { root } = await opened(detail("a1"));
    take(root).click();
    press(heading(root), "Escape");
    rows(root)[0]!.click();
    h.details.at(-1)!.resolve(detail("a1"));
    await flush();
    take(root).click();
    expect(h.writes).toHaveLength(1);
  });
});

describe("a failed appeal read", () => {
  it("says so, offers Retry, and reads again with a loading message when it is pressed", async () => {
    const { root } = await loaded([row("a1")]);
    rows(root)[0]!.click();
    h.details[0]!.reject(new Error("network"));
    await flush();
    expect(detailFailure(root).textContent).toBe("Couldn't load this appeal.");
    expect(detailStatus(root).textContent).toBe("");
    expect(slot(root).hasAttribute("aria-busy")).toBe(false);
    expect(detailRetry(root).hidden).toBe(false);
    detailRetry(root).click();
    expect(h.details).toHaveLength(2);
    expect(detailFailure(root).textContent).toBe("");
    expect(detailRetry(root).hidden).toBe(true);
    expect(detailStatus(root).textContent).toBe("Loading appeal…");
    h.details[1]!.resolve(detail("a1"));
    await flush();
    expect(q(root, "[data-testid=mod-appeal]")).not.toBeNull();
    expect(detailStatus(root).textContent).toBe("");
  });

  it("moves focus into the appeal when the focused Retry gives way to it", async () => {
    const { root } = await loaded([row("a1")]);
    rows(root)[0]!.click();
    h.details[0]!.reject(new Error("network"));
    await flush();
    detailRetry(root).focus();
    detailRetry(root).click();
    h.details[1]!.resolve(detail("a1"));
    await flush();
    expect(document.activeElement).toBe(heading(root));
  });

  it("puts focus on Retry when it was inside the appeal that failed to refresh", async () => {
    const { root } = await opened(detail("a1"));
    expect(document.activeElement).toBe(heading(root));
    await push();
    h.lists.at(-1)!.resolve([row("a1")]);
    await flush();
    h.details.at(-1)!.reject(new Error("network"));
    await flush();
    expect(q(root, "[data-testid=mod-appeal]")).toBeNull();
    expect(document.activeElement).toBe(detailRetry(root));
  });

  it("leaves focus alone when it was elsewhere", async () => {
    const { root } = await opened(detail("a1"));
    byId(root, "mod-appeal-filter").focus();
    await push();
    h.lists.at(-1)!.resolve([row("a1")]);
    await flush();
    h.details.at(-1)!.reject(new Error("network"));
    await flush();
    expect(document.activeElement).toBe(byId(root, "mod-appeal-filter"));
  });

  it("clears every region when the server refuses the reader", async () => {
    const { root } = await opened(detail("a1"));
    await push();
    h.lists.at(-1)!.resolve([row("a1")]);
    await flush();
    h.details.at(-1)!.reject(new ApiClientError(403, "FORBIDDEN", "no"));
    await flush();
    expect(h.denied).toBe(1);
    expect(q(root, "[data-testid=mod-appeal]")).toBeNull();
    expect(byId(root, "mod-appeal-queue").hidden).toBe(true);
  });

  it("says the appeal is gone, reads the queue quietly and drops the selection on a 404", async () => {
    const { root } = await opened(detail("a1"));
    await push();
    h.lists.at(-1)!.resolve([row("a1")]);
    await flush();
    const lists = h.lists.length;
    h.details.at(-1)!.reject(new ApiClientError(404, "NOT_FOUND", "gone"));
    await flush();
    expect(detailStatus(root).textContent).toBe("This appeal is no longer available.");
    expect(h.lists).toHaveLength(lists + 1);
    expect(text(root, "mod-appeal-status")).toBe("1 appeal open or in review");
    expect(rows(root)[0]!.hasAttribute("aria-current")).toBe(false);
    expect(h.denied).toBe(0);
  });

  it("says the reader filed it on a refusal for their own appeal", async () => {
    const { root } = await loaded([row("a1")]);
    rows(root)[0]!.click();
    h.details[0]!.reject(new ApiClientError(403, "SELF_REVIEW", "own"));
    await flush();
    expect(detailStatus(root).textContent).toBe(
      "You filed this appeal, so another moderator has to decide it.",
    );
    expect(h.denied).toBe(0);
    expect(detailFailure(root).textContent).toBe("");
    expect(detailRetry(root).hidden).toBe(true);
  });

  it("returns focus to the row when an appeal that held focus goes away", async () => {
    const { root } = await opened(detail("a1"));
    expect(document.activeElement).toBe(heading(root));
    await push();
    h.lists.at(-1)!.resolve([row("a1")]);
    await flush();
    h.details.at(-1)!.reject(new ApiClientError(404, "NOT_FOUND", "gone"));
    await flush();
    expect(document.activeElement).toBe(rows(root)[0]);
  });

  it("returns focus to the row when Retry held it and the appeal is gone", async () => {
    const { root } = await loaded([row("a1")]);
    rows(root)[0]!.click();
    h.details[0]!.reject(new Error("network"));
    await flush();
    detailRetry(root).focus();
    detailRetry(root).click();
    h.details[1]!.reject(new ApiClientError(404, "NOT_FOUND", "gone"));
    await flush();
    expect(document.activeElement).toBe(rows(root)[0]);
  });

  it("leaves focus where it was when an appeal the reader was not in goes away", async () => {
    const { root } = await opened(detail("a1"));
    byId(root, "mod-appeal-filter").focus();
    await push();
    h.lists.at(-1)!.resolve([row("a1")]);
    await flush();
    h.details.at(-1)!.reject(new ApiClientError(404, "NOT_FOUND", "gone"));
    await flush();
    expect(document.activeElement).toBe(byId(root, "mod-appeal-filter"));
  });
});

describe("keeping the reader's place while an appeal is read again", () => {
  it("does not take focus from elsewhere, nor give it to the appeal", async () => {
    const { root } = await opened(detail("a1"));
    byId(root, "mod-appeal-filter").focus();
    await pushWith(detail("a1"));
    expect(document.activeElement).toBe(byId(root, "mod-appeal-filter"));
  });

  it("leaves focus on the page when nothing was focused", async () => {
    const { root } = await opened(detail("a1"));
    (document.activeElement as HTMLElement).blur();
    await pushWith(detail("a1"));
    expect(document.activeElement).toBe(document.body);
    expect(heading(root)).not.toBeNull();
  });

  it("puts focus back on the same control of the rebuilt appeal", async () => {
    const { root } = await opened(detail("a1"));
    const before = take(root);
    before.focus();
    await pushWith(detail("a1"));
    const after = take(root);
    expect(after).not.toBe(before);
    expect(document.activeElement).toBe(after);
  });

  it("puts focus on the heading when the focused part has no counterpart", async () => {
    const { root } = await opened(detail("a1"));
    heading(root).focus();
    await pushWith(detail("a1"));
    expect(document.activeElement).toBe(heading(root));
  });

  it("puts focus on the heading when the focused control is gone", async () => {
    const { root } = await opened(detail("a1"));
    take(root).focus();
    await pushWith(detail("a1", { state: "assigned", assignee_id: 8 }));
    expect(document.activeElement).toBe(heading(root));
  });

  it("restores the cursor and selection in the note", async () => {
    const { root } = await opened(heldDetail("a1"));
    type(root, "hello world");
    note(root).focus();
    note(root).setSelectionRange(2, 7);
    await pushWith(heldDetail("a1"));
    expect(document.activeElement).toBe(note(root));
    expect(note(root).value).toBe("hello world");
    expect([note(root).selectionStart, note(root).selectionEnd]).toEqual([2, 7]);
  });

  it("keeps the chosen outcome and the note across a refresh", async () => {
    const { root } = await opened(heldDetail("a1"));
    pick(root, "upheld");
    type(root, "kept");
    await pushWith(heldDetail("a1"));
    expect(note(root).value).toBe("kept");
    expect(q<HTMLInputElement>(root, "input[value=upheld]")!.checked).toBe(true);
  });

  it("keeps the unsaved decision across a failed refresh and a second look", async () => {
    const { root } = await opened(heldDetail("a1"));
    type(root, "kept");
    await push();
    h.lists.at(-1)!.resolve([row("a1")]);
    await flush();
    h.details.at(-1)!.reject(new Error("network"));
    await flush();
    rows(root)[0]!.click();
    h.details.at(-1)!.resolve(heldDetail("a1"));
    await flush();
    expect(note(root).value).toBe("kept");
  });
});

describe("a decision the appeal can no longer take", () => {
  it("says the unsaved note was discarded when another moderator took the appeal", async () => {
    const { root } = await opened(heldDetail("a1"));
    type(root, "my reasons");
    await pushWith(detail("a1", { state: "assigned", assignee_id: 8 }));
    expect(alertsOf(root)).toBe(
      "This appeal can no longer take your decision, so the unsaved note was discarded.",
    );
  });

  it("does not report a note that was only blank", async () => {
    const { root } = await opened(heldDetail("a1"));
    type(root, "   ");
    await pushWith(detail("a1", { state: "assigned", assignee_id: 8 }));
    expect(alertsOf(root)).toBe("");
  });

  it("does not report anything when there was no note", async () => {
    const { root } = await opened(heldDetail("a1"));
    await pushWith(detail("a1", { state: "assigned", assignee_id: 8 }));
    expect(alertsOf(root)).toBe("");
  });

  it("keeps an earlier message instead of adding the discard notice", async () => {
    const { root } = await opened(heldDetail("a1"));
    decide(root, "upheld", "my reasons");
    h.writes[0]!.reject(new ApiClientError(409, "CONFLICT", "changed"));
    await flush();
    await reread(detail("a1", { state: "assigned", assignee_id: 8 }));
    expect(alertsOf(root)).toContain("this appeal changed first");
    expect(alertsOf(root)).not.toContain("unsaved note");
  });

  it("starts from an empty decision if the appeal is taken again later", async () => {
    const { root } = await opened(heldDetail("a1"));
    type(root, "my reasons");
    await pushWith(detail("a1", { state: "assigned", assignee_id: 8 }));
    await pushWith(heldDetail("a1"));
    expect(note(root).value).toBe("");
  });
});

describe("refusals of a write", () => {
  it("says another moderator took the appeal first when Take is refused with a conflict", async () => {
    const { root } = await opened(detail("a1"));
    take(root).click();
    h.writes[0]!.reject(new ApiClientError(409, "CONFLICT", "taken"));
    await flush();
    expect(alertsOf(root)).toBe(
      "Another moderator took this appeal first, or it was decided or withdrawn.",
    );
  });

  it("says the decision was not recorded when another change got there first", async () => {
    const { root } = await opened(heldDetail("a1"));
    decide(root, "upheld");
    h.writes[0]!.reject(new ApiClientError(409, "CONFLICT", "taken"));
    await flush();
    expect(alertsOf(root)).toBe(
      "Nothing was recorded: this appeal changed first. Another moderator took or decided it, or the appellant withdrew it.",
    );
  });

  it("keeps a failed reversal apart from an ordinary conflict, on Take as well", async () => {
    const { root } = await opened(detail("a1"));
    take(root).click();
    h.writes[0]!.reject(new ApiClientError(409, "REVERSAL_FAILED", "could not apply"));
    await flush();
    expect(alertsOf(root)).toBe(
      "Nothing was recorded: the server couldn't reverse the action, so the decision was not saved. Try again later.",
    );
  });

  it("explains a self-review refusal", async () => {
    const { root } = await opened(detail("a1"));
    take(root).click();
    h.writes[0]!.reject(new ApiClientError(403, "SELF_REVIEW", "own"));
    await flush();
    expect(alertsOf(root)).toBe(
      "The server refused: you issued this action and another moderator can review its appeal, so they have to.",
    );
    expect(h.denied).toBe(0);
  });

  it("repeats the server's reason for a request it did not accept", async () => {
    const { root } = await opened(heldDetail("a1"));
    decide(root, "upheld", "x");
    h.writes[0]!.reject(new ApiClientError(400, "VALIDATION_ERROR", "note is too long"));
    await flush();
    expect(alertsOf(root)).toBe("The server didn't accept this: Note is too long");
  });

  it("does not quote an empty reason, and a request that did not reach the server may still have gone through", async () => {
    const { root } = await opened(heldDetail("a1"));
    decide(root, "upheld", "x");
    h.writes[0]!.reject(new ApiClientError(400, "INTERNAL", ""));
    await flush();
    expect(alertsOf(root)).toContain("Couldn't confirm your change");
    expect(alertsOf(root)).not.toContain("didn't accept");
  });

  it("says the change may have gone through when the connection drops mid-request, and reads the appeal again", async () => {
    const { root } = await opened(detail("a1"));
    take(root).click();
    h.writes[0]!.reject(new TypeError("network dropped"));
    await flush();
    expect(alertsOf(root)).toBe(
      "Couldn't confirm your change. The appeal was read again: check its status before trying again.",
    );
    expect(writeStatus(root)).toBe("");
    expect(h.lists).toHaveLength(2);
    expect(text(root, "mod-appeal-status")).toBe("1 appeal open or in review");
    await reread(detail("a1"));
    // The fresh read lets the reader try again.
    take(root).click();
    expect(h.writes).toHaveLength(2);
  });

  it("clears an earlier refusal when the next write starts", async () => {
    const { root } = await opened(detail("a1"));
    take(root).click();
    h.writes[0]!.reject(new Error("network"));
    await flush();
    await reread(detail("a1"));
    expect(alertsOf(root)).not.toBe("");
    take(root).click();
    expect(alertsOf(root)).toBe("");
  });

  it("takes a write to the 404 of a vanished appeal without announcing a queue read", async () => {
    const { root } = await opened(detail("a1"));
    take(root).click();
    h.writes[0]!.reject(new ApiClientError(404, "NOT_FOUND", "gone"));
    await flush();
    expect(detailStatus(root).textContent).toBe("This appeal is no longer available.");
    expect(h.lists).toHaveLength(2);
    expect(text(root, "mod-appeal-status")).toBe("1 appeal open or in review");
    expect(h.details).toHaveLength(1);
    // The appeal that is gone no longer blocks a write on another.
    expect(alertsOf(root)).toBe("");
  });
});

describe("bookkeeping around a write", () => {
  it("disables every control of the appeal while the write runs and sends one write", async () => {
    const { root } = await opened(heldDetail("a1"));
    decide(root, "upheld");
    for (const b of qa<HTMLButtonElement>(work(root), "button"))
      expect(b.getAttribute("aria-disabled")).toBe("true");
    submit(root);
    expect(h.writes).toHaveLength(1);
  });

  it("reads the queue once and the appeal once after a write, quietly", async () => {
    const { root } = await opened(detail("a1"));
    take(root).click();
    h.writes[0]!.resolve();
    await flush();
    expect(h.lists).toHaveLength(2);
    expect(h.details).toHaveLength(2);
    expect(text(root, "mod-appeal-status")).toBe("1 appeal open or in review");
    expect(detailStatus(root).textContent).toBe("");
    // The appeal stays on screen while it is read again.
    expect(q(root, "[data-testid=mod-appeal]")).not.toBeNull();
    h.lists[1]!.resolve([row("a1")]);
    await flush();
    expect(h.details).toHaveLength(2);
  });

  it("sends nothing while the appeal is still being read again after a write", async () => {
    const { root } = await opened(detail("a1"));
    const old = take(root);
    old.click();
    h.writes[0]!.resolve();
    await flush();
    old.click();
    expect(h.writes).toHaveLength(1);
    h.details.at(-1)!.resolve(heldDetail("a1"));
    await flush();
    pick(root, "upheld");
    submit(root);
    expect(h.writes).toHaveLength(2);
  });

  it("lets a second action through only once the first one's answer has been read back", async () => {
    const { root } = await opened(detail("a1"));
    take(root).click();
    h.writes[0]!.resolve();
    await flush();
    await reread(heldDetail("a1"));
    decide(root, "overturned", "ok");
    expect(h.writes).toHaveLength(2);
    expect(h.writes[1]).toMatchObject({
      op: "decide",
      body: { outcome: "overturned", note: "ok" },
    });
  });

  it("does not report a finished write for an appeal the reader has left", async () => {
    const { root } = await loaded([row("a1"), row("a2")]);
    rows(root)[0]!.click();
    h.details[0]!.resolve(detail("a1"));
    await flush();
    take(root).click();
    rows(root)[1]!.click();
    h.details[1]!.resolve(detail("a2"));
    await flush();
    const reads = [h.lists.length, h.details.length];
    h.writes[0]!.resolve();
    await flush();
    expect(writeStatus(root)).toBe("");
    expect([h.lists.length, h.details.length]).toEqual(reads);
    // The leftover write no longer blocks the appeal now on screen.
    take(root).click();
    expect(h.writes).toHaveLength(2);
  });

  it("does not show a refusal for an appeal the reader has left", async () => {
    const { root } = await loaded([row("a1"), row("a2")]);
    rows(root)[0]!.click();
    h.details[0]!.resolve(detail("a1"));
    await flush();
    take(root).click();
    rows(root)[1]!.click();
    h.details[1]!.resolve(detail("a2"));
    await flush();
    const reads = [h.lists.length, h.details.length];
    h.writes[0]!.reject(new Error("network"));
    await flush();
    expect(alertsOf(root)).toBe("");
    expect([h.lists.length, h.details.length]).toEqual(reads);
    take(root).click();
    expect(h.writes).toHaveLength(2);
  });

  it("keeps another appeal's unsaved decision when a decision on this one is recorded", async () => {
    const { root } = await loaded([row("a1"), row("a2")]);
    rows(root)[0]!.click();
    h.details[0]!.resolve(heldDetail("a1"));
    await flush();
    decide(root, "upheld", "for a1");
    rows(root)[1]!.click();
    h.details[1]!.resolve(heldDetail("a2"));
    await flush();
    type(root, "for a2");
    h.writes[0]!.resolve();
    await flush();
    await pushWith(heldDetail("a2"));
    expect(note(root).value).toBe("for a2");
  });

  it("starts the next decision empty once one is recorded", async () => {
    const { root } = await opened(heldDetail("a1"));
    decide(root, "upheld", "recorded words");
    h.writes[0]!.resolve();
    await flush();
    // The server still reports the appeal as open: the form comes back blank.
    await reread(heldDetail("a1"));
    expect(note(root).value).toBe("");
    expect(q(root, "input:checked")).toBeNull();
  });

  it("does not clear a decision just because Take was recorded", async () => {
    const { root } = await opened(detail("a1"));
    take(root).click();
    h.writes[0]!.resolve();
    await flush();
    await reread(heldDetail("a1"));
    type(root, "mine");
    await pushWith(heldDetail("a1"));
    expect(note(root).value).toBe("mine");
  });

  it("does not tell the other tab about a refusal that arrives after the view closed", async () => {
    const { root } = await opened(detail("a1"));
    take(root).click();
    h.view.abort();
    h.writes[0]!.reject(new ApiClientError(403, "FORBIDDEN", "no"));
    await flush();
    expect(h.denied).toBe(0);
  });

  it("refuses to send once the view is denied", async () => {
    const { root, appeals } = await opened(detail("a1"));
    const button = take(root);
    appeals.deny();
    button.click();
    expect(h.writes).toHaveLength(0);
    expect(button.hasAttribute("aria-disabled")).toBe(false);
  });

  it("ignores the answer to a write when the view is denied meanwhile", async () => {
    const { root, appeals } = await opened(detail("a1"));
    take(root).click();
    appeals.deny();
    const calls = h.denied;
    h.writes[0]!.reject(new ApiClientError(403, "FORBIDDEN", "no"));
    await flush();
    expect(h.denied).toBe(calls);
    expect(alertsOf(root)).toContain("You no longer have permission");
    expect(h.lists).toHaveLength(1);
  });
});

describe("answers that arrive out of order", () => {
  it("shows only the newest read of an appeal when an older one answers last", async () => {
    const { root } = await loaded([row("a1")]);
    rows(root)[0]!.click();
    await push();
    h.lists.at(-1)!.resolve([row("a1")]);
    await flush();
    expect(h.details).toHaveLength(2);
    expect(h.details[0]!.signal!.aborted).toBe(true);
    h.details[0]!.resolve(detail("a1", { body: "OLD STATEMENT" }));
    await flush();
    expect(q(root, "[data-testid=mod-appeal]")).toBeNull();
    h.details[1]!.resolve(detail("a1", { body: "NEW STATEMENT" }));
    await flush();
    expect(slot(root).textContent).toContain("NEW STATEMENT");
    expect(slot(root).textContent).not.toContain("OLD STATEMENT");
  });

  it("ignores a failure of an older read of an appeal", async () => {
    const { root } = await loaded([row("a1")]);
    rows(root)[0]!.click();
    await push();
    h.lists.at(-1)!.resolve([row("a1")]);
    await flush();
    h.details[0]!.reject(new Error("network"));
    await flush();
    expect(detailFailure(root).textContent).toBe("");
    expect(detailRetry(root).hidden).toBe(true);
    expect(slot(root).getAttribute("aria-busy")).toBe("true");
    h.details[1]!.resolve(detail("a1"));
    await flush();
    expect(q(root, "[data-testid=mod-appeal]")).not.toBeNull();
  });

  it("keeps asking for focus when a push re-reads an appeal that is still loading", async () => {
    const { root } = await loaded([row("a1")]);
    rows(root)[0]!.click();
    await push();
    h.lists.at(-1)!.resolve([row("a1")]);
    await flush();
    expect(detailStatus(root).textContent).toBe("Loading appeal…");
    h.details[1]!.resolve(detail("a1"));
    await flush();
    expect(detailStatus(root).textContent).toBe("");
    expect(document.activeElement).toBe(heading(root));
  });
});

describe("switching between appeals", () => {
  it("empties the open appeal as soon as another one is chosen", async () => {
    const { root } = await loaded([row("a1"), row("a2")]);
    rows(root)[0]!.click();
    h.details[0]!.resolve(detail("a1"));
    await flush();
    rows(root)[1]!.click();
    expect(q(root, "[data-testid=mod-appeal]")).toBeNull();
    expect(detailStatus(root).textContent).toBe("Loading appeal…");
  });

  it("marks the open appeal's row again after the queue is rebuilt", async () => {
    const { root } = await opened(detail("a1"));
    await push();
    h.lists.at(-1)!.resolve([row("a2"), row("a1")]);
    await flush();
    const current = rows(root).filter((b) => b.getAttribute("aria-current") === "true");
    expect(current.map((b) => b.dataset.appealId)).toEqual(["a1"]);
  });

  it("discards an unsaved decision when the reader goes to another appeal that fails to load", async () => {
    const { root } = await loaded([row("a1"), row("a2")]);
    rows(root)[0]!.click();
    h.details[0]!.resolve(heldDetail("a1"));
    await flush();
    type(root, "for a1");
    rows(root)[1]!.click();
    h.details[1]!.reject(new Error("network"));
    await flush();
    rows(root)[0]!.click();
    h.details[2]!.resolve(heldDetail("a1"));
    await flush();
    expect(note(root).value).toBe("");
  });

  it("keeps another appeal's unsaved decision when Take on this one is recorded", async () => {
    const { root } = await loaded([row("a1"), row("a2")]);
    rows(root)[0]!.click();
    h.details[0]!.resolve(detail("a1"));
    await flush();
    take(root).click();
    rows(root)[1]!.click();
    h.details[1]!.resolve(heldDetail("a2"));
    await flush();
    type(root, "for a2");
    h.writes[0]!.resolve();
    await flush();
    await pushWith(heldDetail("a2"));
    expect(note(root).value).toBe("for a2");
  });

  it("closes an appeal on Escape and puts focus on its row even if focus had moved", async () => {
    const { root } = await opened(detail("a1"));
    byId(root, "mod-appeal-filter").focus();
    heading(root).dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    expect(document.activeElement).toBe(rows(root)[0]);
  });

  it("stops handling Escape on an appeal once the view has closed", async () => {
    const { root } = await opened(detail("a1"));
    const title = heading(root);
    h.view.abort();
    const e = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    title.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
  });
});

describe("a write that is still going when the appeal fails to refresh", () => {
  it("holds the next write until the first one has answered", async () => {
    const { root } = await opened(detail("a1"));
    take(root).click();
    await push();
    h.lists.at(-1)!.resolve([row("a1")]);
    await flush();
    h.details.at(-1)!.reject(new Error("network"));
    await flush();
    detailRetry(root).click();
    h.details.at(-1)!.resolve(detail("a1"));
    await flush();
    take(root).click();
    expect(h.writes).toHaveLength(1);
    h.writes[0]!.resolve();
    await flush();
    await reread(detail("a1"));
    take(root).click();
    expect(h.writes).toHaveLength(2);
  });

  it("does not quote a server message for a failure that is not a rejected request", async () => {
    const { root } = await opened(detail("a1"));
    take(root).click();
    h.writes[0]!.reject(new ApiClientError(500, "SERVER_ERROR", "kaput"));
    await flush();
    expect(alertsOf(root)).toContain("Couldn't confirm your change");
    expect(alertsOf(root)).not.toContain("kaput");
  });
});
