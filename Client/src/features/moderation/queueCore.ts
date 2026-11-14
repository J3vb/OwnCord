/**
 * The list and detail logic the Moderation Center's report and appeal tabs
 * share: their toolbar and status lines, the row list, one read per request
 * that a later request or the view's end drops, focus that stays where the
 * reader is, and the one-at-a-time write with its refusal handling. Each tab
 * keeps its own rows, drafts and texts and hands them in as callbacks.
 */

import { Disposable } from "@lib/disposable";
import { clearChildren, setText } from "@lib/dom";
import { RestErrorCode } from "@lib/protocolTypes";
import { moderationText as t } from "../../i18n/moderation";
import { isStatus } from "./api";
import type { TextKey } from "./queueParts";
import {
  blankDeniedDom,
  focusFeatureTitle,
  focusStayed,
  type QueueDom,
  type QueueListView,
} from "./queueParts";

/** A write being sent, or its answer waiting on the re-read of the open item. */
type WriteState = "sending" | "reading" | null;

/** One write: what to send and how each answer reads. */
export interface WriteSpec<Answer> {
  readonly send: () => Promise<Answer>;
  /** Runs once the write is accepted to send, before the request goes out. */
  readonly begin?: () => void;
  /** The server accepted it; runs whether or not the item is still open. */
  readonly onSent: (answer: Answer) => void;
  /** The item is still open: records the answer and returns the status text. */
  readonly onDone: (answer: Answer) => string;
  /** Any failure, before it is classified. */
  readonly onFailed?: () => void;
  /** The server refused with a status that is not about the item being gone. */
  readonly onRefused?: (err: unknown) => void;
  readonly errorText: (err: unknown) => string;
  /** A 403 here is the write's own refusal, never the loss of the whole center. */
  readonly keepOnForbidden?: boolean;
  /** A 404 here answers the write, not the item. */
  readonly keepOnNotFound?: boolean;
}

export interface QueueCoreArgs<Row, Wire, Filter extends string> {
  readonly signal: AbortSignal;
  readonly dom: QueueDom;
  readonly listView: QueueListView;
  readonly root: HTMLElement;
  /** The open filter's value and the text key for its count. */
  readonly filter: () => { readonly value: Filter; readonly countKey: TextKey };
  readonly readList: (filterValue: Filter, signal: AbortSignal) => Promise<Row[]>;
  readonly readDetail: (id: string, signal: AbortSignal) => Promise<Wire>;
  /** Swap in a fresh list; returns the count and what to do once it is drawn. */
  readonly replaceRows: (rows: Row[]) => {
    readonly count: number;
    readonly settle: (refreshDetail: boolean) => void;
  };
  /** A detail answer for the open item, with whether focus may move to it. */
  readonly onDetail: (id: string, wire: Wire, takeFocus: boolean) => void;
  /** A detail failure the tab answers itself; true when it did. */
  readonly onDetailError?: (err: unknown) => boolean;
  /** The open item's own state goes (drafts, links) when its detail closes. */
  readonly forget: () => void;
  /** Everything the tab holds goes when the server refuses the reader. */
  readonly onLost: () => void;
  readonly onDenied: () => void;
  /** Release what a rendered detail holds besides its DOM. */
  readonly onDrop?: () => void;
  readonly keys: {
    readonly listLoading: TextKey;
    readonly listError: TextKey;
    readonly detailLoading: TextKey;
    readonly detailError: TextKey;
    readonly notFound: TextKey;
  };
}

/**
 * The state and requests of one tab. A request is bound to the view's signal
 * and to the item or filter it was made for, so a late answer is dropped.
 */
