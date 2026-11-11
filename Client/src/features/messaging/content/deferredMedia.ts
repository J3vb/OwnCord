import { createElement } from "../../../lib/dom";
import { contentText } from "../../../i18n/content";
import { formatFileSize } from "./attachmentUrls";

/** No image element, image URL or fetch exists before this item's own tap. */
export function renderDeferredMedia(
  name: string,
  load: () => HTMLDivElement,
  size?: number,
): HTMLDivElement {
  const wrap = createElement("div", { class: "data-saver-item", "data-data-saver": "waiting" });
  const button = createElement("button", {
    type: "button",
    class: "messages-retry-btn data-saver-placeholder",
  });
  button.appendChild(createElement("span", { class: "data-saver-name" }, name));
  if (size !== undefined && size >= 0) {
    button.appendChild(createElement("span", { class: "data-saver-size" }, formatFileSize(size)));
  }
  button.appendChild(
    createElement("span", { class: "data-saver-action" }, contentText("media.tapToLoad")),
  );
  let loaded = false;
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    if (loaded) return;
    loaded = true;
    const hadFocus = button.contains(document.activeElement);
    button.disabled = true;
    const media = load();
    wrap.dataset.dataSaver = "loaded";
    wrap.replaceChildren(media);
    if (hadFocus) {
      media.tabIndex = -1;
      media.focus();
    }
  });
  wrap.appendChild(button);
  return wrap;
}

export function mediaName(url: string): string {
  try {
    const parsed = new URL(url);
    return decodeURIComponent(parsed.pathname.split("/").pop() || parsed.hostname);
  } catch {
    return url;
  }
}
