/** The media gallery's toolbar: file name search, uploader filter and sort order. */

import { createElement, appendChildren, setOwnedTimeout } from "@lib/dom";
import type { ChannelMediaQuery } from "@lib/types";
import { mediaGalleryText } from "../../i18n/mediaGallery";

/** Quiet period after the last keystroke before a name search runs. */
export const MEDIA_SEARCH_DEBOUNCE_MS = 300;

export interface MediaUploader {
  readonly id: number;
  readonly name: string;
}

export type MediaOrder = NonNullable<ChannelMediaQuery["order"]>;

export interface ToolbarHandlers {
  /** A name search settled: the trimmed text, after the debounce. */
  readonly onSearch: (text: string) => void;
  /** The uploader filter changed; undefined is "anyone". */
  readonly onUploader: (uploaderId: number | undefined) => void;
  readonly onOrder: (order: MediaOrder) => void;
}

export function buildToolbar(
  uploaders: readonly MediaUploader[],
  signal: AbortSignal,
  handlers: ToolbarHandlers,
): HTMLDivElement {
  const toolbar = createElement("div", { class: "media-gallery__toolbar" });
  const search = createElement("input", {
    type: "search",
    class: "media-gallery__search",
    placeholder: mediaGalleryText("search.placeholder"),
    "aria-label": mediaGalleryText("search.label"),
    maxlength: "100",
  });
  let cancelDebounce: (() => void) | null = null;
  search.addEventListener(
    "input",
    () => {
      cancelDebounce?.();
      cancelDebounce = setOwnedTimeout(
        signal,
        () => handlers.onSearch(search.value.trim()),
        MEDIA_SEARCH_DEBOUNCE_MS,
      );
    },
    { signal },
  );

  const from = createElement("select", {
    class: "media-gallery__select",
    "aria-label": mediaGalleryText("from.label"),
  });
  from.appendChild(createElement("option", { value: "" }, mediaGalleryText("from.anyone")));
  for (const u of uploaders) {
    from.appendChild(createElement("option", { value: String(u.id) }, u.name));
  }
  from.addEventListener(
    "change",
    () => handlers.onUploader(from.value === "" ? undefined : Number(from.value)),
    { signal },
  );

  const sort = createElement("select", {
    class: "media-gallery__select",
    "aria-label": mediaGalleryText("order.label"),
  });
  appendChildren(
    sort,
    createElement("option", { value: "newest" }, mediaGalleryText("order.newest")),
    createElement("option", { value: "oldest" }, mediaGalleryText("order.oldest")),
  );
  sort.addEventListener(
    "change",
    () => handlers.onOrder(sort.value === "oldest" ? "oldest" : "newest"),
    { signal },
  );

  appendChildren(toolbar, search, from, sort);
  return toolbar;
}