export function createQueueCore<Row, Wire, Shown, Filter extends string>(
  args: QueueCoreArgs<Row, Wire, Filter>,
) {
  const { signal, dom, listView, root, keys } = args;
  const { detailSlot, detailStatus, detailRetry, writeStatus, writeAlert } = dom;
  const state: { selected: string | null; denied: boolean; shown: Shown | null } = {
    selected: null,
    denied: false,
    shown: null,
  };
  let writing: WriteState = null;
  let listReq: Disposable | null = null;
  let detailReq: Disposable | null = null;
  let detailFocus = false;

  const readSettled = (): void => {
    if (writing === "reading") writing = null;
  };

  function setDetailError(message: string): void {
    setText(dom.detailFailure, message);
    detailRetry.hidden = message === "";
  }

  /** Empty the detail slot without touching the request in flight. */
  function clearSlot(): void {
    args.onDrop?.();
    clearChildren(detailSlot);
    state.shown = null;
  }

  /** Remove the open item from the DOM and from memory. */
  function dropDetail(): void {
    detailReq?.destroy();
    detailReq = null;
    clearSlot();
  }

  /** Close the open item, saying why, and keep focus in the view. */
  function clearDetail(message: string): void {
    const hadFocus =
      detailSlot.contains(document.activeElement) || detailRetry === document.activeElement;
    const was = state.selected;
    readSettled();
    dropDetail();
    state.selected = null;
    args.forget();
    listView.syncCurrent(null);
    setDetailError("");
    setText(detailStatus, message);
    if (hadFocus) listView.focusList(was);
  }

  /** The server refused: nothing the reader held stays on screen. */
  function deny(): void {
    if (state.denied) return;
    const hadFocus = root.contains(document.activeElement);
    state.denied = true;
    writing = null;
    listReq?.destroy();
    listReq = null;
    dropDetail();
    state.selected = null;
    args.onLost();
    blankDeniedDom(dom, t("denied"));
    if (hadFocus) focusFeatureTitle(root);
    args.onDenied();
  }

  function listLoaded(rows: Row[], countKey: TextKey, refreshDetail: boolean): void {
    listReq = null;
    dom.list.removeAttribute("aria-busy");
    const retryHadFocus = document.activeElement === dom.retry;
    const { count, settle } = args.replaceRows(rows);
    setText(dom.failure, "");
    dom.retry.hidden = true;
    setText(dom.status, t(countKey, { count }));
    if (retryHadFocus) listView.focusList(null);
    settle(refreshDetail);
  }

  function listFailed(err: unknown): void {
    listReq = null;
    dom.list.removeAttribute("aria-busy");
    if (isStatus(err, 403)) {
      deny();
      return;
    }
    setText(dom.status, "");
    setText(dom.failure, t(keys.listError));
    dom.retry.hidden = false;
  }

  function loadList(announce: boolean, refreshDetail: boolean): void {
    if (state.denied) return;
    listReq?.destroy();
    const req = new Disposable();
    listReq = req;
    const forFilter = args.filter();
    dom.list.setAttribute("aria-busy", "true");
    if (announce) setText(dom.status, t(keys.listLoading));
    args.readList(forFilter.value, req.signal).then(
      (rows) => {
        if (req !== listReq || signal.aborted) return;
        listLoaded(rows, forFilter.countKey, refreshDetail);
      },
      (err: unknown) => {
        if (req !== listReq || signal.aborted) return;
        listFailed(err);
      },
    );
  }

  /** A detail read failed: the tab's own answers first, then 403, 404, else a retry. */
  function detailFailed(err: unknown): void {
    if (args.onDetailError?.(err) === true) return;
    if (isStatus(err, 403)) {
      deny();
      return;
    }
    if (isStatus(err, 404)) {
      clearDetail(t(keys.notFound));
      loadList(false, false);
      return;
    }
    const hadFocus = detailSlot.contains(document.activeElement);
    dropDetail();
    setText(detailStatus, "");
    setDetailError(t(keys.detailError));
    if (hadFocus) detailRetry.focus();
  }

  function loadDetail(id: string, askedFocus: boolean): void {
    const takeFocus = askedFocus || (detailReq !== null && detailFocus);
    detailReq?.destroy();
    const req = new Disposable();
    detailReq = req;
    detailFocus = takeFocus;
    setDetailError("");
    if (takeFocus) {
      clearSlot();
      setText(detailStatus, t(keys.detailLoading));
    }
    detailSlot.setAttribute("aria-busy", "true");
    args.readDetail(id, req.signal).then(
      (wire) => {
        if (req !== detailReq || signal.aborted || state.selected !== id) return;
        detailReq = null;
        readSettled();
        detailSlot.removeAttribute("aria-busy");
        // Only move focus if the reader is still where they asked from.
        const stayed = focusStayed(listView.rowFor(id), detailSlot);
        args.onDetail(id, wire, takeFocus && stayed);
      },
      (err: unknown) => {
        if (req !== detailReq || signal.aborted || state.selected !== id) return;
        detailReq = null;
        readSettled();
        detailSlot.removeAttribute("aria-busy");
        detailFailed(err);
      },
    );
  }

  /** Read the queue and the item again after a write; the next write waits for the item. */
  function reread(id: string): void {
    writing = "reading";
    loadList(false, false);
    loadDetail(id, false);
  }

  /** A write failed: lost authority, a gone item, or a refusal to say, then a re-read. */
  function writeFailed<A>(id: string, spec: WriteSpec<A>, err: unknown): void {
    spec.onFailed?.();
    if (
      isStatus(err, 403) &&
      !isStatus(err, 403, RestErrorCode.SELF_REVIEW) &&
      spec.keepOnForbidden !== true
    ) {
      deny();
      return;
    }
    if (state.selected !== id) {
      writing = null;
      return;
    }
    if (isStatus(err, 404) && spec.keepOnNotFound !== true) {
      writing = null;
      clearDetail(t(keys.notFound));
      loadList(false, false);
      return;
    }
    spec.onRefused?.(err);
    setText(writeAlert, spec.errorText(err));
    reread(id);
  }

  /** Send one write, then read the item again whatever the answer. */
  function write<A>(id: string, spec: WriteSpec<A>): boolean {
    if (writing !== null || state.denied) return false;
    writing = "sending";
    spec.begin?.();
    setText(writeStatus, "");
    setText(writeAlert, "");
    spec.send().then(
      (answer) => {
        if (signal.aborted || state.denied) return;
        spec.onSent(answer);
        if (state.selected !== id) {
          writing = null;
          return;
        }
        setText(writeStatus, spec.onDone(answer));
        reread(id);
      },
      (err: unknown) => {
        if (signal.aborted || state.denied) return;
        writeFailed(id, spec, err);
      },
    );
    return true;
  }

  function closeToRow(): void {
    const was = state.selected;
    clearDetail("");
    listView.focusList(was);
  }

  /** Select `id` and read it; `prepare` drops drafts that belong to another item. */
  function open(id: string, prepare: () => void): void {
    if (state.denied) return;
    if (state.selected === id && state.shown !== null) {
      detailSlot.querySelector<HTMLElement>("h3")?.focus();
      return;
    }
    prepare();
    setText(writeStatus, "");
    setText(writeAlert, "");
    state.selected = id;
    listView.syncCurrent(id);
    loadDetail(id, true);
  }

  /** The view ended: stop every request and drop the open item. */
  function dispose(): void {
    listReq?.destroy();
    listReq = null;
    dropDetail();
    state.selected = null;
  }

  dom.retry.addEventListener("click", () => loadList(true, false), { signal });
  detailRetry.addEventListener(
    "click",
    () => {
      if (state.selected !== null) loadDetail(state.selected, true);
    },
    { signal },
  );

  return {
    state,
    loadList,
    loadDetail,
    dropDetail,
    clearDetail,
    setDetailError,
    deny,
    write,
    closeToRow,
    open,
    dispose,
    /** A write's answer or its re-read is still on its way. */
    busy: (): boolean => writing !== null || detailReq !== null,
    /** A write is going out and its answer has not come back. */
    sending: (): boolean => writing === "sending",
  };
}
