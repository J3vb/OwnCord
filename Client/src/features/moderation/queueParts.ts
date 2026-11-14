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
import { nextViewSeq } from "./queueModel";
import { FILTERS, NO_DRAFT, type ReportDrafts } from "./queueModel";

export type TextKey = Parameters<typeof t>[0];

/** What differs between the tabs' toolbars and status lines. */
export interface QueueDomSpec {
  readonly introKey: TextKey;
  readonly listLabelKey: TextKey;
  readonly filters: readonly { readonly value: string; readonly labelKey: TextKey }[];
  /** Names the tab's test ids and its filter id: `<prefix>-filter`, `-status`, `-queue`, `-write-status`. */
  readonly idPrefix: string;
}

/** A tab's elements. */
export type QueueDom = ReturnType<typeof buildQueueDom>;

/** Build a tab's elements and append them to `root`. */
export function buildQueueDom(root: HTMLElement, spec: QueueDomSpec) {
  const filterId = `${spec.idPrefix}-filter-${nextViewSeq()}`;
  const toolbar = createElement("div", { class: "mod-center-toolbar" });
  const select = createElement("select", {
    id: filterId,
    class: "form-input",
    "data-testid": `${spec.idPrefix}-filter`,
  });
  for (const f of spec.filters)
    select.appendChild(createElement("option", { value: f.value }, t(f.labelKey)));
  appendChildren(toolbar, createElement("label", { for: filterId }, t("filter.label")), select);
  // Live regions exist before their text changes, so each change is read.
  const status = createElement("p", {
    class: "mod-center-status",
    role: "status",
    "data-testid": `${spec.idPrefix}-status`,
  });
  const failure = createElement("p", { class: "form-error", role: "alert" });
  const retry = createElement("button", { type: "button", class: "btn-modal-save" }, t("retry"));
  retry.hidden = true;
  const list = createElement("ul", {
    class: "mod-queue",
    "aria-label": t(spec.listLabelKey),
    "data-testid": `${spec.idPrefix}-queue`,
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
    "data-testid": `${spec.idPrefix}-write-status`,
  });
  const writeAlert = createElement("p", { class: "form-error", role: "alert" });
  appendChildren(
    root,
    createElement("p", { class: "mod-center-intro" }, t(spec.introKey)),
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

/** What the shared requests need from a row list. */
export interface QueueListView {
  readonly rowFor: (id: string | null) => Element | null;
  readonly focusList: (id: string | null) => void;
  readonly syncCurrent: (selected: string | null) => void;
}

/** The row list: rows, the current mark and focus recovery. */
/** `idAttr` is the data attribute that names a row's item, such as `data-report-id`. */
export function createQueueListView<Item extends { readonly id: string }>(args: {
  readonly list: HTMLElement;
  readonly select: HTMLElement;
  readonly signal: AbortSignal;
  readonly idAttr: string;
  readonly buildRow: (
    item: Item,
    onOpen: (id: string) => void,
    signal: AbortSignal,
  ) => HTMLLIElement;
  readonly onOpen: (id: string) => void;
}) {
  const { list, select, signal, idAttr, buildRow, onOpen } = args;
  const rows = (): HTMLButtonElement[] => [
    ...list.querySelectorAll<HTMLButtonElement>(`button[${idAttr}]`),
  ];
  const rowFor = (id: string | null): HTMLButtonElement | null =>
    id === null ? null : (rows().find((b) => b.getAttribute(idAttr) === id) ?? null);

  /** Focus somewhere that stays: the row for `id`, else the first row, else the filter. */
  function focusList(id: string | null): void {
    (rowFor(id) ?? list.querySelector<HTMLButtonElement>("button") ?? select).focus();
  }

  /** Mark the row of the `selected` item as current. */
  function syncCurrent(selected: string | null): void {
    for (const b of rows()) {
      if (b.getAttribute(idAttr) === selected) b.setAttribute("aria-current", "true");
      else b.removeAttribute("aria-current");
    }
  }

  /** Draw `items`, keeping focus on the row that held it. */
  function render(items: readonly Item[], selected: string | null): void {
    const focused = list.contains(document.activeElement)
      ? ((document.activeElement as HTMLElement).getAttribute(idAttr) ?? null)
      : undefined;
    clearChildren(list);
    list.append(...items.map((item) => buildRow(item, onOpen, signal)));
    list.hidden = items.length === 0;
    syncCurrent(selected);
    if (focused !== undefined) focusList(focused);
  }

  return { rowFor, focusList, syncCurrent, render };
}

/** Empty the list and every status line once the server has refused the reader. */
export function blankDeniedDom(dom: QueueDom, deniedText: string): void {
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
 *  on the item's row or inside the open detail. */
export function focusStayed(row: Element | null, detailSlot: HTMLElement): boolean {
  const active = document.activeElement;
  return (
    active === null || active === document.body || active === row || detailSlot.contains(active)
  );
}

/** Escape closes the detail first; the view's own Escape is the next one. */
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

/** The report tab's elements. */
export type ReportsDom = QueueDom;

/** Build the report tab's elements and append them to `root`. */
export function buildReportsDom(root: HTMLElement): ReportsDom {
  return buildQueueDom(root, {
    introKey: "intro",
    listLabelKey: "list.label",
    filters: FILTERS,
    idPrefix: "mod",
  });
}

/** One queue row: a button, named in full, whose spans are `parts` as [class suffix, text]. */
export function buildRowItem(args: {
  readonly id: string;
  readonly idAttr: string;
  readonly testId: string;
  readonly parts: readonly (readonly [string, string])[];
  readonly onOpen: (id: string) => void;
  readonly signal: AbortSignal;
}): HTMLLIElement {
  const li = createElement("li");
  const button = createElement("button", {
    type: "button",
    class: "mod-queue-row",
    [args.idAttr]: args.id,
    "data-testid": args.testId,
    // Spans carry no separators of their own, so name the button in full.
    "aria-label": args.parts.map(([, text]) => text).join(". "),
  });
  appendChildren(
    button,
    ...args.parts.map(([cls, text]) => createElement("span", { class: `mod-queue-${cls}` }, text)),
  );
  button.addEventListener("click", () => args.onOpen(args.id), { signal: args.signal });
  li.appendChild(button);
  return li;
}

/** One report row. */
export function buildQueueRow(
  item: QueueItem,
  onOpen: (id: string) => void,
  signal: AbortSignal,
): HTMLLIElement {
  return buildRowItem({
    id: item.id,
    idAttr: "data-report-id",
    testId: "mod-queue-row",
    parts: [
      ["what", reportTitle(item)],
      [
        "who",
        t("row.who", {
          subject: nameText(item.subjectName),
          reporter: nameText(item.reporterName),
        }),
      ],
      ["state", stateText(item)],
      ["when", t("row.filed", { date: dateText(item.createdAt) })],
    ],
    onOpen,
    signal,
  });
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
