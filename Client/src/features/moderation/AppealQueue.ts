/**
 * The Moderation Center's Appeals tab: the appeal queue and the
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

import { RestErrorCode } from "@lib/protocolTypes";
import type { ModerationAppealDetail, ModerationAppealRow } from "@lib/api";
import { clearChildren, setText } from "@lib/dom";
import { authStore } from "@stores/auth.store";
import { uiStore } from "@stores/ui.store";
import { moderationText as t } from "../../i18n/moderation";
import type { FeatureViewContext } from "../navigation/destinations";
import {
  appealStateText,
  buildAppealDetail,
  type AppealDraft,
  type AppealWrite,
} from "./AppealDetail";
import { isStatus, mapAppealDetail, mapAppealRow, type AppealDetail, type AppealItem } from "./api";
import { captureDetailFocus, restoreDetailFocus } from "./detailFocus";
import { dateText } from "./Evidence";
import { actorName } from "./History";
import { modAppealStore } from "./store";
import { FILTERS, errorText, type AppealsOptions, type AppealsView } from "./appealModel";
import { createQueueCore } from "./queueCore";
import { buildQueueDom, buildRowItem, closeOnEscape, createQueueListView } from "./queueParts";

export type { AppealsOptions, AppealsView } from "./appealModel";

const me = (): number => authStore.getState().user?.id ?? -1;
const NO_DRAFT = (): AppealDraft & { id: string } => ({ id: "", note: "", outcome: null });

function buildAppealRow(
  item: AppealItem,
  onOpen: (id: string) => void,
  signal: AbortSignal,
): HTMLLIElement {
  return buildRowItem({
    id: item.id,
    idAttr: "data-appeal-id",
    testId: "mod-appeal-row",
    parts: [
      ["what", t("appeal.row.title", { name: actorName(item.appellantId, me()) })],
      ["state", appealStateText(item.state)],
      ["when", t("appeal.row.filed", { date: dateText(item.createdAt) })],
    ],
    onOpen,
    signal,
  });
}

export function renderAppeals(
  root: HTMLElement,
  ctx: FeatureViewContext,
  opts: AppealsOptions,
): AppealsView {
  const { signal, api } = ctx;
  let filter: (typeof FILTERS)[number] = FILTERS[0];
  let items: readonly AppealItem[] = [];
  /** The unsaved decision, for the appeal it was entered on. */
  let draft = NO_DRAFT();

  const dom = buildQueueDom(root, {
    introKey: "appeal.intro",
    listLabelKey: "appeal.list.label",
    filters: FILTERS,
    idPrefix: "mod-appeal",
  });
  const { select, detailSlot, writeAlert } = dom;

  const listView = createQueueListView<AppealItem>({
    list: dom.list,
    select,
    signal,
    idAttr: "data-appeal-id",
    buildRow: buildAppealRow,
    onOpen: (id) => open(id),
  });

  function showDetail(detail: AppealDetail, takeFocus: boolean): void {
    // A re-read rebuilds the appeal: put focus back on the same control.
    const before = captureDetailFocus(detailSlot, dom.detailRetry, false);
    core.dropDetail();
    core.state.shown = detail;
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
    closeOnEscape(view.element, () => core.closeToRow(), signal);
    detailSlot.appendChild(view.element);
    restoreDetailFocus(view, before, takeFocus, false);
  }

  const core = createQueueCore<
    ModerationAppealRow,
    ModerationAppealDetail,
    AppealDetail,
    (typeof FILTERS)[number]["value"]
  >({
    signal,
    dom,
    listView,
    root,
    filter: () => filter,
    readList: (value, sig) => api.getModerationAppeals(value, sig),
    readDetail: (id, sig) => api.getModerationAppeal(id, sig),
    replaceRows: (rows) => {
      items = rows.map(mapAppealRow);
      listView.render(items, core.state.selected);
      return {
        count: items.length,
        settle: (refreshDetail) => {
          const { selected } = core.state;
          if (selected !== null && refreshDetail) core.loadDetail(selected, false);
        },
      };
    },
    onDetail: (_id, wire, takeFocus) => {
      showDetail(mapAppealDetail(wire), takeFocus);
    },
    onDetailError: (err) => {
      if (!isStatus(err, 403, RestErrorCode.SELF_REVIEW)) return false;
      core.clearDetail(t("appeal.detail.own"));
      return true;
    },
    forget: () => {
      draft = NO_DRAFT();
    },
    onLost: () => {
      items = [];
      draft = NO_DRAFT();
    },
    onDenied: opts.onDenied,
    keys: {
      listLoading: "appeal.list.loading",
      listError: "appeal.list.error",
      detailLoading: "appeal.detail.loading",
      detailError: "appeal.detail.error",
      notFound: "appeal.detail.notFound",
    },
  });

  /** Taking and deciding are single writes; the queue and the appeal are read again after. */
  function write(id: string, w: AppealWrite): boolean {
    return core.write(id, {
      send: () =>
        w.kind === "assign"
          ? api.assignModerationAppeal(id, signal)
          : api.decideModerationAppeal(id, w.outcome, w.note, signal),
      onSent: () => {
        if (w.kind === "decide" && draft.id === id) draft = { ...NO_DRAFT(), id };
      },
      onDone: () => t(w.kind === "assign" ? "appeal.done.assign" : "appeal.done.decide"),
      errorText: (err) => errorText(w, err),
    });
  }

  function open(id: string): void {
    core.open(id, () => {
      if (draft.id !== id) draft = NO_DRAFT();
    });
  }

  select.addEventListener(
    "change",
    () => {
      filter = FILTERS.find((f) => f.value === select.value) ?? FILTERS[0];
      core.loadList(true, false);
    },
    { signal },
  );

  const unsubs = [
    // mod_queue carries no appeal data: read the queue (and the open appeal) again.
    modAppealStore.subscribe(() => core.loadList(false, true)),
    // mod_queue is never replayed, so a reconnect reads again too.
    uiStore.subscribeSelector(
      (s) => s.connectionStatus,
      (st) => {
        if (st === "connected") core.loadList(false, true);
      },
    ),
  ];

  signal.addEventListener(
    "abort",
    () => {
      for (const u of unsubs) u();
      core.dispose();
      items = [];
      draft = NO_DRAFT();
      clearChildren(root);
    },
    { once: true },
  );

  core.loadList(true, false);
  return { deny: core.deny };
}
