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
 */

import { ApiClientError, type ModerationQueueFilter } from "@lib/api";
import { Disposable } from "@lib/disposable";
import { appendChildren, clearChildren, createElement, setText } from "@lib/dom";
import type { MountableComponent } from "@lib/safe-render";
import { channelsStore, setNsfwAcknowledged } from "@stores/channels.store";
import { uiStore } from "@stores/ui.store";
import { moderationText as t } from "../../i18n/moderation";
import { nsfwContentBlocked } from "../content-consent/nsfw";
import type { FeatureViewContext } from "../navigation/destinations";
import { mapDetail, mapQueueRow, type QueueItem, type ReportDetail } from "./api";
import { buildReportDetail, dateText, nameText, reportTitle, stateText } from "./Evidence";
import { modQueueStore } from "./store";

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

function isStatus(err: unknown, status: number): boolean {
  return err instanceof ApiClientError && err.status === status;
}

export function renderModerationCenter(root: HTMLElement, ctx: FeatureViewContext): void {
  const { signal, api } = ctx;
  let filter: (typeof FILTERS)[number] = FILTERS[0];
  let items: readonly QueueItem[] = [];
  let selected: string | null = null;
  let shown: ReportDetail | null = null;
  let gate: MountableComponent | null = null;
  let listReq: Disposable | null = null;
  let detailReq: Disposable | null = null;
  let denied = false;

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
    detailSlot,
  );

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

  /** Close the open report, saying why, and keep focus in the view. */
  function clearDetail(message: string): void {
    const hadFocus =
      detailSlot.contains(document.activeElement) || detailRetry === document.activeElement;
    const was = selected;
    dropDetail();
    selected = null;
    syncCurrent();
    setDetailError("");
    setText(detailStatus, message);
    if (hadFocus) focusList(was);
  }

  /** The server refused: nothing the reader held stays on screen. */
  function deny(): void {
    const hadFocus = root.contains(document.activeElement);
    denied = true;
    listReq?.destroy();
    listReq = null;
    dropDetail();
    items = [];
    selected = null;
    clearChildren(list);
    for (const el of [toolbar, list, retry, detailRetry]) el.hidden = true;
    for (const el of [status, detailStatus, detailFailure]) setText(el, "");
    setText(failure, t("denied"));
    if (hadFocus) {
      root.closest(".feature-view")?.querySelector<HTMLElement>(".feature-view-title")?.focus();
    }
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
        items = rows.map(mapQueueRow);
        renderList();
        setText(failure, "");
        retry.hidden = true;
        setText(status, t(forFilter.countKey, { count: items.length }));
        if (retryHadFocus) focusList(null);
        if (selected !== null) {
          if (!items.some((i) => i.id === selected)) clearDetail(t("detail.gone"));
          else if (refreshDetail) loadDetail(selected, false);
        }
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
              if (selected !== null) loadDetail(selected, true);
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
    const hadFocus = detailSlot.contains(document.activeElement);
    const retryHadFocus = document.activeElement === detailRetry;
    dropDetail();
    shown = detail;
    const view = buildReportDetail(item, detail, mountGate);
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
    if (takeFocus || hadFocus || retryHadFocus) view.heading.focus();
  }

  function closeToRow(): void {
    const was = selected;
    clearDetail("");
    focusList(was);
  }

  function loadDetail(id: string, takeFocus: boolean): void {
    detailReq?.destroy();
    const req = new Disposable();
    detailReq = req;
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
        detailSlot.removeAttribute("aria-busy");
        const item = items.find((i) => i.id === id);
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
        setText(detailStatus, "");
        showDetail(item, mapDetail(wire), takeFocus && stayed);
      },
      (err: unknown) => {
        if (req !== detailReq || signal.aborted || selected !== id) return;
        detailReq = null;
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
        dropDetail();
        setText(detailStatus, "");
        setDetailError(t("detail.error"));
      },
    );
  }

  function open(id: string): void {
    if (denied) return;
    if (selected === id && shown !== null) {
      detailSlot.querySelector<HTMLElement>("h3")?.focus();
      return;
    }
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
      const item = items.find((i) => i.id === d.id);
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
      clearChildren(root);
    },
    { once: true },
  );

  loadList(true, false);
}
