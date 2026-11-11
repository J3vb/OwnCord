/**
 * The Moderation Center's report tab: the filtered queue, the open report
 * and its review and action writes. Queue.ts mounts it beside the appeals tab
 * and documents the behaviour this view keeps.
 */

import { Disposable } from "@lib/disposable";
import { clearChildren, setText } from "@lib/dom";
import type { MountableComponent } from "@lib/text/safeRender";
import { authStore } from "@stores/auth.store";
import { moderationText as t } from "../../i18n/moderation";
import { nsfwContentBlocked } from "../content-consent/nsfw";
import type { FeatureViewContext } from "../navigation/destinations";
import { emptyActionDraft, type ActionDraft } from "./ActionForms";
import {
  isStatus,
  itemFromDetail,
  mapDetail,
  mapQueueRow,
  type QueueItem,
  type ReportDetail,
} from "./api";
import { buildReportDetail, memberName } from "./Evidence";
import { captureDetailFocus, restoreDetailFocus } from "./detailFocus";
import { buildHistory } from "./History";
import { RestErrorCode } from "@lib/protocolTypes";
import {
  blankDeniedDom,
  buildReportsDom,
  appendActionControls,
  appendReviewControls,
  closeOnEscape,
  createQueueListView,
  focusFeatureTitle,
  focusStayed,
  mountNsfwGate,
  subscribeQueueSources,
} from "./queueParts";
import {
  FILTERS,
  actionErrorText,
  clearSentActDraft,
  doneText,
  isAction,
  reviewErrorText,
  NO_DRAFT,
  sendWrite,
  type ReportDrafts,
  type ReportsView,
  type Write,
} from "./queueModel";

export function renderReports(
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

  const dom = buildReportsDom(root);
  const {
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
  } = dom;

  const drafts: ReportDrafts = {
    review: () => draft,
    setReview: (next) => {
      draft = next;
    },
    act: () => actDraft,
    setAct: (next) => {
      actDraft = next;
    },
  };

  const itemFor = (id: string): QueueItem | undefined =>
    items.find((i) => i.id === id) ?? (offList?.id === id ? offList : undefined);

  const listView = createQueueListView(list, select, signal, (id) => open(id));
  const { rowFor, focusList } = listView;
  const syncCurrent = (): void => listView.syncCurrent(selected);

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
    blankDeniedDom(dom, t("denied"));
    if (hadFocus) focusFeatureTitle(root);
    onDenied();
  }

  const renderList = (): void => listView.render(items, selected);

  /** Keep the open report in step with a fresh list: re-read it, or say it left the filter or is gone. */
  function reconcileSelection(was: QueueItem | undefined, refreshDetail: boolean): void {
    if (selected === null) return;
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

  function onListLoaded(
    rows: Parameters<typeof mapQueueRow>[0][],
    forFilter: { readonly countKey: Parameters<typeof t>[0] },
    refreshDetail: boolean,
  ): void {
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
    reconcileSelection(was, refreshDetail);
    if (writing !== "sending") ownWrite = null;
  }

  function onListFailed(err: unknown): void {
    listReq = null;
    list.removeAttribute("aria-busy");
    if (isStatus(err, 403)) {
      deny();
      return;
    }
    setText(status, "");
    setText(failure, t("list.error"));
    retry.hidden = false;
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
        onListLoaded(rows, forFilter, refreshDetail);
      },
      (err: unknown) => {
        if (req !== listReq || signal.aborted) return;
        onListFailed(err);
      },
    );
  }

  function mountGate(slot: HTMLElement, channelId: number, channelName: string): void {
    const forReport = shown;
    mountNsfwGate({
      slot,
      channelId,
      channelName,
      signal,
      api,
      stillShown: () => shown === forReport,
      onGate: (next) => {
        gate = next;
      },
      onAccepted: () => {
        if (forReport !== null && selected === forReport.id) loadDetail(forReport.id, true);
      },
      onCancel: closeToRow,
      onFailed: () => setDetailError(t("detail.error")),
    });
  }

  function showDetail(item: QueueItem, detail: ReportDetail, takeFocus: boolean): void {
    // A re-read rebuilds the report: put focus back on the same control.
    const before = captureDetailFocus(detailSlot, detailRetry, true);
    dropDetail();
    shown = detail;
    const view = buildReportDetail(item, detail, mountGate);
    reportHeading = view.heading;
    const me = authStore.getState().user?.id ?? -1;
    view.element.append(...buildHistory(detail, me));
    const controls = { parent: view.element, detail, me, drafts, write, signal, alert: writeAlert };
    appendReviewControls(controls);
    appendActionControls({ ...controls, slot: detailSlot, heading: () => reportHeading });
    closeOnEscape(view.element, closeToRow, signal);
    detailSlot.appendChild(view.element);
    restoreDetailFocus(view, before, takeFocus, true);
  }

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
    sendWrite(api, signal, id, w).then(
      (answer) => {
        if (signal.aborted || denied) return;
        if (w.kind === "note" && draft.id === id) draft = { ...draft, text: "" };
        clearSentActDraft(actDraft, id, w);
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
        if (isStatus(err, 403) && !isStatus(err, 403, RestErrorCode.SELF_REVIEW) && !isAction(w)) {
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
        // A note the closed report refused is already said to be unsaved: the
        // re-read must not answer it a second time as a discarded draft.
        if (w.kind === "note" && isStatus(err, 409) && draft.id === id)
          draft = { ...draft, text: "" };
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
        const stayed = focusStayed(rowFor(id), detailSlot);
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

  const unsubs = subscribeQueueSources({
    reoffer,
    reload: () => loadList(false, true),
    // Consent withdrawn (here or on another device): the evidence goes at once.
    onChannels: () => {
      const d = shown;
      if (d?.evidence.kind !== "shown" || d.channelId === null) return;
      if (!nsfwContentBlocked(d.channelId)) return;
      const item = itemFor(d.id);
      if (item === undefined) {
        clearDetail("");
        return;
      }
      showDetail(item, { ...d, evidence: { kind: "consent", channelId: d.channelId } }, false);
    },
  });

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
