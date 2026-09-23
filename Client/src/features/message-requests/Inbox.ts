/**
 * The Message Requests inbox view (B9-5, Q2): text only, with the B9-6
 * decisions on each request.
 *
 * A request is from someone the reader has not accepted, so opening the inbox
 * must fetch nothing on their behalf. Every field is set as text: no avatar
 * (the adapter never keeps its URL), no message renderer, no link, embed,
 * attachment, emoji or mention lookup. Accepting a request (decisions.ts) is
 * the only way to the ordinary conversation.
 *
 * Rows are keyed by request id and kept while the request stays pending, so
 * a frame about one request never moves focus off another; a newer copy of
 * the request redraws only its sender line and preview. When the row
 * holding focus leaves, focus moves to the next request's row, else the
 * previous one, else the view's heading. The row, not its Accept button: a
 * repeated Enter must not trust a different sender.
 */

import type { DmRequestDecision } from "@lib/api";
import { createElement, setText } from "@lib/dom";
import type { ModalInstance } from "@lib/modalFactory";
import { uiStore } from "@stores/ui.store";
import { formatDate } from "../../i18n/format";
import { messageRequestsText as t } from "../../i18n/messageRequests";
import type { MessageRequest } from "./api";
import { confirmDecision, decide, openAcceptedConversation } from "./decisions";
import { messageRequestsStore } from "./store";
import { requestsApi } from "./sync";

/** Each decision's copy, in the order its buttons appear. */
const DECISIONS = {
  accept: { action: "action.accept", working: "working.accept", done: "done.accept" },
  ignore: { action: "action.ignore", working: "working.ignore", done: "done.ignore" },
  delete: { action: "action.delete", working: "working.delete", done: "done.delete" },
  block: { action: "action.block", working: "working.block", done: "done.block" },
} as const satisfies Record<DmRequestDecision, unknown>;

interface Row {
  readonly li: HTMLLIElement;
  /** The latest store copy; its shown fields are refreshed in place. */
  request: MessageRequest;
  head: HTMLElement;
  text: HTMLElement;
  readonly actions: HTMLElement;
  readonly buttons: ReadonlyMap<DmRequestDecision, HTMLButtonElement>;
  readonly error: HTMLParagraphElement;
  busy: boolean;
  /** Its open confirm dialog, which closes when the row leaves. */
  dialog: ModalInstance | null;
}

const senderName = (r: MessageRequest): string =>
  r.sender.displayName || r.sender.username || t("unknownSender");

const sameShown = (a: MessageRequest, b: MessageRequest): boolean =>
  a.sender.displayName === b.sender.displayName &&
  a.sender.username === b.sender.username &&
  a.preview?.content === b.preview?.content &&
  a.createdAt === b.createdAt;

/** The row's sender line and preview, all plain text. */
function renderShown(r: MessageRequest): { head: HTMLElement; text: HTMLElement } {
  const name = senderName(r);
  const head = createElement("div", { class: "requests-item-head" });
  head.appendChild(createElement("h3", { class: "requests-sender" }, name));
  if (r.sender.username !== "" && r.sender.username !== name) {
    head.appendChild(
      createElement("span", { class: "requests-username" }, `@${r.sender.username}`),
    );
  }
  const at = new Date(r.createdAt);
  if (!Number.isNaN(at.getTime())) {
    head.appendChild(
      createElement(
        "time",
        { class: "requests-time", datetime: r.createdAt },
        formatDate(at, { dateStyle: "medium", timeStyle: "short" }),
      ),
    );
  }
  const text =
    r.preview === null
      ? createElement("p", { class: "requests-preview requests-preview-empty" }, t("noText"))
      : createElement("p", { class: "requests-preview" }, r.preview.content);
  return { head, text };
}

function setBusy(row: Row, decision: DmRequestDecision | null): void {
  row.busy = decision !== null;
  row.li.setAttribute("aria-busy", String(row.busy));
  for (const [d, b] of row.buttons) {
    // aria-disabled, not disabled: a disabled button drops focus to <body>.
    b.setAttribute("aria-disabled", String(row.busy));
    setText(b, d === decision ? t(DECISIONS[d].working) : t(DECISIONS[d].action));
  }
}

