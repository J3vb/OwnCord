/**
 * The Message Requests inbox view (B9-5, Q2): read-only, text only.
 *
 * A request is from someone the reader has not accepted, so opening the inbox
 * must fetch nothing on their behalf. Every field is set as text: no avatar
 * (the adapter never keeps its URL), no message renderer, no link, embed,
 * attachment, emoji or mention lookup. Accepting a request, and with it the
 * ordinary conversation, is B9-6.
 */

import { createElement, setText, clearChildren } from "@lib/dom";
import { uiStore } from "@stores/ui.store";
import { formatDate } from "../../i18n/format";
import { messageRequestsText as t } from "../../i18n/messageRequests";
import type { MessageRequest } from "./api";
import { messageRequestsStore } from "./store";

function renderRequest(r: MessageRequest): HTMLLIElement {
  const name = r.sender.displayName || r.sender.username || t("unknownSender");
  const item = createElement("li", { class: "requests-item", "data-testid": "request-item" });
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
  item.append(head, text);
  return item;
}

/** The requests destination's view builder (navigation/destinations.ts). */
export function buildInbox({ signal }: { readonly signal: AbortSignal }): HTMLElement {
  const root = createElement("div", { class: "requests-inbox", "data-testid": "requests-inbox" });
  const intro = createElement("p", { class: "requests-intro" }, t("intro"));
  const status = createElement("p", {
    class: "requests-status",
    role: "status",
    "data-testid": "requests-status",
  });
  // The list scrolls, so it takes focus: arrow keys scroll it everywhere.
  const list = createElement("ul", {
    class: "requests-list",
    "aria-label": t("listLabel"),
    tabindex: "0",
    "data-testid": "requests-list",
  });
  root.append(intro, status, list);

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
    status.hidden = message === "";
    if (pending !== shown) {
      shown = pending;
      clearChildren(list);
      list.append(...pending.map(renderRequest));
      list.hidden = pending.length === 0;
    }
  };
  render();
  const unsubs = [
    messageRequestsStore.subscribe(render),
    uiStore.subscribeSelector((s) => s.connectionStatus, render),
  ];
  signal.addEventListener("abort", () => unsubs.forEach((u) => u()), { once: true });
  return root;
}
