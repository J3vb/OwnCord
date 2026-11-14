/**
 * The Moderation Center's report tab: the filtered queue, the open report
 * and its review and action writes. Queue.ts mounts it beside the appeals tab
 * and documents the behaviour this view keeps.
 */

import type { ModerationQueueRow, ModerationReportDetail } from "@lib/api";
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
import {
  buildReportsDom,
  appendActionControls,
  appendReviewControls,
  buildQueueRow,
  closeOnEscape,
  createQueueListView,
  mountNsfwGate,
  subscribeQueueSources,
} from "./queueParts";
import { createQueueCore } from "./queueCore";
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
  let reportHeading: HTMLElement | null = null;
  let gate: MountableComponent | null = null;
  /** The unsaved note and chosen outcome, for the report they were entered on. */
  let draft = NO_DRAFT;
  /** The unsaved action reasons and length, for the report they were entered on. */
  let actDraft: ActionDraft & { id: string } = { id: "", ...emptyActionDraft() };
  const dropActDraft = (): void => {
    actDraft = { id: "", ...emptyActionDraft() };
  };
  /** A report this reader is writing to: leaving the filter is expected, not news. */
  let ownWrite: string | null = null;
  /** The open report, kept after the reader's own write took it out of the filter. */
  let offList: QueueItem | null = null;
  /** A report opened by id from an appeal, kept open whatever the filter. */
  let linked: string | null = null;

  const dom = buildReportsDom(root);
  const { select, detailStatus, detailSlot, writeAlert } = dom;

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

  const listView = createQueueListView<QueueItem>({
    list: dom.list,
    select,
    signal,
    idAttr: "data-report-id",
    buildRow: buildQueueRow,
    onOpen: (id) => open(id),
  });

  /** Keep the open report in step with a fresh list: re-read it, or say it left the filter or is gone. */
  function reconcileSelection(was: QueueItem | undefined, refreshDetail: boolean): void {
    const { selected } = core.state;
    if (selected === null) return;
    if (items.some((i) => i.id === selected)) {
      offList = null;
      if (refreshDetail) core.loadDetail(selected, false);
    } else if (
      was !== undefined &&
      (selected === ownWrite || selected === linked || offList === was)
    ) {
      if (offList === null) setText(detailStatus, t("detail.leftFilter"));
      offList = was;
      if (refreshDetail) core.loadDetail(selected, false);
    } else if (selected !== linked) {
      core.clearDetail(t("detail.gone"));
    }
  }

  function replaceRows(rows: ModerationQueueRow[]): {
    count: number;
    settle: (refreshDetail: boolean) => void;
  } {
    const { selected } = core.state;
    const was = selected === null ? undefined : itemFor(selected);
    items = rows.map(mapQueueRow);
    listView.render(items, core.state.selected);
    return {
      count: items.length,
      settle: (refreshDetail) => {
        reconcileSelection(was, refreshDetail);
        if (!core.sending()) ownWrite = null;
      },
    };
  }

  function mountGate(slot: HTMLElement, channelId: number, channelName: string): void {
    const forReport = core.state.shown;
    mountNsfwGate({
      slot,
      channelId,
      channelName,
      signal,
      api,
      stillShown: () => core.state.shown === forReport,
      onGate: (next) => {
        gate = next;
      },
      onAccepted: () => {
        if (forReport !== null && core.state.selected === forReport.id)
          core.loadDetail(forReport.id, true);
      },
      onCancel: () => core.closeToRow(),
      onFailed: () => core.setDetailError(t("detail.error")),
    });
  }

  function showDetail(item: QueueItem, detail: ReportDetail, takeFocus: boolean): void {
    // A re-read rebuilds the report: put focus back on the same control.
    const before = captureDetailFocus(detailSlot, dom.detailRetry, true);
    core.dropDetail();
    core.state.shown = detail;
    const view = buildReportDetail(item, detail, mountGate);
    reportHeading = view.heading;
    const me = authStore.getState().user?.id ?? -1;
    view.element.append(...buildHistory(detail, me));
    const controls = { parent: view.element, detail, me, drafts, write, signal, alert: writeAlert };
    appendReviewControls(controls);
    appendActionControls({ ...controls, slot: detailSlot, heading: () => reportHeading });
    closeOnEscape(view.element, () => core.closeToRow(), signal);
    detailSlot.appendChild(view.element);
    restoreDetailFocus(view, before, takeFocus, true);
  }

  function onDetail(id: string, wire: ModerationReportDetail, takeFocus: boolean): void {
    let item = itemFor(id);
    if (item === undefined && linked === id) {
      item = itemFromDetail(wire, memberName);
      offList = item;
    }
    if (item === undefined) {
      core.clearDetail(t("detail.gone"));
      return;
    }
    if (takeFocus) setText(detailStatus, "");
    showDetail(item, mapDetail(wire), takeFocus);
  }

  const core = createQueueCore<
    ModerationQueueRow,
    ModerationReportDetail,
    ReportDetail,
    (typeof FILTERS)[number]["value"]
  >({
    signal,
    dom,
    listView,
    root,
    filter: () => filter,
    readList: (value, sig) => api.getModerationQueue(value, sig),
    readDetail: (id, sig) => api.getModerationReport(id, sig),
    replaceRows,
    onDetail,
    forget: () => {
      ownWrite = null;
      offList = null;
      linked = null;
      draft = NO_DRAFT;
      dropActDraft();
    },
    onLost: () => {
      items = [];
      ownWrite = null;
      offList = null;
      draft = NO_DRAFT;
      dropActDraft();
    },
    onDenied,
    onDrop: () => {
      gate?.destroy?.();
      gate = null;
    },
    keys: {
      listLoading: "list.loading",
      listError: "list.error",
      detailLoading: "detail.loading",
      detailError: "detail.error",
      notFound: "detail.notFound",
    },
  });
  const { deny } = core;

  /** Send one review write, then read the report again whatever the answer. */
  function write(id: string, w: Write): boolean {
    let keptBefore: QueueItem | null = null;
    return core.write(id, {
      send: () => sendWrite(api, signal, id, w),
      begin: () => {
        ownWrite = id;
        keptBefore = offList;
      },
      onSent: () => {
        if (w.kind === "note" && draft.id === id) draft = { ...draft, text: "" };
        clearSentActDraft(actDraft, id, w);
      },
      onDone: (answer) => {
        ownWrite = id;
        return doneText(w, answer);
      },
      onFailed: () => {
        ownWrite = null;
        if (offList !== keptBefore) {
          offList = null;
          setText(detailStatus, "");
        }
      },
      // A note the closed report refused is already said to be unsaved: the
      // re-read must not answer it a second time as a discarded draft.
      onRefused: (err) => {
        if (w.kind === "note" && isStatus(err, 409) && draft.id === id)
          draft = { ...draft, text: "" };
      },
      errorText: (err) => (isAction(w) ? actionErrorText(w, err) : reviewErrorText(w, err)),
      keepOnForbidden: isAction(w),
      keepOnNotFound: w.kind === "lift",
    });
  }

  function open(id: string): void {
    core.open(id, () => {
      if (draft.id !== id) draft = NO_DRAFT;
      if (actDraft.id !== id) dropActDraft();
    });
  }

  select.addEventListener(
    "change",
    () => {
      filter = FILTERS.find((f) => f.value === select.value) ?? FILTERS[0];
      ownWrite = null;
      if (core.state.selected !== linked) offList = null;
      core.loadList(true, false);
    },
    { signal },
  );

  /** The open report again, for a role change that moves what may be offered. */
  function reoffer(): void {
    const d = core.state.shown;
    // A write's re-read, or any read in flight, rebuilds it anyway.
    if (d === null || core.busy()) return;
    const item = itemFor(d.id);
    if (item !== undefined) showDetail(item, d, false);
  }

  const unsubs = subscribeQueueSources({
    reoffer,
    reload: () => core.loadList(false, true),
    // Consent withdrawn (here or on another device): the evidence goes at once.
    onChannels: () => {
      const d = core.state.shown;
      if (d?.evidence.kind !== "shown" || d.channelId === null) return;
      if (!nsfwContentBlocked(d.channelId)) return;
      const item = itemFor(d.id);
      if (item === undefined) {
        core.clearDetail("");
        return;
      }
      showDetail(item, { ...d, evidence: { kind: "consent", channelId: d.channelId } }, false);
    },
  });

  signal.addEventListener(
    "abort",
    () => {
      for (const u of unsubs) u();
      core.dispose();
      items = [];
      offList = null;
      draft = NO_DRAFT;
      dropActDraft();
      clearChildren(root);
    },
    { once: true },
  );

  core.loadList(true, false);
  return {
    deny,
    openLinked: (id) => {
      if (core.state.denied) return;
      if (itemFor(id) === undefined) linked = id;
      open(id);
    },
  };
}
