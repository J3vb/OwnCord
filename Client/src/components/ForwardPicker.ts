/**
 * Forward picker (WP 6.9a): a dialog to choose up to five channels or DMs for
 * one message, optionally with a message of the sender's own, then send and
 * show each target's result. Loaded on the first Forward, through
 * ChannelController, so it stays out of the startup and MainPage chunks.
 *
 * Which targets exist and how they rank is features/messaging/forwardTargets.ts;
 * the sending and its per-target outcome is forwardSend.ts. This file only draws.
 * Built with @lib/dom helpers, never innerHTML.
 */

import { Disposable } from "@lib/disposable";
import { appendChildren, clearChildren, createElement, setText } from "@lib/dom";
import { createIcon } from "@lib/icons";
import { closeOnBackdropClick, createModal, type ModalInstance } from "@lib/modalFactory";
import { showToast } from "@lib/toast";
import { channelsStore } from "@stores/channels.store";
import { blocksStore } from "@stores/blocks.store";
import { dmStore } from "@stores/dm.store";
import { getChannelMessages } from "@stores/messages.store";
import {
  MAX_FORWARD_TARGETS,
  filterForwardTargets,
  listForwardTargets,
  pruneSelection,
  toggleForwardTarget,
  type ForwardTarget,
} from "../features/messaging/forwardTargets";
import {
  createForwardSession,
  type ForwardResult,
  type ForwardSession,
  type ForwardWs,
} from "../features/messaging/forwardSend";
import { MAX_MESSAGE_LEN } from "../features/messaging/messageLimits";
import { forwardText } from "../i18n/forward";
import { shellText } from "../i18n/shell";

export interface ForwardPickerOptions {
  readonly ws: ForwardWs;
  /** The channel the message is in. */
  readonly channelId: number;
  readonly messageId: number;
  /** Closes the picker (and drops anything still waiting) when it aborts. */
  readonly signal: AbortSignal;
  readonly fallbackFocus?: () => HTMLElement | null;
}

const PREVIEW_CHARS = 120;

const iconFor = (t: ForwardTarget): SVGSVGElement =>
  createIcon(t.kind === "dm" ? "user" : t.kind === "announcement" ? "megaphone" : "hash", 14);

/** The label a result line uses for a target: "#general", "@alex". */
const labelOf = (t: ForwardTarget): string => `${t.kind === "dm" ? "@" : "#"}${t.name}`;

function reasonText(code: string | null): string {
  switch (code) {
    case "FORBIDDEN":
      return forwardText("reason.FORBIDDEN");
    case "NOT_FOUND":
      return forwardText("reason.NOT_FOUND");
    case "RATE_LIMITED":
      return forwardText("reason.RATE_LIMITED");
    case "SLOW_MODE":
      return forwardText("reason.SLOW_MODE");
    case "TIMED_OUT":
      return forwardText("reason.TIMED_OUT");
    case "ATTACHMENTS_UNAVAILABLE":
      return forwardText("reason.ATTACHMENTS_UNAVAILABLE");
    case "REQUEST_TIMEOUT":
      return forwardText("reason.REQUEST_TIMEOUT");
    case "OFFLINE":
      return forwardText("reason.OFFLINE");
    case "NETWORK":
      return forwardText("reason.NETWORK");
    case "UNCONFIRMED":
      return forwardText("reason.UNCONFIRMED");
    default:
      return forwardText("reason.other");
  }
}

