/**
 * The Moderation Center (B9-11, Q2): the report queue and the selected
 * report's evidence, for MODERATE_MEMBERS holders. view.ts loads this module
 * on first open.
 *
 * The server authorizes everything here. The list is GET /moderation/queue
 * with the state filters the server supports and the count of what it
 * returned; the detail is a separate read per report. A 403 from either
 * clears every report on screen; a 404 is a report that is gone or about the
 * reader, and is never probed further.
 *
 * Every request is bound to the view's signal and to the selection or filter
 * it was made for, so a late answer is dropped. mod_queue and a reconnect only
 * trigger a fresh read. Withdrawing NSFW consent takes the evidence off screen
 * at once; closing the view, losing the permission, signing out or switching
 * profile removes it all, from the DOM and from memory.
 *
 * Review (B9-12): taking, noting and closing a report are single writes. One
 * write runs at a time; whatever the answer, the queue and the report are read
 * again, so a conflict with another moderator (409) shows the server's current
 * state rather than this view's guess. The next write waits for that read, so
 * controls built before the write can't send it twice. A report the reader's
 * own write moves out of the current filter stays open and is read by id; one
 * that leaves the list for any other reason closes and says so. An unsaved
 * note and chosen outcome live only while the report can still take them and
 * the view is live.
 *
 * Actions (B9-13): a warning or timeout is sent through the report, and lifting
 * a timeout through the member's own route; each is one write under the same
 * guard. Success is said only once the server answers, and a timeout says
 * whether its voice half was applied or skipped, as the server reported it. A
 * 403 on an action is shown as the server's refusal (a member ranked at or
 * above the reader) and the report is read again: if the reader lost the
 * permission, that read's own 403 clears the view. An action that gets no
 * answer may still have been recorded, so the history is read, not guessed.
 *
 * Removal, kick and ban (B9-14) go through the report the same way. A change
 * to the reader's role rebuilds the open report, so an action their role no
 * longer holds stops being offered before the server has to refuse it.
 *
 * Appeals (B9-17): the view is two tabs, Reports and Appeals (AppealQueue.ts,
 * rendered the first time its tab is chosen). A 403 in either tab clears
 * both. An appeal's linked report opens here by id, outside the filter, and
 * its read is authorized again like any other.
 */

import {
  ApiClientError,
  errorText,
  type ModerationActRequest,
  type ModerationOutcome,
  type ModerationQueueFilter,
} from "@lib/api";
import { Disposable } from "@lib/disposable";
import { appendChildren, clearChildren, createElement, setText } from "@lib/dom";
import type { MountableComponent } from "@lib/safe-render";
import { authStore } from "@stores/auth.store";
import { channelsStore, setNsfwAcknowledged } from "@stores/channels.store";
import { uiStore } from "@stores/ui.store";
import { moderationText as t } from "../../i18n/moderation";
import { nsfwContentBlocked } from "../content-consent/nsfw";
import type { FeatureViewContext } from "../navigation/destinations";
import {
  buildActionForms,
  emptyActionDraft,
  ENFORCE,
  UNITS,
  type ActionDraft,
  type ActionWrite,
} from "./ActionForms";
import { renderAppeals, type AppealsView } from "./AppealQueue";
import {
  isStatus,
  itemFromDetail,
  mapDetail,
  mapQueueRow,
  type QueueItem,
  type ReportDetail,
} from "./api";
import {
  buildReportDetail,
  dateText,
  memberName,
  nameText,
  reportTitle,
  stateText,
} from "./Evidence";
import { buildHistory } from "./History";
import { modQueueStore } from "./store";
import { buildWorkflow, type WorkflowWrite } from "./Workflow";

const FILTERS = [
  { value: "", labelKey: "filter.active", countKey: "count.active" },
  { value: "open", labelKey: "filter.open", countKey: "count.open" },
  { value: "assigned", labelKey: "filter.assigned", countKey: "count.assigned" },
  { value: "closed", labelKey: "filter.closed", countKey: "count.closed" },
] as const satisfies readonly {
  value: ModerationQueueFilter;
  labelKey: string;
  countKey: string;
}[];

let viewSeq = 0;

type Write = WorkflowWrite | ActionWrite;
const isAction = (w: Write): w is ActionWrite =>
  w.kind !== "assign" && w.kind !== "note" && w.kind !== "close";

