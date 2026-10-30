/** What the message list shows in place of rows: welcome, loading and load error. */
import { createElement } from "@lib/dom";
import { messagingText } from "../../i18n/messaging";

export function renderEmptyState(channelName: string, channelType?: string): HTMLDivElement {
  const isDm = channelType === "dm";

  const icon = createElement("div", { class: "channel-welcome-icon" });
  icon.textContent = isDm ? "@" : "#";

  const title = createElement("h2", { class: "channel-welcome-title" });
  title.textContent = isDm
    ? channelName
    : messagingText("welcome.channel", { channel: channelName });

  const text = createElement("p", { class: "channel-welcome-text" });
  text.textContent = isDm
    ? messagingText("welcome.dmIntro", { name: channelName })
    : messagingText("welcome.channelIntro", { channel: channelName });

  const wrapper = createElement("div", { class: "channel-welcome" });
  wrapper.appendChild(icon);
  wrapper.appendChild(title);
  wrapper.appendChild(text);

  return wrapper;
}

/** In-region placeholder while the first page of history is loading. */
export function renderLoadingState(): HTMLDivElement {
  const wrapper = createElement("div", { class: "messages-loading" });
  wrapper.appendChild(createElement("div", { class: "spinner" }));
  const text = createElement("p", { class: "messages-loading-text" });
  text.textContent = messagingText("loading");
  wrapper.appendChild(text);
  return wrapper;
}

/** In-region inline error + Retry when the first-page history fetch failed. */
export function renderLoadErrorState(onRetryLoad?: () => void): HTMLDivElement {
  const wrapper = createElement("div", { class: "messages-load-error" });
  const text = createElement("p", { class: "messages-load-error-text" });
  text.textContent = messagingText("loadFailed");
  wrapper.appendChild(text);
  const retry = createElement("button", {
    class: "messages-retry-btn",
    "data-testid": "messages-retry",
  });
  retry.textContent = messagingText("retry");
  retry.addEventListener("click", () => onRetryLoad?.());
  wrapper.appendChild(retry);
  return wrapper;
}