export function openForwardPicker(opts: ForwardPickerOptions): void {
  const source = getChannelMessages(opts.channelId).find((m) => m.id === opts.messageId);
  if (source === undefined || source.deleted || opts.signal.aborted) return;

  const hasFiles = source.attachments.length > 0;
  const owner = new Disposable();
  const { signal } = owner;
  let all: readonly ForwardTarget[] = listForwardTargets(opts.channelId, hasFiles);
  let selected: readonly number[] = [];
  let session: ForwardSession | null = null;
  let modal: ModalInstance | null = null;
  // While a batch is in flight the picker cannot be closed: a target would be dropped silently.
  let busy = false;

  const search = createElement("input", {
    class: "form-input",
    type: "text",
    placeholder: forwardText("search.placeholder"),
    "aria-label": forwardText("search.label"),
    "data-testid": "forward-search",
  });
  const list = createElement("div", {
    class: "quick-switcher__results",
    role: "group",
    "aria-label": forwardText("list.label"),
    "data-testid": "forward-list",
  });
  const empty = createElement("div", { class: "quick-switcher__empty", role: "status" });
  const counter = createElement("div", {
    class: "forward-hint",
    role: "status",
    "data-testid": "forward-counter",
  });
  const comment = createElement("textarea", {
    class: "form-input",
    rows: "2",
    maxlength: String(MAX_MESSAGE_LEN),
    placeholder: forwardText("comment.placeholder"),
    "aria-label": forwardText("comment.label"),
    "data-testid": "forward-comment",
  });
  const sendBtn = createElement(
    "button",
    { class: "btn-modal-save", type: "button", "data-testid": "forward-send" },
    forwardText("send"),
  );
  const cancelBtn = createElement(
    "button",
    { class: "btn-modal-cancel", type: "button", "data-testid": "forward-cancel" },
    shellText("common.cancel"),
  );

  const byId = (id: number): ForwardTarget | undefined => all.find((t) => t.id === id);

  function syncSelection(): void {
    const full = selected.length >= MAX_FORWARD_TARGETS;
    for (const box of list.querySelectorAll<HTMLInputElement>("input[type=checkbox]")) {
      const picked = selected.includes(Number(box.value));
      box.checked = picked;
      // At the cap, only the picked rows stay usable (to take one back off).
      box.disabled = full && !picked;
    }
    setText(
      counter,
      full
        ? forwardText("list.full", { max: MAX_FORWARD_TARGETS })
        : forwardText("list.selected", { count: selected.length, max: MAX_FORWARD_TARGETS }),
    );
    const none = selected.length === 0;
    sendBtn.toggleAttribute("disabled", none);
  }

  function renderList(): void {
    clearChildren(list);
    const shown = filterForwardTargets(all, search.value);
    setText(empty, shown.length === 0 ? forwardText("list.empty") : "");
    for (const t of shown) {
      const row = createElement("label", {
        class: "quick-switcher__item",
        "data-testid": `forward-target-${t.id}`,
      });
      const box = createElement("input", { type: "checkbox", value: String(t.id) });
      const icon = createElement("span", { class: "quick-switcher__icon" });
      icon.appendChild(iconFor(t));
      const parts: (Element | string)[] = [
        box,
        icon,
        createElement("span", { class: "quick-switcher__name" }, t.name),
      ];
      if (t.category !== null) {
        parts.push(createElement("span", { class: "quick-switcher__category" }, t.category));
      }
      appendChildren(row, ...parts);
      list.appendChild(row);
    }
    syncSelection();
  }

  function refreshTargets(): void {
    all = listForwardTargets(opts.channelId, hasFiles);
    selected = pruneSelection(selected, all);
    if (session === null) renderList();
  }

  // -- Results ---------------------------------------------------------------

  function resultLine(r: ForwardResult): HTMLElement {
    const target = byId(r.channelId);
    const label = target === undefined ? String(r.channelId) : labelOf(target);
    const status =
      r.status === "queued"
        ? forwardText("status.queued")
        : r.status === "sending"
          ? forwardText("status.sending")
          : r.status === "sent"
            ? forwardText("status.sent")
            : forwardText(r.forwarded ? "status.commentFailed" : "status.failed", {
                reason: reasonText(r.reason),
              });
    const row = createElement("div", {
      class: "quick-switcher__item",
      "data-testid": `forward-result-${r.channelId}`,
      "data-status": r.status,
    });
    appendChildren(
      row,
      createElement("span", { class: "quick-switcher__name" }, label),
      createElement("span", { class: "quick-switcher__category" }, status),
    );
    return row;
  }

  function finish(results: readonly ForwardResult[]): void {
    const failed = results.filter((r) => r.status === "failed");
    const sent = results.length - failed.length;
    if (failed.length === 0) {
      showToast(forwardText("toast.sent", { count: sent }), "success");
      modal?.destroy();
      return;
    }
    const first = failed[0]!;
    const target = byId(first.channelId);
    showToast(
      forwardText("toast.partial", {
        sent,
        total: results.length,
        name: target === undefined ? String(first.channelId) : labelOf(target),
        reason: reasonText(first.reason),
      }),
      "warning",
    );
  }

  function showResults(results: readonly ForwardResult[]): void {
    clearChildren(list);
    for (const r of results) list.appendChild(resultLine(r));
    busy = results.some((r) => r.status === "queued" || r.status === "sending");
    const failed = results.some((r) => r.status === "failed");
    closeBtn.toggleAttribute("disabled", busy);
    cancelBtn.toggleAttribute("disabled", busy);
    sendBtn.toggleAttribute("disabled", busy || !failed);
    setText(sendBtn, forwardText("retry"));
    setText(cancelBtn, forwardText("done"));
    if (!busy) finish(results);
  }

  function startSend(): void {
    if (selected.length === 0) return;
    if (session !== null) {
      void session.retryFailed();
      list.focus();
      return;
    }
    // From here the picker is a results list: the inputs are spent.
    search.hidden = true;
    comment.hidden = true;
    empty.hidden = true;
    counter.hidden = true;
    session = createForwardSession({
      ws: opts.ws,
      sourceMessageId: opts.messageId,
      channelIds: selected,
      comment: comment.value.trim(),
      onChange: showResults,
      signal,
    });
    // The results are a live region the user lands on: the Forward button is spent.
    list.setAttribute("tabindex", "-1");
    list.setAttribute("aria-live", "polite");
    showResults(session.results());
    list.focus();
    void session.start();
  }

  // -- Mount -----------------------------------------------------------------

  const header = createElement("div", { class: "modal-header" });
  const closeBtn = createElement("button", {
    class: "modal-close",
    type: "button",
    "aria-label": shellText("common.close"),
  });
  closeBtn.appendChild(createIcon("x", 14));
  appendChildren(
    header,
    createElement("h3", { id: "forward-title" }, forwardText("title")),
    closeBtn,
  );

  const preview = source.content.trim().slice(0, PREVIEW_CHARS);
  const body = createElement("div", { class: "modal-body" });
  appendChildren(
    body,
    ...(preview === "" ? [] : [createElement("div", { class: "forward-hint" }, preview)]),
    search,
    list,
    empty,
    counter,
    comment,
  );
  const footer = createElement("div", { class: "modal-footer" });
  appendChildren(footer, cancelBtn, sendBtn);

  modal = createModal(
    {
      content: header,
      onClose: () => {
        // Only an abort (a channel switch) gets here mid-batch: the controls are locked.
        const unsent = (session?.results() ?? []).filter(
          (r) => r.status === "queued" || r.status === "sending",
        ).length;
        owner.destroy();
        if (unsent > 0) showToast(forwardText("toast.stopped", { count: unsent }), "warning");
      },
      // Escape and the backdrop wait out a batch.
      closeOnBackdrop: false,
      onEscape: () => {
        if (!busy) modal?.destroy();
      },
      className: "forward-picker",
      overlayAttrs: { "data-testid": "forward-picker" },
      ariaLabelledBy: "forward-title",
      signal: opts.signal,
      ...(opts.fallbackFocus === undefined ? {} : { fallbackFocus: opts.fallbackFocus }),
    },
    document.body,
  );
  appendChildren(modal.modal, body, footer);

  closeOnBackdropClick(
    modal.overlay,
    () => {
      if (!busy) modal?.destroy();
    },
    signal,
  );
  closeBtn.addEventListener("click", () => modal?.destroy(), { signal });
  cancelBtn.addEventListener("click", () => modal?.destroy(), { signal });
  sendBtn.addEventListener("click", startSend, { signal });
  search.addEventListener("input", renderList, { signal });
  list.addEventListener(
    "change",
    (e) => {
      const box = e.target;
      if (!(box instanceof HTMLInputElement)) return;
      selected = toggleForwardTarget(selected, Number(box.value));
      syncSelection();
    },
    { signal },
  );
  owner.onStoreChange(channelsStore, (s) => s.channels, refreshTargets);
  owner.onStoreChange(dmStore, (s) => s.channels, refreshTargets);
  owner.onStoreChange(blocksStore, (s) => s.blockedByMe, refreshTargets);
  renderList();
  search.focus();
}