interface ReportsView {
  readonly deny: () => void;
  /** Open a report by id, kept open outside the filter (an appeal's link). */
  readonly openLinked: (id: string) => void;
}

/** A removal's refusal: the channel's rules, the reader's bit, or the server's own words. */
function removalRefusal(message: string): string {
  if (message === "forbidden: channel is archived") return t("act.refusedArchived");
  if (message === "forbidden: cannot delete this message") return t("act.refusedRemoval");
  return message === "" ? t("act.unknown") : t("act.invalid", { message });
}

const TABS = ["reports", "appeals"] as const;

export function renderModerationCenter(root: HTMLElement, ctx: FeatureViewContext): void {
  const seq = ++viewSeq;
  const tablist = createElement("div", {
    class: "mod-tabs",
    role: "tablist",
    "aria-label": t("tabs.label"),
  });
  const tabs = TABS.map((name) =>
    createElement(
      "button",
      {
        type: "button",
        class: "mod-tab",
        role: "tab",
        id: `mod-tab-${seq}-${name}`,
        "aria-controls": `mod-panel-${seq}-${name}`,
        "data-testid": `mod-tab-${name}`,
      },
      t(name === "reports" ? "tabs.reports" : "tabs.appeals"),
    ),
  );
  const panels = TABS.map((name) =>
    createElement("div", {
      class: "mod-panel",
      role: "tabpanel",
      id: `mod-panel-${seq}-${name}`,
      "aria-labelledby": `mod-tab-${seq}-${name}`,
    }),
  );
  tablist.append(...tabs);
  appendChildren(root, tablist, ...panels);

  let appeals: AppealsView | null = null;
  const reports = renderReports(panels[0]!, ctx, () => appeals?.deny());

  /** Show one tab; activation follows focus (the WAI-ARIA tabs pattern). */
  function choose(index: number, focus: boolean): void {
    tabs.forEach((tab, i) => {
      tab.setAttribute("aria-selected", String(i === index));
      tab.tabIndex = i === index ? 0 : -1;
      panels[i]!.hidden = i !== index;
    });
    if (focus) tabs[index]!.focus();
    if (index === 1 && appeals === null) {
      appeals = renderAppeals(panels[1]!, ctx, {
        onDenied: reports.deny,
        openReport: (id) => {
          choose(0, false);
          // The appeal's control is now hidden: let the report take focus.
          (document.activeElement as HTMLElement | null)?.blur();
          reports.openLinked(id);
        },
      });
    }
  }
  const { signal } = ctx;
  tabs.forEach((tab, i) => tab.addEventListener("click", () => choose(i, false), { signal }));
  tablist.addEventListener(
    "keydown",
    (e: KeyboardEvent) => {
      const at = tabs.indexOf(document.activeElement as HTMLButtonElement);
      if (at < 0) return;
      const to =
        e.key === "ArrowRight"
          ? (at + 1) % tabs.length
          : e.key === "ArrowLeft"
            ? (at + tabs.length - 1) % tabs.length
            : e.key === "Home"
              ? 0
              : e.key === "End"
                ? tabs.length - 1
                : -1;
      if (to < 0) return;
      e.preventDefault();
      choose(to, true);
    },
    { signal },
  );
  signal.addEventListener("abort", () => clearChildren(root), { once: true });
  choose(0, false);
}

function actionErrorText(w: ActionWrite, err: unknown): string {
  if (isStatus(err, 403, "SELF_REVIEW")) return t("write.selfReview");
  if (isStatus(err, 403)) {
    // Kick and ban each have their own bit, which a role change can take
    // while MODERATE_MEMBERS stays, so a refusal is not only about rank.
    if (w.kind === "removal") return removalRefusal((err as ApiClientError).message);
    return t(w.kind === "kick" || w.kind === "ban" ? "act.refusedEnforce" : "act.refused");
  }
  if (isStatus(err, 404) && w.kind === "lift") return t("act.liftNone");
  // 409 ALREADY_DELETED (B9-14's removal of an already-removed message): a
  // known end state, not the uncertain "may still have been recorded" answer.
  if (isStatus(err, 409, "ALREADY_DELETED")) return t("act.alreadyDeleted");
  if (isStatus(err, 400) && (err as ApiClientError).message !== "") {
    return t("act.invalid", { message: (err as ApiClientError).message });
  }
  // No answer, or an internal failure: the action may still have been recorded.
  return err instanceof ApiClientError ? errorText(err, t("act.unknown")) : t("act.unknown");
}

