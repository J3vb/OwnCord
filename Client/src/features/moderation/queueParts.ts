/**
 * DOM builders for the Moderation Center's report tab: the toolbar, status
 * lines and lists, and one queue row. They create elements; the view wires them.
 */

import { appendChildren, clearChildren, createElement, setText } from "@lib/dom";
import { isImeCommit } from "@lib/text/ime";
import { authStore } from "@stores/auth.store";
import { channelsStore, setNsfwAcknowledged } from "@stores/channels.store";
import { uiStore } from "@stores/ui.store";
import { moderationText as t } from "../../i18n/moderation";
import type { MountableComponent } from "@lib/text/safeRender";
import type { FeatureViewContext } from "../navigation/destinations";
import type { QueueItem, ReportDetail } from "./api";
import { buildActionForms, emptyActionDraft, type ActionWrite } from "./ActionForms";
import { buildWorkflow, type WorkflowWrite } from "./Workflow";
import { dateText, nameText, reportTitle, stateText } from "./Evidence";
import { modQueueStore } from "./store";
import { FILTERS, NO_DRAFT, nextViewSeq, type ReportDrafts } from "./queueModel";

/** The report tab's elements. */
export type ReportsDom = ReturnType<typeof buildReportsDom>;

/** Build the report tab's elements and append them to `root`. */
export function buildReportsDom(root: HTMLElement) {
  const filterId = `mod-filter-${nextViewSeq()}`;
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
  return {
    toolbar,
    select,
    status,
    failure,
    retry,
    list,
    detailStatus,
    detailFailure,
    detailRetry,
    detailSlot,
    writeStatus,
    writeAlert,
  };
}

/** The queue list: rows, the current mark and focus recovery. */
export function createQueueListView(
  list: HTMLElement,
  select: HTMLElement,
  signal: AbortSignal,
  onOpen: (id: string) => void,
) {
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

  /** Mark the row of the `selected` report as current. */
  function syncCurrent(selected: string | null): void {
    for (const b of list.querySelectorAll<HTMLButtonElement>("button[data-report-id]")) {
      if (b.dataset.reportId === selected) b.setAttribute("aria-current", "true");
      else b.removeAttribute("aria-current");
    }
  }

  /** Draw `items`, keeping focus on the row that held it. */
  function render(items: readonly QueueItem[], selected: string | null): void {
    const focused = list.contains(document.activeElement)
      ? ((document.activeElement as HTMLElement).dataset.reportId ?? null)
      : undefined;
    clearChildren(list);
    list.append(...items.map((item) => buildQueueRow(item, onOpen, signal)));
    list.hidden = items.length === 0;
    syncCurrent(selected);
    if (focused !== undefined) focusList(focused);
  }

  return { rowFor, focusList, syncCurrent, render };
}

/** One queue row: a button that opens the report. */
function buildQueueRow(
  item: QueueItem,
  onOpen: (id: string) => void,
  signal: AbortSignal,
): HTMLLIElement {
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
  button.addEventListener("click", () => onOpen(item.id), { signal });
  li.appendChild(button);
  return li;
}

/** Subscribe to everything that makes the report tab read or rebuild; returns
 *  the unsubscribers. */
export function subscribeQueueSources(handlers: {
  readonly reoffer: () => void;
  readonly reload: () => void;
  readonly onChannels: () => void;
}): (() => void)[] {
  return [
    authStore.subscribeSelector(
      (s) => `${s.user?.role ?? ""}|${s.user?.role_ids?.join(",") ?? ""}`,
      handlers.reoffer,
    ),
    channelsStore.subscribeSelector((s) => s.roles, handlers.reoffer),
    // mod_queue carries no report data: read the queue (and the open report) again.
    modQueueStore.subscribe(() => handlers.reload()),
    // mod_queue is never replayed, so a reconnect reads again too.
    uiStore.subscribeSelector(
      (s) => s.connectionStatus,
      (st) => {
        if (st === "connected") handlers.reload();
      },
    ),
    channelsStore.subscribe(() => handlers.onChannels()),
  ];
}

/** Empty the list and every status line once the server has refused the reader. */
export function blankDeniedDom(dom: ReportsDom, deniedText: string): void {
  clearChildren(dom.list);
  for (const el of [dom.toolbar, dom.list, dom.retry, dom.detailRetry]) el.hidden = true;
  for (const el of [
    dom.status,
    dom.detailStatus,
    dom.detailFailure,
    dom.writeStatus,
    dom.writeAlert,
  ])
    setText(el, "");
  setText(dom.failure, deniedText);
}