/** Fill the inbox view's root (view.ts loads this module on first open). */
export function renderInbox(root: HTMLElement, signal: AbortSignal): void {
  const intro = createElement("p", { class: "requests-intro" }, t("intro"));
  const help = createElement("p", { class: "requests-intro" }, t("decisionsHelp"));
  const status = createElement("p", {
    class: "requests-status",
    role: "status",
    "data-testid": "requests-status",
  });
  // What the last decision did. Its own region, so the list state never talks over it.
  const outcome = createElement("p", {
    class: "requests-status",
    role: "status",
    "data-testid": "requests-outcome",
  });
  // The list scrolls, so it takes focus: arrow keys scroll it everywhere.
  const list = createElement("ul", {
    class: "requests-list",
    "aria-label": t("listLabel"),
    tabindex: "0",
    "data-testid": "requests-list",
  });
  root.append(intro, help, status, outcome, list);

  const rows = new Map<number, Row>();
  const say = (message: string): void => setText(outcome, message);

  const run = (row: Row, decision: DmRequestDecision): void => {
    if (row.busy) return;
    const r = row.request;
    const name = senderName(r);
    const api = requestsApi();
    const decideDmRequest = api?.decideDmRequest;
    setBusy(row, decision);
    row.error.hidden = true;
    say("");
    const pending =
      decideDmRequest === undefined
        ? Promise.resolve("failed" as const)
        : decide({ decideDmRequest }, r, decision, signal);
    void pending.then((result) => {
      if (result === "aborted") return;
      // A decided row stays busy until the store's next render removes it.
      if (result !== "done") setBusy(row, null);
      if (result === "done") {
        say(t(DECISIONS[decision].done, { name }));
        if (decision === "accept" && decideDmRequest !== undefined) {
          openAcceptedConversation(
            r.channelId,
            { decideDmRequest, getDmChannels: api?.getDmChannels },
            signal,
          );
        }
      } else if (result === "stale") {
        say(t("stale", { name }));
      } else {
        const message = t("failed", { name });
        setText(row.error, message);
        row.error.hidden = false;
        say(message);
      }
    });
  };

  const renderRow = (r: MessageRequest): Row => {
    const li = createElement("li", {
      class: "requests-item",
      tabindex: "-1",
      "data-testid": "request-item",
    });
    const { head, text } = renderShown(r);
    const actions = createElement("div", {
      class: "requests-actions",
      role: "group",
      "aria-label": t("actions.label", { name: senderName(r) }),
    });
    const buttons = new Map<DmRequestDecision, HTMLButtonElement>();
    const error = createElement("p", {
      class: "requests-item-error",
      "data-testid": "request-error",
    });
    error.hidden = true;
    const row: Row = {
      li,
      request: r,
      head,
      text,
      actions,
      buttons,
      error,
      busy: false,
      dialog: null,
    };
    for (const d of Object.keys(DECISIONS) as DmRequestDecision[]) {
      const b = createElement(
        "button",
        {
          type: "button",
          class: d === "accept" ? "btn-modal-save" : "btn-modal-cancel",
          "data-testid": `request-${d}`,
          "aria-disabled": "false",
        },
        t(DECISIONS[d].action),
      );
      b.addEventListener(
        "click",
        () => {
          if (row.busy) return;
          if (d === "delete" || d === "block") {
            row.dialog = confirmDecision(row.request, d, senderName(row.request), signal, {
              onConfirm: () => run(row, d),
              onClose: () => {
                row.dialog = null;
              },
            });
          } else {
            run(row, d);
          }
        },
        { signal },
      );
      buttons.set(d, b);
      actions.appendChild(b);
    }
    li.append(head, text, actions, error);
    return row;
  };

  /** Show a newer copy of a kept row's request. Its buttons, busy state and dialog stay. */
  const refresh = (row: Row, r: MessageRequest): void => {
    const same = sameShown(row.request, r);
    row.request = r;
    if (same) return;
    const { head, text } = renderShown(r);
    row.head.replaceWith(head);
    row.text.replaceWith(text);
    row.head = head;
    row.text = text;
    row.actions.setAttribute("aria-label", t("actions.label", { name: senderName(r) }));
  };

  /** Focus the row after the one that left (else the one before), else the heading. */
  const refocus = (index: number, pending: readonly MessageRequest[]): void => {
    const next = pending[index] ?? pending[index - 1];
    const target =
      (next !== undefined ? rows.get(next.id)?.li : undefined) ??
      root.closest(".feature-view")?.querySelector<HTMLElement>(".feature-view-title");
    target?.focus();
  };

  let shown: readonly MessageRequest[] | null = null;
  const render = (): void => {
    const { status: state, pending } = messageRequestsStore.getState();
    const connected = uiStore.getState().connectionStatus === "connected";
    const message = !connected
      ? t("reconnecting")
      : state === "loading"
        ? t("loading")
        : state === "unavailable"
          ? t("unavailable")
          : pending.length === 0
            ? t("empty")
            : "";
    // A live region re-reads what it is given; only speak on a change.
    if (status.textContent !== message) setText(status, message);
    if (pending === shown) return;
    shown = pending;

    const keep = new Set(pending.map((r) => r.id));
    let focusLeftAt: number | null = null;
    let index = 0;
    for (const [id, row] of rows) {
      if (keep.has(id)) {
        index++;
        continue;
      }
      // Focus is on the row, or in its confirm dialog, which closes with it.
      if (row.li.contains(document.activeElement) || row.dialog !== null) focusLeftAt ??= index;
      row.dialog?.destroy();
      row.li.remove();
      rows.delete(id);
    }
    // Newest first, and ids only grow: an existing row never moves, new ones slot in.
    let before: Element | null = null;
    for (let i = pending.length - 1; i >= 0; i--) {
      const r = pending[i]!;
      const existing = rows.get(r.id);
      if (existing !== undefined) {
        refresh(existing, r);
        before = existing.li;
        continue;
      }
      const row = renderRow(r);
      list.insertBefore(row.li, before);
      rows.set(r.id, row);
      before = row.li;
    }
    // Map order must follow the list for the next removal's index.
    const ordered = pending.map((r) => [r.id, rows.get(r.id)!] as const);
    rows.clear();
    for (const [id, row] of ordered) rows.set(id, row);
    // The list itself is a tab stop; hiding it would drop focus to the body.
    if (pending.length === 0 && list.contains(document.activeElement)) focusLeftAt ??= 0;
    list.hidden = pending.length === 0;
    if (focusLeftAt !== null) refocus(focusLeftAt, pending);
  };
  render();
  const unsubs = [
    messageRequestsStore.subscribe(render),
    uiStore.subscribeSelector((s) => s.connectionStatus, render),
  ];
  signal.addEventListener("abort", () => unsubs.forEach((u) => u()), { once: true });
}
