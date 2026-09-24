/**
 * The Moderation Center's Appeals tab (B9-17): the appeal queue and the
 * selected appeal, for MODERATE_MEMBERS holders. Queue.ts renders it the
 * first time the tab is chosen, so no appeal is read before that.
 *
 * The server authorizes everything here, as in the report queue. The list is
 * GET /moderation/appeals, which never includes the reader's own appeals; the
 * detail is a separate read per appeal. A 403 clears the whole Moderation
 * Center, except SELF_REVIEW on the reader's own appeal, which says so. A 404
 * is an appeal that is gone.
 *
 * Every request is bound to the view's signal and to the appeal or filter it
 * was made for, so a late answer is dropped. mod_queue appeal frames and a
 * reconnect only trigger a fresh read. The open appeal stays open while its
 * own read succeeds, even when it leaves the current filter, so a decision
 * shows the result the server recorded.
 *
 * Taking and deciding are single writes, one at a time; whatever the answer,
 * the queue and the appeal are read again. Nothing is reported as done before
 * the server answers, and a refusal (SELF_REVIEW, a conflict, REVERSAL_FAILED)
 * says that nothing was recorded. An unsaved decision lives only while the
 * appeal can still take it and the view is live.
 */

import { ApiClientError, type ModerationAppealFilter } from "@lib/api";
import { Disposable } from "@lib/disposable";
import { appendChildren, clearChildren, createElement, setText } from "@lib/dom";
import { authStore } from "@stores/auth.store";
import { uiStore } from "@stores/ui.store";
import { moderationText as t } from "../../i18n/moderation";
import type { FeatureViewContext } from "../navigation/destinations";
import {
  appealStateText,
  buildAppealDetail,
  personText,
  type AppealDraft,
  type AppealWrite,
} from "./AppealDetail";
import { mapAppealDetail, mapAppealRow, type AppealDetail, type AppealItem } from "./api";
import { dateText } from "./Evidence";
import { modAppealStore } from "./store";

const FILTERS = [
  { value: "", labelKey: "appeal.filter.active", countKey: "appeal.count.active" },
  { value: "open", labelKey: "appeal.filter.open", countKey: "appeal.count.open" },
  { value: "assigned", labelKey: "appeal.filter.assigned", countKey: "appeal.count.assigned" },
  { value: "decided", labelKey: "appeal.filter.decided", countKey: "appeal.count.decided" },
] as const satisfies readonly {
  value: ModerationAppealFilter;
  labelKey: string;
  countKey: string;
}[];

export interface AppealsView {
  /** The other tab lost authority: clear this one too. */
  readonly deny: () => void;
}

export interface AppealsOptions {
  /** This tab lost authority: clear the other one too. */
  readonly onDenied: () => void;
  /** Open a linked report in Reports. */
  readonly openReport: (id: string) => void;
}

let viewSeq = 0;

const me = (): number => authStore.getState().user?.id ?? -1;
const NO_DRAFT = (): AppealDraft & { id: string } => ({ id: "", note: "", outcome: null });

function isStatus(err: unknown, status: number, code?: string): boolean {
  return (
    err instanceof ApiClientError &&
    err.status === status &&
    (code === undefined || err.code === code)
  );
}