function renderReports(
  root: HTMLElement,
  ctx: FeatureViewContext,
  onDenied: () => void,
): ReportsView {
  const { signal, api } = ctx;
  let filter: (typeof FILTERS)[number] = FILTERS[0];
  let items: readonly QueueItem[] = [];
  let selected: string | null = null;
  let shown: ReportDetail | null = null;
  let reportHeading: HTMLElement | null = null;
  let gate: MountableComponent | null = null;
  let listReq: Disposable | null = null;
  let detailReq: Disposable | null = null;
  let detailFocus = false;
  let denied = false;
  /** The unsaved note and chosen outcome, for the report they were entered on. */
  const NO_DRAFT = { id: "", text: "", outcome: null as ModerationOutcome | null };
  let draft = NO_DRAFT;
  /** The unsaved action reasons and length, for the report they were entered on. */
  let actDraft: ActionDraft & { id: string } = { id: "", ...emptyActionDraft() };
  const dropActDraft = (): void => {
    actDraft = { id: "", ...emptyActionDraft() };
  };
  /** A write being sent, or its answer waiting on the re-read of the report. */
  let writing: "sending" | "reading" | null = null;
  /** A report this reader is writing to: leaving the filter is expected, not news. */
  let ownWrite: string | null = null;
  /** The open report, kept after the reader's own write took it out of the filter. */
  let offList: QueueItem | null = null;
  /** A report opened by id from an appeal, kept open whatever the filter. */
  let linked: string | null = null;

  const filterId = `mod-filter-${++viewSeq}`;
  const toolbar = createElement("div", { class: "mod-center-toolbar" });
  const select = createElement("select", {
    id: filterId,
    class: "form-input",
    "data-testid": "mod-filter",
  });
  for (const f of FILTERS)
    select.appendChild(createElement("option", { value: f.value }, t(f.labelKey)));
  appendChildren(toolbar, createElement("label", { for: filterId }, t("filter.label")), select);
  // Live regions exist before their text changes, so each change is read.
  const status = createElement("p", {
    class: "mod-center-status",
    role: "status",
    "data-testid": "mod-status",
  });
  const failure = createElement("p", { class: "form-error", role: "alert" });
  const retry = createElement("button", { type: "button", class: "btn-modal-save" }, t("retry"));
  retry.hidden = true;
  const list = createElement("ul", {
    class: "mod-queue",
    "aria-label": t("list.label"),
    "data-testid": "mod-queue",
  });
  const detailStatus = createElement("p", { class: "mod-center-status", role: "status" });
  const detailFailure = createElement("p", { class: "form-error", role: "alert" });
  const detailRetry = createElement(
    "button",
    { type: "button", class: "btn-modal-save" },
    t("retry"),
  );
  detailRetry.hidden = true;
  const detailSlot = createElement("div", { class: "mod-report-slot" });
  const writeStatus = createElement("p", {
    class: "mod-center-status",
    role: "status",
    "data-testid": "mod-write-status",
  });
  const writeAlert = createElement("p", { class: "form-error", role: "alert" });
  appendChildren(
    root,
    createElement("p", { class: "mod-center-intro" }, t("intro")),
    toolbar,
    status,
    failure,
    retry,
    list,
    detailStatus,
    detailFailure,
    detailRetry,
    writeStatus,
    writeAlert,
    detailSlot,
  );

  const itemFor = (id: string): QueueItem | undefined =>
    items.find((i) => i.id === id) ?? (offList?.id === id ? offList : undefined);

  const rowFor = (id: string | null): HTMLButtonElement | null =>
    id === null
      ? null
      : ([...list.querySelectorAll<HTMLButtonElement>("button[data-report-id]")].find(
          (b) => b.dataset.reportId === id,
        ) ?? null);

  /** Focus somewhere that stays: the row for `id`, else the first row, else the filter. */
  function focusList(id: string | null): void {
    (rowFor(id) ?? list.querySelector<HTMLButtonElement>("button") ?? select).focus();
  }

  function syncCurrent(): void {
    for (const b of list.querySelectorAll<HTMLButtonElement>("button[data-report-id]")) {
      if (b.dataset.reportId === selected) b.setAttribute("aria-current", "true");
      else b.removeAttribute("aria-current");
    }
  }

  /** Remove the open report from the DOM and from memory. */
  function dropDetail(): void {
    detailReq?.destroy();
    detailReq = null;
    gate?.destroy?.();
    gate = null;
    clearChildren(detailSlot);
    shown = null;
  }

  function setDetailError(message: string): void {
    setText(detailFailure, message);
    detailRetry.hidden = message === "";
  }

  /** The report read that follows a write has settled or been dropped. */
  function readSettled(): void {
    if (writing === "reading") writing = null;
  }

  /** Close the open report, saying why, and keep focus in the view. */
  function clearDetail(message: string): void {
    const hadFocus =
      detailSlot.contains(document.activeElement) || detailRetry === document.activeElement;
    const was = selected;
    readSettled();
    dropDetail();
    selected = null;
    ownWrite = null;
    offList = null;
    linked = null;
    draft = NO_DRAFT;
    dropActDraft();
    syncCurrent();
    setDetailError("");
    setText(detailStatus, message);
    if (hadFocus) focusList(was);
  }

  /** The server refused: nothing the reader held stays on screen. */
  function deny(): void {
    if (denied) return;
    const hadFocus = root.contains(document.activeElement);
    denied = true;
    writing = null;
    listReq?.destroy();
    listReq = null;
    dropDetail();
    items = [];
    selected = null;
    ownWrite = null;
    offList = null;
    draft = NO_DRAFT;
    dropActDraft();
    clearChildren(list);
    for (const el of [toolbar, list, retry, detailRetry]) el.hidden = true;
    for (const el of [status, detailStatus, detailFailure, writeStatus, writeAlert])
      setText(el, "");
    setText(failure, t("denied"));
    if (hadFocus) {
      root.closest(".feature-view")?.querySelector<HTMLElement>(".feature-view-title")?.focus();
    }
    onDenied();
  }

  function renderRow(item: QueueItem): HTMLLIElement {
    const li = createElement("li");
    const what = reportTitle(item);
    const who = t("row.who", {
      subject: nameText(item.subjectName),
      reporter: nameText(item.reporterName),
    });
    const state = stateText(item);
    const when = t("row.filed", { date: dateText(item.createdAt) });
    const button = createElement("button", {
      type: "button",
      class: "mod-queue-row",
      "data-report-id": item.id,
      "data-testid": "mod-queue-row",
      // Spans carry no separators of their own, so name the button in full.
      "aria-label": `${what}. ${who}. ${state}. ${when}`,
    });
    appendChildren(
      button,
      createElement("span", { class: "mod-queue-what" }, what),
      createElement("span", { class: "mod-queue-who" }, who),
      createElement("span", { class: "mod-queue-state" }, state),
      createElement("span", { class: "mod-queue-when" }, when),
    );
    button.addEventListener("click", () => open(item.id), { signal });
    li.appendChild(button);
    return li;
  }

  function renderList(): void {
    const focused = list.contains(document.activeElement)
      ? ((document.activeElement as HTMLElement).dataset.reportId ?? null)
      : undefined;
    clearChildren(list);
    list.append(...items.map(renderRow));
    list.hidden = items.length === 0;
    syncCurrent();
    if (focused !== undefined) focusList(focused);
  }

  function loadList(announce: boolean, refreshDetail: boolean): void {
    if (denied) return;
    listReq?.destroy();
    const req = new Disposable();
    listReq = req;
    const forFilter = filter;
    list.setAttribute("aria-busy", "true");
    if (announce) setText(status, t("list.loading"));
    api.getModerationQueue(forFilter.value, req.signal).then(
      (rows) => {
        if (req !== listReq || signal.aborted) return;
        listReq = null;
        list.removeAttribute("aria-busy");
        const retryHadFocus = document.activeElement === retry;
        const was = selected === null ? undefined : itemFor(selected);
        items = rows.map(mapQueueRow);
        renderList();
        setText(failure, "");
        retry.hidden = true;
        setText(status, t(forFilter.countKey, { count: items.length }));
        if (retryHadFocus) focusList(null);
        if (selected !== null) {
          if (items.some((i) => i.id === selected)) {
            offList = null;
            if (refreshDetail) loadDetail(selected, false);
          } else if (
            was !== undefined &&
            (selected === ownWrite || selected === linked || offList === was)
          ) {
            if (offList === null) setText(detailStatus, t("detail.leftFilter"));
            offList = was;
            if (refreshDetail) loadDetail(selected, false);
          } else if (selected !== linked) {
            clearDetail(t("detail.gone"));
          }
        }
        if (writing !== "sending") ownWrite = null;
      },
      (err: unknown) => {
        if (req !== listReq || signal.aborted) return;
        listReq = null;
        list.removeAttribute("aria-busy");
        if (isStatus(err, 403)) {
          deny();
          return;
        }
        setText(status, "");
        setText(failure, t("list.error"));
        retry.hidden = false;
      },
    );
  }

  function mountGate(slot: HTMLElement, channelId: number, channelName: string): void {
    const forReport = shown;
    import("@components/NsfwGate").then(
      (ui) => {
        if (signal.aborted || shown !== forReport || !slot.isConnected) return;
        gate = ui.createNsfwGate({
          channelName,
          focusOnMount: false,
          // Consent is recorded with the server first; only then is the
          // evidence read again, and the server decides what it returns.
          onAccept: () =>
            api.acknowledgeNsfw(channelId, signal).then(() => {
              if (signal.aborted) return;
              setNsfwAcknowledged(channelId, true);
              if (forReport !== null && selected === forReport.id) loadDetail(forReport.id, true);
            }),
          onCancel: closeToRow,
        });
        gate.mount(slot);
      },
      () => {
        if (!signal.aborted && shown === forReport) setDetailError(t("detail.error"));
      },
    );
  }

  function showDetail(item: QueueItem, detail: ReportDetail, takeFocus: boolean): void {
    const active = document.activeElement;
    const hadFocus = detailSlot.contains(active);
    const retryHadFocus = active === detailRetry;
    // A re-read rebuilds the report: put focus back on the same control.
    const focusKey = hadFocus && active instanceof HTMLElement ? active.dataset.focus : undefined;
    const typed =
      active instanceof HTMLTextAreaElement ||
      (active instanceof HTMLInputElement && active.type === "text");
    const caret = typed ? ([active.selectionStart, active.selectionEnd] as const) : null;
    dropDetail();
    shown = detail;
    const view = buildReportDetail(item, detail, mountGate);
    reportHeading = view.heading;
    const me = authStore.getState().user?.id ?? -1;
    view.element.append(...buildHistory(detail, me));
    const mine = draft.id === detail.id ? draft : NO_DRAFT;
    const work = buildWorkflow({
      detail,
      me,
      draft: mine.text,
      onDraft: (text) => {
        draft = { ...draft, id: detail.id, text };
      },
      outcome: mine.outcome,
      onOutcome: (outcome) => {
        draft = { ...draft, id: detail.id, outcome };
      },
      onWrite: (w) => write(detail.id, w),
      signal,
    });
    view.element.appendChild(work.element);
    if (draft.id === detail.id && !work.takesNotes) {
      if (draft.text.trim() !== "") setText(writeAlert, t("draft.lost"));
      draft = NO_DRAFT;
    }
    if (actDraft.id !== detail.id) actDraft = { id: detail.id, ...emptyActionDraft() };
    const acts = buildActionForms({
      detail,
      me,
      draft: actDraft,
      onWrite: (w) => write(detail.id, w),
      signal,
      refocus: (key) =>
        detailSlot.querySelector<HTMLElement>(`[data-focus="${key}"]`) ?? reportHeading,
    });
    if (acts.element !== null) view.element.appendChild(acts.element);
    if (!acts.takesInput) {
      if (`${actDraft.warn}${actDraft.reason}${actDraft.enforce}`.trim() !== "")
        setText(writeAlert, t("act.draftLost"));
      actDraft = { id: detail.id, ...emptyActionDraft() };
    }
    view.element.addEventListener(
      "keydown",
      (e: KeyboardEvent) => {
        // Escape closes the report first; the view's own Escape is the next one.
        if (e.key !== "Escape" || e.defaultPrevented) return;
        e.preventDefault();
        closeToRow();
      },
      { signal },
    );
    detailSlot.appendChild(view.element);
    const again =
      focusKey === undefined || takeFocus
        ? null
        : view.element.querySelector<HTMLElement>(`[data-focus="${focusKey}"]`);
    if (again !== null) {
      again.focus();
      if (
        caret !== null &&
        (again instanceof HTMLTextAreaElement || again instanceof HTMLInputElement)
      ) {
        again.setSelectionRange(caret[0], caret[1]);
      }
    } else if (takeFocus || hadFocus || retryHadFocus) view.heading.focus();
  }

  const WRITE_DONE = { assign: "done.assign", note: "done.note", close: "done.close" } as const;

  function send(id: string, w: Write): Promise<unknown> {
    if (w.kind === "assign") return api.assignModerationReport(id, signal);
    if (w.kind === "note") return api.addModerationNote(id, w.body, signal);
    if (w.kind === "close") return api.closeModerationReport(id, w.outcome, signal);
    if (w.kind === "lift") return api.liftTimeout(w.userId, signal);
    const body: ModerationActRequest =
      w.kind === "timeout"
        ? { kind: "timeout", reason: w.reason, duration_seconds: w.amount * UNITS[w.unit].seconds }
        : { kind: w.kind, reason: w.reason };
    return api.actOnModerationReport(id, body, signal);
  }

  /** What the server's answer means; a timeout's voice half is "applied" only when it says so. */
  function doneText(w: Write, answer: unknown): string {
    if (w.kind === "warning") return t("done.warning");
    if (w.kind === "lift") return t("done.lift");
    if (w.kind === "removal" || w.kind === "kick" || w.kind === "ban")
      return t(ENFORCE[w.kind].doneKey);
    if (w.kind === "timeout") {
      const length = t(UNITS[w.unit].lengthKey, { count: w.amount });
      const voice = (answer as { voice?: unknown } | undefined)?.voice;
      return t(voice === "applied" ? "done.timeoutApplied" : "done.timeoutSkipped", { length });
    }
    return t(WRITE_DONE[w.kind]);
  }

  function reviewErrorText(w: WorkflowWrite, err: unknown): string {
    if (isStatus(err, 409)) return t(WRITE_CONFLICT[w.kind]);
    if (isStatus(err, 403)) return t("write.selfReview");
    return t(isStatus(err, 400) ? "write.invalid" : "write.error");
  }

  const WRITE_CONFLICT = {
    assign: "conflict.assign",
    note: "conflict.note",
    close: "conflict.close",
  } as const;

  /** Read the queue and the report again after a write; the next write waits for the report. */
  function reread(id: string): void {
    writing = "reading";
    loadList(false, false);
    loadDetail(id, false);
  }

  /** Send one review write, then read the report again whatever the answer. */
  function write(id: string, w: Write): boolean {
    if (writing !== null || denied) return false;
    writing = "sending";
    ownWrite = id;
    const keptBefore = offList;
    setText(writeStatus, "");
    setText(writeAlert, "");
    send(id, w).then(
      (answer) => {
        if (signal.aborted || denied) return;
        if (w.kind === "note" && draft.id === id) draft = { ...draft, text: "" };
        if (actDraft.id === id && w.kind === "warning") actDraft.warn = "";
        if (actDraft.id === id && w.kind === "timeout") {
          actDraft.reason = "";
          actDraft.amount = "";
        }
        if (actDraft.id === id && (w.kind === "removal" || w.kind === "kick" || w.kind === "ban"))
          actDraft.enforce = "";
        if (selected !== id) {
          writing = null;
          return;
        }
        ownWrite = id;
        setText(writeStatus, doneText(w, answer));
        reread(id);
      },
      (err: unknown) => {
        if (signal.aborted || denied) return;
        ownWrite = null;
        if (offList !== keptBefore) {
          offList = null;
          setText(detailStatus, "");
        }
        if (isStatus(err, 403) && !isStatus(err, 403, "SELF_REVIEW") && !isAction(w)) {
          deny();
          return;
        }
        if (selected !== id) {
          writing = null;
          return;
        }
        if (isStatus(err, 404) && w.kind !== "lift") {
          writing = null;
          clearDetail(t("detail.notFound"));
          loadList(false, false);
          return;
        }
        setText(writeAlert, isAction(w) ? actionErrorText(w, err) : reviewErrorText(w, err));
        reread(id);
      },
    );
    return true;
  }

  function closeToRow(): void {
    const was = selected;
    clearDetail("");
    focusList(was);
  }

  function loadDetail(id: string, askedFocus: boolean): void {
    const takeFocus = askedFocus || (detailReq !== null && detailFocus);
    detailReq?.destroy();
    const req = new Disposable();
    detailReq = req;
    detailFocus = takeFocus;
    setDetailError("");
    if (takeFocus) {
      gate?.destroy?.();
      gate = null;
      clearChildren(detailSlot);
      shown = null;
      setText(detailStatus, t("detail.loading"));
    }
    detailSlot.setAttribute("aria-busy", "true");
    api.getModerationReport(id, req.signal).then(
      (wire) => {
        if (req !== detailReq || signal.aborted || selected !== id) return;
        detailReq = null;
        readSettled();
        detailSlot.removeAttribute("aria-busy");
        let item = itemFor(id);
        if (item === undefined && linked === id) {
          item = itemFromDetail(wire, memberName);
          offList = item;
        }
        if (item === undefined) {
          clearDetail(t("detail.gone"));
          return;
        }
        // Only move focus if the reader is still where they asked from.
        const active = document.activeElement;
        const stayed =
          active === null ||
          active === document.body ||
          active === rowFor(id) ||
          detailSlot.contains(active);
        if (takeFocus) setText(detailStatus, "");
        showDetail(item, mapDetail(wire), takeFocus && stayed);
      },
      (err: unknown) => {
        if (req !== detailReq || signal.aborted || selected !== id) return;
        detailReq = null;
        readSettled();
        detailSlot.removeAttribute("aria-busy");
        if (isStatus(err, 403)) {
          deny();
          return;
        }
        if (isStatus(err, 404)) {
          clearDetail(t("detail.notFound"));
          loadList(false, false);
          return;
        }
        const hadFocus = detailSlot.contains(document.activeElement);
        dropDetail();
        setText(detailStatus, "");
        setDetailError(t("detail.error"));
        if (hadFocus) detailRetry.focus();
      },
    );
  }

  function open(id: string): void {
    if (denied) return;
    if (selected === id && shown !== null) {
      detailSlot.querySelector<HTMLElement>("h3")?.focus();
      return;
    }
    if (draft.id !== id) draft = NO_DRAFT;
    if (actDraft.id !== id) dropActDraft();
    setText(writeStatus, "");
    setText(writeAlert, "");
    selected = id;
    syncCurrent();
    loadDetail(id, true);
  }

  select.addEventListener(
    "change",
    () => {
      filter = FILTERS.find((f) => f.value === select.value) ?? FILTERS[0];
      ownWrite = null;
      if (selected !== linked) offList = null;
      loadList(true, false);
    },
    { signal },
  );
  retry.addEventListener("click", () => loadList(true, false), { signal });
  detailRetry.addEventListener(
    "click",
    () => {
      if (selected !== null) loadDetail(selected, true);
    },
    { signal },
  );

  /** The open report again, for a role change that moves what may be offered. */
  function reoffer(): void {
    const d = shown;
    // A write's re-read, or any read in flight, rebuilds it anyway.
    if (d === null || writing !== null || detailReq !== null) return;
    const item = itemFor(d.id);
    if (item !== undefined) showDetail(item, d, false);
  }

  const unsubs = [
    authStore.subscribeSelector((s) => s.user?.role ?? "", reoffer),
    channelsStore.subscribeSelector((s) => s.roles, reoffer),
    // mod_queue carries no report data: read the queue (and the open report) again.
    modQueueStore.subscribe(() => loadList(false, true)),
    // mod_queue is never replayed, so a reconnect reads again too.
    uiStore.subscribeSelector(
      (s) => s.connectionStatus,
      (st) => {
        if (st === "connected") loadList(false, true);
      },
    ),
    // Consent withdrawn (here or on another device): the evidence goes at once.
    channelsStore.subscribe(() => {
      const d = shown;
      if (d?.evidence.kind !== "shown" || d.channelId === null) return;
      if (!nsfwContentBlocked(d.channelId)) return;
      const item = itemFor(d.id);
      if (item === undefined) {
        clearDetail("");
        return;
      }
      showDetail(item, { ...d, evidence: { kind: "consent", channelId: d.channelId } }, false);
    }),
  ];

  signal.addEventListener(
    "abort",
    () => {
      for (const u of unsubs) u();
      listReq?.destroy();
      listReq = null;
      dropDetail();
      items = [];
      selected = null;
      offList = null;
      draft = NO_DRAFT;
      dropActDraft();
      clearChildren(root);
    },
    { once: true },
  );

  loadList(true, false);
  return {
    deny,
    openLinked: (id) => {
      if (denied) return;
      if (itemFor(id) === undefined) linked = id;
      open(id);
    },
  };
}
