/**
 * My uploads settings tab: how much of the upload quota is used, and every
 * file the viewer has uploaded (sent, unsent, in a deleted message, or in
 * use as an avatar, banner or group icon) with a way to remove the ones that
 * can go. Removing asks first, frees the space at once and, if a message
 * held the file, the server tells its readers.
 */

import type { ApiClient } from "@lib/api";
import { ApiClientError, errorText } from "@lib/api";
import { createElement, appendChildren, setOwnedTimeout } from "@lib/dom";
import { Disposable } from "@lib/disposable";
import { createIcon } from "@lib/icons";
import { parseTimestamp } from "@lib/text/formatting";
import type { Attachment, UserStorage, UserUploadItem, UserUploadsQuery } from "@lib/types";
import { channelsStore } from "@stores/channels.store";
import { createConfirmModal } from "../dialogs/confirmModal";
import { formatDate } from "../../i18n/format";
import { settingsText as t } from "../../i18n/settings";

/** Quiet period after the last keystroke before a name search runs. */
export const UPLOADS_SEARCH_DEBOUNCE_MS = 300;
/** Uploads per page. */
export const UPLOADS_PAGE_SIZE = 50;
/** The usage bar turns to its warning colour from this share of the quota. */
export const UPLOADS_WARN_RATIO = 0.9;

/**
 * The attachment helpers the tab needs, supplied by the page: the code that
 * formats sizes and fetches authenticated thumbnails lives in the UI layer,
 * which a feature does not import.
 */
export interface UploadsMedia {
  formatFileSize(bytes: number): string;
  isImage(mime: string): boolean;
  /** An object URL for the file's thumbnail, or null when it cannot be fetched. */
  thumbnail(att: Attachment): Promise<string | null>;
}

export type MyUploadsApi = Pick<
  ApiClient,
  "getUserStorage" | "listUserUploads" | "removeUserUpload"
>;

type Sort = NonNullable<UserUploadsQuery["sort"]>;

/** The usage line's text: "X used of Y", or "X used, no limit". */
export function usageText(
  storage: UserStorage,
  formatFileSize: UploadsMedia["formatFileSize"],
): string {
  return storage.quota_bytes > 0
    ? t("uploads.usage.of", {
        used: formatFileSize(storage.used_bytes),
        quota: formatFileSize(storage.quota_bytes),
      })
    : t("uploads.usage.noLimit", { used: formatFileSize(storage.used_bytes) });
}

/** Where a file lives, from the client's own channel and DM names. */
export function uploadLocation(item: UserUploadItem): string {
  switch (item.state) {
    case "pending":
      return t("uploads.where.pending");
    case "avatar":
      return t("uploads.where.avatar");
    case "banner":
      return t("uploads.where.banner");
    case "group_icon":
      return t("uploads.where.groupIcon");
    case "deleted":
      return t("uploads.where.deleted");
    case "message":
    default: {
      const channel =
        item.channel_id === null
          ? undefined
          : channelsStore.getState().channels.get(item.channel_id);
      if (channel === undefined) return t("uploads.where.unavailable");
      return channel.type === "dm"
        ? t("uploads.where.dm", { name: channel.name })
        : t("uploads.where.channel", { name: channel.name });
    }
  }
}

function loadThumb(
  media: UploadsMedia,
  img: HTMLImageElement,
  att: Attachment,
  scope: Disposable,
): void {
  void media.thumbnail(att).then((url) => {
    if (scope.signal.aborted) return;
    if (url === null) img.replaceWith(createIcon("image", 20));
    else img.src = url;
  });
}