/** Focus the feature view's title, the nearest place that stays. */
export function focusFeatureTitle(root: HTMLElement): void {
  root.closest(".feature-view")?.querySelector<HTMLElement>(".feature-view-title")?.focus();
}

/** Whether the reader is still where they asked from: nowhere in particular,
 *  on the report's row or inside the open report. */
export function focusStayed(row: Element | null, detailSlot: HTMLElement): boolean {
  const active = document.activeElement;
  return (
    active === null || active === document.body || active === row || detailSlot.contains(active)
  );
}

/** Escape closes the report first; the view's own Escape is the next one. */
export function closeOnEscape(element: HTMLElement, close: () => void, signal: AbortSignal): void {
  element.addEventListener(
    "keydown",
    (e: KeyboardEvent) => {
      if (e.key !== "Escape" || isImeCommit(e) || e.defaultPrevented) return;
      e.preventDefault();
      close();
    },
    { signal },
  );
}

/** Load the age-restricted content gate lazily and mount it into `slot`. The
 *  gate is dropped when the view ended or `stillShown` says the report moved on. */
export function mountNsfwGate(args: {
  readonly slot: HTMLElement;
  readonly channelId: number;
  readonly channelName: string;
  readonly signal: AbortSignal;
  readonly api: FeatureViewContext["api"];
  readonly stillShown: () => boolean;
  readonly onGate: (gate: MountableComponent) => void;
  readonly onAccepted: () => void;
  readonly onCancel: () => void;
  readonly onFailed: () => void;
}): void {
  const { slot, channelId, channelName, signal, api } = args;
  import("../content-consent/NsfwGate").then(
    (ui) => {
      if (signal.aborted || !args.stillShown() || !slot.isConnected) return;
      const gate = ui.createNsfwGate({
        channelName,
        focusOnMount: false,
        // Consent is recorded with the server first; only then is the
        // evidence read again, and the server decides what it returns.
        onAccept: () =>
          api.acknowledgeNsfw(channelId, signal).then(() => {
            if (signal.aborted) return;
            setNsfwAcknowledged(channelId, true);
            args.onAccepted();
          }),
        onCancel: args.onCancel,
      });
      args.onGate(gate);
      gate.mount(slot);
    },
    () => {
      if (!signal.aborted && args.stillShown()) args.onFailed();
    },
  );
}

/** What the review and action controls need from the open report's view. */
export interface ControlsInput {
  readonly parent: HTMLElement;
  readonly detail: ReportDetail;
  readonly me: number;
  readonly drafts: ReportDrafts;
  readonly write: (id: string, w: WorkflowWrite | ActionWrite) => boolean;
  readonly signal: AbortSignal;
  /** Where a dropped draft is announced. */
  readonly alert: HTMLElement;
}

/** The review controls; a draft the review no longer takes is dropped with a notice. */
export function appendReviewControls(input: ControlsInput): void {
  const { parent, detail, me, drafts, write, signal, alert } = input;
  const draft = drafts.review();
  const mine = draft.id === detail.id ? draft : NO_DRAFT;
  const work = buildWorkflow({
    detail,
    me,
    draft: mine.text,
    onDraft: (text) => drafts.setReview({ ...drafts.review(), id: detail.id, text }),
    outcome: mine.outcome,
    onOutcome: (outcome) => drafts.setReview({ ...drafts.review(), id: detail.id, outcome }),
    onWrite: (w) => write(detail.id, w),
    signal,
  });
  parent.appendChild(work.element);
  const now = drafts.review();
  if (now.id === detail.id && !work.takesNotes) {
    if (now.text.trim() !== "") setText(alert, t("draft.lost"));
    drafts.setReview(NO_DRAFT);
  }
}

/** The moderator actions; reasons typed for actions no longer offered are dropped with a notice. */
export function appendActionControls(
  input: ControlsInput & {
    readonly slot: HTMLElement;
    readonly heading: () => HTMLElement | null;
  },
): void {
  const { parent, detail, me, drafts, write, signal, alert, slot, heading } = input;
  if (drafts.act().id !== detail.id) drafts.setAct({ id: detail.id, ...emptyActionDraft() });
  const acts = buildActionForms({
    detail,
    me,
    draft: drafts.act(),
    onWrite: (w) => write(detail.id, w),
    signal,
    refocus: (key) => slot.querySelector<HTMLElement>(`[data-focus="${key}"]`) ?? heading(),
  });
  if (acts.element !== null) parent.appendChild(acts.element);
  if (!acts.takesInput) {
    const act = drafts.act();
    if (`${act.warn}${act.reason}${act.enforce}`.trim() !== "") setText(alert, t("act.draftLost"));
    drafts.setAct({ id: detail.id, ...emptyActionDraft() });
  }
}