export function renderAppeals(
  root: HTMLElement,
  ctx: FeatureViewContext,
  opts: AppealsOptions,
): AppealsView {
  const { signal, api } = ctx;
  let filter: (typeof FILTERS)[number] = FILTERS[0];
  let items: readonly AppealItem[] = [];
  let selected: string | null = null;
  let shown: AppealDetail | null = null;
  let listReq: Disposable | null = null;
  let detailReq: Disposable | null = null;
  let detailFocus = false;
  let denied = false;
  /** The unsaved decision, for the appeal it was entered on. */
  let draft = NO_DRAFT();
  /** A write being sent, or its answer waiting on the re-read of the appeal. */
  let writing: "sending" | "reading" | null = null;

  const filterId = `mod-appeal-filter-${++viewSeq}`;
  const toolbar = createElement("div", { class: "mod-center-toolbar" });
  const select = createElement("select", {
    id: filterId,
    class: "form-input",
    "data-testid": "mod-appeal-filter",
  });
  for (const f of FILTERS)
    select.appendChild(createElement("option", { value: f.value }, t(f.labelKey)));
  appendChildren(toolbar, createElement("label", { for: filterId }, t("filter.label")), select);
  // Live regions exist before their text changes, so each change is read.
  const status = createElement("p", {
    class: "mod-center-status",
    role: "status",
    "data-testid": "mod-appeal-status",
  });
  const failure = createElement("p", { class: "form-error", role: "alert" });
  const retry = createElement("button", { type: "button", class: "btn-modal-save" }, t("retry"));
  retry.hidden = true;
  const list = createElement("ul", {
    class: "mod-queue",
    "aria-label": t("appeal.list.label"),
    "data-testid": "mod-appeal-queue",
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
    "data-testid": "mod-appeal-write-status",
  });
  const writeAlert = createElement("p", { class: "form-error", role: "alert" });
  appendChildren(
    root,
    createElement("p", { class: "mod-center-intro" }, t("appeal.intro")),
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

  const rowFor = (id: string | null): HTMLButtonElement | null =>
    id === null
      ? null
      : ([...list.querySelectorAll<HTMLButtonElement>("button[data-appeal-id]")].find(
          (b) => b.dataset.appealId === id,
        ) ?? null);

  /** Focus somewhere that stays: the row for `id`, else the first row, else the filter. */
  function focusList(id: string | null): void {
    (rowFor(id) ?? list.querySelector<HTMLButtonElement>("button") ?? select).focus();
  }

  function syncCurrent(): void {
    for (const b of list.querySelectorAll<HTMLButtonElement>("button[data-appeal-id]")) {
      if (b.dataset.appealId === selected) b.setAttribute("aria-current", "true");
      else b.removeAttribute("aria-current");
    }
  }

  /** Remove the open appeal from the DOM and from memory. */
  function dropDetail(): void {
    detailReq?.destroy();
    detailReq = null;
    clearChildren(detailSlot);
    shown = null;
  }

  function setDetailError(message: string): void {
    setText(detailFailure, message);
    detailRetry.hidden = message === "";
  }

  /** Close the open appeal, saying why, and keep focus in the view. */
  function clearDetail(message: string): void {
    const hadFocus =
      detailSlot.contains(document.activeElement) || detailRetry === document.activeElement;
    const was = selected;
    if (writing === "reading") writing = null;
    dropDetail();
    selected = null;
    draft = NO_DRAFT();
    syncCurrent();
    setDetailError("");
    setText(detailStatus, message);
    if (hadFocus) focusList(was);
  }

  /** The server refused: nothing the reader held stays on screen, here or in Reports. */
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
    draft = NO_DRAFT();
    clearChildren(list);
    for (const el of [toolbar, list, retry, detailRetry]) el.hidden = true;
    for (const el of [status, detailStatus, detailFailure, writeStatus, writeAlert])
      setText(el, "");
    setText(failure, t("denied"));
    if (hadFocus) {
      root.closest(".feature-view")?.querySelector<HTMLElement>(".feature-view-title")?.focus();
    }
    opts.onDenied();
  }

  function renderRow(item: AppealItem): HTMLLIElement {
    const li = createElement("li");
    const what = t("appeal.row.title", { name: personText(item.appellantId, me()) });
    const state = appealStateText(item.state);
    const when = t("appeal.row.filed", { date: dateText(item.createdAt) });
    const button = createElement("button", {
      type: "button",
      class: "mod-queue-row",
      "data-appeal-id": item.id,
      "data-testid": "mod-appeal-row",
      // Spans carry no separators of their own, so name the button in full.
      "aria-label": `${what}. ${state}. ${when}`,
    });
    appendChildren(
      button,
      createElement("span", { class: "mod-queue-what" }, what),
      createElement("span", { class: "mod-queue-state" }, state),
      createElement("span", { class: "mod-queue-when" }, when),
    );
    button.addEventListener("click", () => open(item.id), { signal });
    li.appendChild(button);
    return li;
  }

  function renderList(): void {
    const focused = list.contains(document.activeElement)
      ? ((document.activeElement as HTMLElement).dataset.appealId ?? null)
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
    if (announce) setText(status, t("appeal.list.loading"));
    api.getModerationAppeals(forFilter.value, req.signal).then(
      (rows) => {
        if (req !== listReq || signal.aborted) return;
        listReq = null;
        list.removeAttribute("aria-busy");
        const retryHadFocus = document.activeElement === retry;
        items = rows.map(mapAppealRow);
        renderList();
        setText(failure, "");
        retry.hidden = true;
        setText(status, t(forFilter.countKey, { count: items.length }));
        if (retryHadFocus) focusList(null);
        if (selected !== null && refreshDetail) loadDetail(selected, false);
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
        setText(failure, t("appeal.list.error"));
        retry.hidden = false;
      },
    );
  }

  function showDetail(detail: AppealDetail, takeFocus: boolean): void {
    const active = document.activeElement;
    const hadFocus = detailSlot.contains(active);
    const retryHadFocus = active === detailRetry;
    // A re-read rebuilds the appeal: put focus back on the same control.
    const focusKey = hadFocus && active instanceof HTMLElement ? active.dataset.focus : undefined;
    const caret =
      active instanceof HTMLTextAreaElement
        ? ([active.selectionStart, active.selectionEnd] as const)
        : null;
    dropDetail();
    shown = detail;
    if (draft.id !== detail.id) draft = { ...NO_DRAFT(), id: detail.id };
    const view = buildAppealDetail({
      detail,
      me: me(),
      draft,
      onWrite: (w) => write(detail.id, w),
      onOpenReport: opts.openReport,
      signal,
    });
    if (!view.takesInput) {
      if (draft.note.trim() !== "" && writeAlert.textContent === "")
        setText(writeAlert, t("appeal.draftLost"));
      draft = { ...NO_DRAFT(), id: detail.id };
    }
    view.element.addEventListener(
      "keydown",
      (e: KeyboardEvent) => {
        // Escape closes the appeal first; the view's own Escape is the next one.
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
      if (caret !== null && again instanceof HTMLTextAreaElement) {
        again.setSelectionRange(caret[0], caret[1]);
      }
    } else if (takeFocus || hadFocus || retryHadFocus) view.heading.focus();
  }

  function send(id: string, w: AppealWrite): Promise<void> {
    if (w.kind === "assign") return api.assignModerationAppeal(id, signal);
    return api.decideModerationAppeal(id, w.outcome, w.note, signal);
  }

  function errorText(w: AppealWrite, err: unknown): string {
    if (isStatus(err, 403, "SELF_REVIEW")) return t("appeal.selfReview");
    if (isStatus(err, 409, "REVERSAL_FAILED")) return t("appeal.reversalFailed");
    if (isStatus(err, 409))
      return t(w.kind === "assign" ? "appeal.conflict.assign" : "appeal.conflict.decide");
    if (isStatus(err, 400) && (err as ApiClientError).message !== "") {
      return t("appeal.invalid", { message: (err as ApiClientError).message });
    }
    // No answer, or an internal failure: the change may still have been recorded.
    return t("appeal.unknown");
  }

  /** Read the queue and the appeal again after a write; the next write waits for the appeal. */
  function reread(id: string): void {
    writing = "reading";
    loadList(false, false);
    loadDetail(id, false);
  }

  /** Send one write, then read the appeal again whatever the answer. */
  function write(id: string, w: AppealWrite): boolean {
    if (writing !== null || denied) return false;
    writing = "sending";
    setText(writeStatus, "");
    setText(writeAlert, "");
    send(id, w).then(
      () => {
        if (signal.aborted || denied) return;
        if (w.kind === "decide" && draft.id === id) draft = { ...NO_DRAFT(), id };
        if (selected !== id) {
          writing = null;
          return;
        }
        setText(writeStatus, t(w.kind === "assign" ? "appeal.done.assign" : "appeal.done.decide"));
        reread(id);
      },
      (err: unknown) => {
        if (signal.aborted || denied) return;
        if (isStatus(err, 403) && !isStatus(err, 403, "SELF_REVIEW")) {
          deny();
          return;
        }
        if (selected !== id) {
          writing = null;
          return;
        }
        if (isStatus(err, 404)) {
          writing = null;
          clearDetail(t("appeal.detail.notFound"));
          loadList(false, false);
          return;
        }
        setText(writeAlert, errorText(w, err));
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
      clearChildren(detailSlot);
      shown = null;
      setText(detailStatus, t("appeal.detail.loading"));
    }
    detailSlot.setAttribute("aria-busy", "true");
    api.getModerationAppeal(id, req.signal).then(
      (wire) => {
        if (req !== detailReq || signal.aborted || selected !== id) return;
        detailReq = null;
        if (writing === "reading") writing = null;
        detailSlot.removeAttribute("aria-busy");
        // Only move focus if the reader is still where they asked from.
        const active = document.activeElement;
        const stayed =
          active === null ||
          active === document.body ||
          active === rowFor(id) ||
          detailSlot.contains(active);
        if (takeFocus) setText(detailStatus, "");
        showDetail(mapAppealDetail(wire), takeFocus && stayed);
      },
      (err: unknown) => {
        if (req !== detailReq || signal.aborted || selected !== id) return;
        detailReq = null;
        if (writing === "reading") writing = null;
        detailSlot.removeAttribute("aria-busy");
        if (isStatus(err, 403, "SELF_REVIEW")) {
          clearDetail(t("appeal.detail.own"));
          return;
        }
        if (isStatus(err, 403)) {
          deny();
          return;
        }
        if (isStatus(err, 404)) {
          clearDetail(t("appeal.detail.notFound"));
          loadList(false, false);
          return;
        }
        const hadFocus = detailSlot.contains(document.activeElement);
        dropDetail();
        setText(detailStatus, "");
        setDetailError(t("appeal.detail.error"));
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
    if (draft.id !== id) draft = NO_DRAFT();
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

  const unsubs = [
    // mod_queue carries no appeal data: read the queue (and the open appeal) again.
    modAppealStore.subscribe(() => loadList(false, true)),
    // mod_queue is never replayed, so a reconnect reads again too.
    uiStore.subscribeSelector(
      (s) => s.connectionStatus,
      (st) => {
        if (st === "connected") loadList(false, true);
      },
    ),
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
      draft = NO_DRAFT();
      clearChildren(root);
    },
    { once: true },
  );

  loadList(true, false);
  return { deny };
}