export function buildMyUploadsTab(
  signal: AbortSignal,
  api: MyUploadsApi,
  media: UploadsMedia,
): HTMLDivElement {
  const { formatFileSize } = media;
  const pane = createElement("div", { class: "settings-pane active my-uploads" });
  pane.appendChild(createElement("div", { class: "setting-desc" }, t("uploads.intro")));

  // ---- Usage bar ----
  const usage = createElement("div", {
    class: "my-uploads__usage",
    "data-testid": "uploads-usage",
  });
  usage.hidden = true;
  const usageLabel = createElement("div", { class: "my-uploads__usage-text" });
  const bar = createElement("div", {
    class: "my-uploads__bar",
    role: "progressbar",
    "aria-label": t("uploads.usage.label"),
    "aria-valuemin": "0",
    "aria-valuemax": "100",
  });
  const fill = createElement("div", { class: "my-uploads__bar-fill" });
  bar.appendChild(fill);
  appendChildren(usage, usageLabel, bar);

  // ---- Controls ----
  const controls = createElement("div", { class: "my-uploads__controls" });
  const sortGroup = createElement("div", {
    class: "my-uploads__sort",
    role: "group",
    "aria-label": t("uploads.sort.label"),
  });
  const sortButtons = new Map<Sort, HTMLButtonElement>();
  for (const key of ["newest", "largest"] as const) {
    const btn = createElement(
      "button",
      {
        type: "button",
        class: "my-uploads__sort-btn",
        "data-sort": key,
        "aria-pressed": String(key === "newest"),
      },
      t(key === "newest" ? "uploads.sort.newest" : "uploads.sort.largest"),
    );
    sortButtons.set(key, btn);
    sortGroup.appendChild(btn);
  }
  const search = createElement("input", {
    type: "search",
    class: "my-uploads__search",
    placeholder: t("uploads.search.placeholder"),
    "aria-label": t("uploads.search.label"),
    maxlength: "100",
  });
  appendChildren(controls, sortGroup, search);

  // ---- List ----
  const list = createElement("ul", { class: "my-uploads__list" });
  const status = createElement("div", { class: "my-uploads__status", role: "status" });
  status.hidden = true;
  const more = createElement(
    "button",
    { type: "button", class: "btn-ghost my-uploads__more", "data-testid": "uploads-more" },
    t("uploads.loadMore"),
  );
  more.hidden = true;
  appendChildren(pane, usage, controls, list, status, more);

  let sort: Sort = "newest";
  let nameQuery = "";
  let cursor = "";
  let loading = false;
  let queryScope = new Disposable();
  signal.addEventListener("abort", () => queryScope.destroy(), { once: true });
  const rows = new Map<string, HTMLLIElement>();
  /** Files removed in this tab: a page requested before the remove must not bring one back. */
  const removedIds = new Set<string>();
  let usageSeq = 0;

  function currentQuery(): UserUploadsQuery {
    return {
      sort,
      limit: UPLOADS_PAGE_SIZE,
      ...(nameQuery !== "" ? { q: nameQuery } : {}),
      ...(cursor !== "" ? { cursor } : {}),
    };
  }

  function setStatus(text: string | null, retry?: () => void): void {
    status.textContent = "";
    status.hidden = text === null;
    if (text === null) return;
    status.appendChild(createElement("span", {}, text));
    if (retry !== undefined) {
      const btn = createElement(
        "button",
        { type: "button", class: "btn-ghost my-uploads__retry" },
        t("uploads.retry"),
      );
      btn.addEventListener("click", retry, { signal: queryScope.signal });
      status.appendChild(btn);
    }
  }

  function showUsage(storage: UserStorage): void {
    usage.hidden = false;
    usageLabel.textContent = usageText(storage, formatFileSize);
    if (storage.quota_bytes > 0) {
      const ratio = Math.min(1, storage.used_bytes / storage.quota_bytes);
      bar.hidden = false;
      bar.setAttribute("aria-valuenow", String(Math.round(ratio * 100)));
      fill.style.width = `${ratio * 100}%`;
      usage.classList.toggle("is-warning", ratio >= UPLOADS_WARN_RATIO);
    } else {
      bar.hidden = true;
      usage.classList.remove("is-warning");
    }
  }

  function refreshUsage(): void {
    const seq = ++usageSeq;
    api.getUserStorage(signal).then(
      (storage) => {
        if (!signal.aborted && seq === usageSeq) showUsage(storage);
      },
      () => {
        // Keep the figure already shown; the list is the page's main job.
      },
    );
  }

  function renderRow(item: UserUploadItem, scope: Disposable): HTMLLIElement {
    const att = item.attachment;
    const row = createElement("li", {
      class: "my-uploads__row",
      "data-attachment-id": att.id,
      "data-state": item.state,
    });
    const thumb = createElement("span", { class: "my-uploads__thumb" });
    if (media.isImage(att.mime)) {
      const img = createElement("img", { alt: "", draggable: "false" });
      thumb.appendChild(img);
      loadThumb(media, img, att, scope);
    } else {
      thumb.appendChild(createIcon("file-text", 20));
    }
    const text = createElement("span", { class: "my-uploads__text" });
    const when = formatDate(parseTimestamp(item.uploaded_at), {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
    appendChildren(
      text,
      createElement("span", { class: "my-uploads__name", title: att.filename }, att.filename),
      createElement(
        "span",
        { class: "my-uploads__meta" },
        t("uploads.meta", { size: formatFileSize(att.size), date: when }),
      ),
      createElement("span", { class: "my-uploads__where" }, uploadLocation(item)),
    );
    appendChildren(row, thumb, text);
    if (item.removable) {
      const btn = createElement(
        "button",
        {
          type: "button",
          class: "btn-ghost my-uploads__remove",
          "aria-label": t("uploads.removeLabel", { name: att.filename }),
        },
        t("uploads.remove"),
      );
      btn.addEventListener("click", () => confirmRemove(item, btn), { signal: scope.signal });
      row.appendChild(btn);
    }
    return row;
  }

  function showEmptyIfDrained(): void {
    if (rows.size > 0 || loading) return;
    if (cursor !== "") void loadMore();
    else setStatus(nameQuery !== "" ? t("uploads.emptyFiltered") : t("uploads.empty"));
  }

  function removeRow(id: string): void {
    rows.get(id)?.remove();
    rows.delete(id);
    removedIds.add(id);
    showEmptyIfDrained();
  }

  function confirmRemove(item: UserUploadItem, opener: HTMLElement): void {
    const att = item.attachment;
    // Mounted in the settings overlay: the body would stack beneath it.
    const container = opener.closest("[data-testid='settings-overlay']") ?? document.body;
    createConfirmModal(
      {
        title: t("uploads.confirm.title"),
        body: t("uploads.confirm.body", { name: att.filename, size: formatFileSize(att.size) }),
        confirmLabel: t("uploads.remove"),
        busyLabel: t("uploads.confirm.busy"),
        testId: "uploads-remove-confirm",
        confirmTestId: "uploads-remove-confirm-btn",
        staysOpen: true,
        signal,
        fallbackFocus: () => opener,
        onConfirm: async () => {
          try {
            await api.removeUserUpload(att.id);
          } catch (err) {
            // Already gone (another device, or the message was deleted): the
            // goal is met, so the row just leaves.
            if (!(err instanceof ApiClientError && err.status === 404)) throw err;
          }
          removeRow(att.id);
          refreshUsage();
        },
        failureText: (err) =>
          err instanceof ApiClientError && err.status === 409
            ? t("uploads.inUse")
            : errorText(err, t("uploads.removeFailed")),
      },
      container,
    );
  }

  async function loadMore(): Promise<void> {
    if (loading) return;
    loading = true;
    const scope = queryScope;
    const first = rows.size === 0;
    if (first) setStatus(t("uploads.loading"));
    more.hidden = true;
    try {
      const page = await api.listUserUploads(currentQuery(), scope.signal);
      if (scope.signal.aborted) return;
      for (const item of page.items) {
        if (rows.has(item.attachment.id) || removedIds.has(item.attachment.id)) continue;
        const row = renderRow(item, scope);
        rows.set(item.attachment.id, row);
        list.appendChild(row);
      }
      cursor = page.next_cursor ?? "";
      more.hidden = cursor === "";
      setStatus(null);
      loading = false;
      if (rows.size === 0) showEmptyIfDrained();
    } catch {
      if (scope.signal.aborted) return;
      loading = false;
      setStatus(t("uploads.loadFailed"), () => void loadMore());
    }
  }

  /** Start over with the current sort and search. */
  function reload(): void {
    queryScope.destroy();
    queryScope = new Disposable();
    cursor = "";
    loading = false;
    rows.clear();
    list.textContent = "";
    more.hidden = true;
    void loadMore();
  }

  for (const [key, btn] of sortButtons) {
    btn.addEventListener(
      "click",
      () => {
        if (key === sort) return;
        sort = key;
        for (const [k, b] of sortButtons) b.setAttribute("aria-pressed", String(k === sort));
        reload();
      },
      { signal },
    );
  }

  let cancelDebounce: (() => void) | null = null;
  search.addEventListener(
    "input",
    () => {
      cancelDebounce?.();
      cancelDebounce = setOwnedTimeout(
        signal,
        () => {
          const next = search.value.trim();
          if (next === nameQuery) return;
          nameQuery = next;
          reload();
        },
        UPLOADS_SEARCH_DEBOUNCE_MS,
      );
    },
    { signal },
  );

  more.addEventListener("click", () => void loadMore(), { signal });

  refreshUsage();
  void loadMore();
  return pane;
}
