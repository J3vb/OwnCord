/**
 * The message list's DOM skeleton: the scroller with its spacers and content
 * container, the older-history rows, the scroll-to-bottom button, the unread
 * bar and the jump-to-present pill. Built once per mount; the other list
 * modules find these nodes on the state.
 */
import { createElement } from "@lib/dom";
import { markChannelRead } from "@lib/readState";
import { messagingText } from "../../../i18n/messaging";
import { renderUnreadBar } from "./renderers";
import type { ListState, ListApi } from "./listState";

export interface ListDom {
  readonly region: HTMLElement;
  readonly root: HTMLElement;
  readonly content: HTMLElement;
}

export function buildListDom(st: ListState, api: ListApi): ListDom {
  const region = createElement("div", { class: "messages-region" });
  st.region = region;
  // Focusable by script only (-1): the older-history Retry hands focus here.
  const root = createElement("div", { class: "messages-container", tabindex: "-1" });
  st.root = root;

  st.topSpacer = createElement("div", { class: "virtual-spacer-top" });
  const content = createElement("div", { class: "virtual-content" });
  st.contentContainer = content;
  st.bottomSpacer = createElement("div", { class: "virtual-spacer-bottom" });
  const scrollAnchor = createElement("div", { class: "scroll-anchor" });
  st.olderLoadingRow = createElement("div", {
    class: "messages-older-loading",
    role: "status",
    "aria-label": messagingText("loading"),
  });
  st.olderLoadingRow.appendChild(createElement("div", { class: "spinner" }));

  st.olderFailedRow = createElement("div", {
    class: "messages-older-failed",
    role: "alert",
    "data-testid": "messages-older-failed",
  });
  st.olderFailedRow.appendChild(
    createElement("span", { class: "messages-load-error-text" }, messagingText("loadFailed")),
  );
  const olderRetryBtn = createElement(
    "button",
    { class: "messages-retry-btn", type: "button", "data-testid": "messages-older-retry" },
    messagingText("retry"),
  );
  olderRetryBtn.addEventListener("click", api.retryOlder, { signal: st.disposable.signal });
  st.olderFailedRow.appendChild(olderRetryBtn);
  api.updateOlderFailedRow();

  st.scrollToBottomBtn = createElement("button", {
    class: "scroll-to-bottom-btn",
    "aria-label": messagingText("scrollToBottom"),
  });
  st.btnShownKey = "";
  st.scrollToBottomBtn.append("↓");
  st.scrollToBottomCount = createElement("span", {
    class: "scroll-to-bottom-count",
    "data-testid": "scroll-to-bottom-count",
    hidden: "",
  });
  st.scrollToBottomBtn.appendChild(st.scrollToBottomCount);
  st.scrollToBottomBtn.addEventListener(
    "click",
    () => {
      api.scrollToBottom();
      api.updateScrollToBottomBtn();
    },
    { signal: st.disposable.signal },
  );

  const unreadBarParts = renderUnreadBar(() => {
    markChannelRead(st.options.channelId);
    api.dismissUnreadBar();
  }, st.disposable.signal);
  st.unreadBar = unreadBarParts.bar;
  st.unreadBarLabel = unreadBarParts.label;
  st.unreadAnnouncer = unreadBarParts.announcer;

  st.jumpToPresentPill = createElement("button", {
    class: "jump-to-present-pill",
    "data-testid": "jump-to-present",
  });
  st.jumpToPresentPill.textContent = messagingText("jumpToPresent");
  st.jumpToPresentPill.addEventListener("click", () => st.options.onJumpToPresent?.(), {
    signal: st.disposable.signal,
  });

  root.appendChild(st.topSpacer);
  root.appendChild(st.contentContainer);
  root.appendChild(st.bottomSpacer);
  root.appendChild(scrollAnchor);
  region.appendChild(st.root);
  region.appendChild(st.olderFailedRow);
  region.appendChild(st.scrollToBottomBtn);
  region.appendChild(st.jumpToPresentPill);
  region.appendChild(st.unreadBar);
  region.appendChild(st.unreadAnnouncer);
  return { region, root, content };
}
