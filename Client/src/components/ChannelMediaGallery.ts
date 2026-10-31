/**
 * ChannelMediaGallery — a channel's files as a phone-style gallery: a photo
 * and video grid (Media) or a list (Files), grouped by month, with a file
 * name search, an uploader filter, a newest/oldest toggle and a month list
 * that jumps the walk to a month. Clicking an item jumps to its message.
 *
 * The panel only renders: the controller supplies the page and month loaders
 * (the server gates each page on channel read) and closes it on a jump.
 */

import { Disposable } from "@lib/disposable";
import { createElement, appendChildren, setOwnedTimeout } from "@lib/dom";
import { createIcon } from "@lib/icons";
import type { IconName } from "@lib/icons";
import type { MountableComponent } from "@lib/text/safeRender";
import { parseTimestamp } from "@lib/text/formatting";
import type {
  ChannelMediaItem,
  ChannelMediaMonthsResponse,
  ChannelMediaPage,
  ChannelMediaQuery,
  UserStorage,
} from "@lib/types";
import { formatDate, formatNumber } from "../i18n/format";
import { mediaGalleryText } from "../i18n/mediaGallery";
import { isSpoilerFilename } from "../features/messaging/spoilerAttachment";
import {
  fetchImageAsObjectUrl,
  formatFileSize,
  isImageMime,
  isVideoAttachment,
  isAudioMime,
  resolveServerUrl,
  thumbnailUrl,
} from "../features/messaging/content/attachments";

/** Quiet period after the last keystroke before a name search runs. */
export const MEDIA_SEARCH_DEBOUNCE_MS = 300;
/** Items per page; one grid screen is about 30 tiles. */
export const MEDIA_PAGE_SIZE = 60;

export interface MediaUploader {
  readonly id: number;
  readonly name: string;
}

export interface ChannelMediaGalleryOptions {
  readonly channelName: string;
  readonly loadPage: (query: ChannelMediaQuery, signal: AbortSignal) => Promise<ChannelMediaPage>;
  readonly loadMonths: (
    query: ChannelMediaQuery,
    signal: AbortSignal,
  ) => Promise<ChannelMediaMonthsResponse>;
  /** The members the uploader filter offers, read when the panel opens. */
  readonly uploaders: () => readonly MediaUploader[];
  readonly onJumpToMessage: (messageId: number) => void;
  /** The caller's upload usage, read once when the Files tab first opens. */
  readonly loadStorage?: (signal: AbortSignal) => Promise<UserStorage>;
  /** Opens Settings at My uploads. Without it the usage line has no link. */
  readonly onManageUploads?: () => void;
  readonly onClose: () => void;
  /** IANA zone months are counted in; the browser's own when omitted. */
  readonly timeZone?: string;
}

export interface ChannelMediaGalleryPanel extends MountableComponent {
  destroy(): void;
  /** Drop the items of deleted messages in place. */
  removeMessages(messageIds: readonly number[]): void;
  /** Drop the items of a message whose attachment is no longer in `remainingIds`. */
  syncMessageAttachments(messageId: number, remainingIds: readonly string[]): void;
}

type Kind = ChannelMediaQuery["kind"];
type Order = NonNullable<ChannelMediaQuery["order"]>;

/** "YYYY-MM" of a timestamp in the viewer's local calendar. */
export function localMonthKey(timestamp: string): string {
  const d = parseTimestamp(timestamp);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function monthLabel(key: string, style: "long" | "short"): string {
  const [y, m] = key.split("-").map(Number);
  if (y === undefined || m === undefined || Number.isNaN(y) || Number.isNaN(m)) return key;
  return style === "long"
    ? formatDate(new Date(y, m - 1, 1), { month: "long", year: "numeric" })
    : formatDate(new Date(y, m - 1, 1), { month: "short" });
}

function fileIcon(item: ChannelMediaItem): IconName {
  const att = item.attachment;
  if (att.duration_ms !== undefined && att.waveform !== undefined) return "mic";
  if (isAudioMime(att.mime)) return "music";
  if (isImageMime(att.mime)) return "image";
  return "file-text";
}

function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** The usage line's text: "You've used X of Y", or "X used" with no limit. */
export function storageUsageText(storage: UserStorage): string {
  return storage.quota_bytes > 0
    ? mediaGalleryText("usage.of", {
        used: formatFileSize(storage.used_bytes),
        quota: formatFileSize(storage.quota_bytes),
      })
    : mediaGalleryText("usage.noLimit", { used: formatFileSize(storage.used_bytes) });
}

function renderFileRow(item: ChannelMediaItem): HTMLButtonElement {
  const att = item.attachment;
  const row = createElement("button", {
    type: "button",
    class: "media-gallery__file",
    "aria-label": mediaGalleryText("item.open", { name: att.filename }),
    "data-message-id": String(item.message_id),
    "data-attachment-id": att.id,
  });
  const icon = createElement("span", { class: "media-gallery__file-icon" });
  icon.appendChild(createIcon(fileIcon(item), 20));
  const text = createElement("span", { class: "media-gallery__file-text" });
  const name = createElement("span", { class: "media-gallery__file-name" }, att.filename);
  const size =
    att.duration_ms !== undefined ? formatDuration(att.duration_ms) : formatFileSize(att.size);
  const when = formatDate(parseTimestamp(item.timestamp), { day: "numeric", month: "short" });
  const meta = createElement(
    "span",
    { class: "media-gallery__file-meta" },
    mediaGalleryText("file.meta", { size, user: item.user.username, date: when }),
  );
  appendChildren(text, name, meta);
  appendChildren(row, icon, text);
  return row;
}

export function createChannelMediaGallery(
  options: ChannelMediaGalleryOptions,
): ChannelMediaGalleryPanel {
  const disposable = new Disposable();
  const timeZone = options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

  let kind: Kind = "media";
  let order: Order = "newest";
  let nameQuery = "";
  let uploader: number | undefined;
  let startMonth: string | undefined;

  let root: HTMLDivElement | null = null;
  let body: HTMLDivElement | null = null;
  let list: HTMLDivElement | null = null;
  let monthNav: HTMLElement | null = null;
  let sentinel: HTMLDivElement | null = null;
  let statusEl: HTMLDivElement | null = null;
  let usageEl: HTMLDivElement | null = null;
  let usageRequested = false;
  const tabs = new Map<Kind, HTMLButtonElement>();

  // One scope per query: a filter change destroys it, which aborts the
  // in-flight requests and drops their late answers.
  let queryScope = new Disposable();
  let cursor = "";
  let hasMore = false;
  let loading = false;
  let lastSection: { key: string; content: HTMLElement } | null = null;
  const tilesByMessage = new Map<number, HTMLElement[]>();

  let tileObserver: IntersectionObserver | null = null;
  let moreObserver: IntersectionObserver | null = null;

  function currentQuery(): ChannelMediaQuery {
    return {
      kind,
      order,
      tz: timeZone,
      limit: MEDIA_PAGE_SIZE,
      ...(nameQuery !== "" ? { q: nameQuery } : {}),
      ...(uploader !== undefined ? { from: uploader } : {}),
    };
  }

  function setStatus(text: string | null, retry?: () => void): void {
    if (statusEl === null) return;
    statusEl.textContent = "";
    statusEl.hidden = text === null;
    if (text === null) return;
    statusEl.appendChild(createElement("span", {}, text));
    if (retry !== undefined) {
      const btn = createElement(
        "button",
        { type: "button", class: "media-gallery__retry" },
        mediaGalleryText("retry"),
      );
      btn.addEventListener("click", retry, { signal: queryScope.signal });
      statusEl.appendChild(btn);
    }
  }

  function loadThumb(img: HTMLImageElement): void {
    const src = img.dataset.src;
    if (src === undefined) return;
    delete img.dataset.src;
    const signal = queryScope.signal;
    void fetchImageAsObjectUrl(src).then((url) => {
      if (signal.aborted) return;
      if (url === null) img.closest(".media-gallery__tile")?.classList.add("is-broken");
      else img.src = url;
    });
  }

  function observeThumb(img: HTMLImageElement): void {
    if (tileObserver === null) loadThumb(img);
    else tileObserver.observe(img);
  }

  function track(messageId: number, el: HTMLElement): void {
    const els = tilesByMessage.get(messageId);
    if (els === undefined) tilesByMessage.set(messageId, [el]);
    else els.push(el);
  }

  function renderTile(item: ChannelMediaItem): HTMLButtonElement {
    const att = item.attachment;
    const tile = createElement("button", {
      type: "button",
      class: "media-gallery__tile",
      title: att.filename,
      "aria-label": mediaGalleryText("item.open", { name: att.filename }),
      "data-message-id": String(item.message_id),
      "data-attachment-id": att.id,
    });
    const url = resolveServerUrl(att.url);
    if (isVideoAttachment(att)) {
      tile.classList.add("media-gallery__tile--video");
      tile.appendChild(createIcon("play", 28));
      tile.appendChild(createElement("span", { class: "media-gallery__tile-name" }, att.filename));
    } else {
      const img = createElement("img", { alt: "", draggable: "false" });
      img.dataset.src = thumbnailUrl(url, att.mime);
      tile.appendChild(img);
      observeThumb(img);
    }
    if (isSpoilerFilename(att.filename)) {
      tile.classList.add("is-spoiler");
      tile.appendChild(
        createElement("span", { class: "media-gallery__spoiler" }, mediaGalleryText("spoiler")),
      );
    }
    return tile;
  }

  function appendItems(items: readonly ChannelMediaItem[]): void {
    if (list === null) return;
    for (const item of items) {
      const key = localMonthKey(item.timestamp);
      if (lastSection === null || lastSection.key !== key) {
        const section = createElement("section", { class: "media-gallery__section" });
        const heading = createElement(
          "h4",
          { class: "media-gallery__month" },
          monthLabel(key, "long"),
        );
        const content = createElement("div", {
          class: kind === "media" ? "media-gallery__grid" : "media-gallery__files",
        });
        appendChildren(section, heading, content);
        list.appendChild(section);
        lastSection = { key, content };
      }
      const el = kind === "media" ? renderTile(item) : renderFileRow(item);
      lastSection.content.appendChild(el);
      track(item.message_id, el);
    }
  }

  async function loadMore(): Promise<void> {
    if (loading) return;
    loading = true;
    const scope = queryScope;
    const query: ChannelMediaQuery = {
      ...currentQuery(),
      ...(cursor !== "" ? { cursor } : startMonth !== undefined ? { month: startMonth } : {}),
    };
    setStatus(cursor === "" ? mediaGalleryText("loading") : null);
    let loaded = false;
    try {
      const page = await options.loadPage(query, scope.signal);
      if (scope.signal.aborted) return;
      appendItems(page.items);
      cursor = page.next_cursor;
      hasMore = cursor !== "";
      loaded = true;
      if (tilesByMessage.size === 0 && !hasMore) {
        setStatus(
          nameQuery !== "" || uploader !== undefined
            ? mediaGalleryText("empty.filtered")
            : mediaGalleryText(kind === "media" ? "empty.media" : "empty.files"),
        );
      } else {
        setStatus(null);
      }
    } catch {
      if (scope.signal.aborted) return;
      setStatus(mediaGalleryText("loadFailed"), () => void loadMore());
    } finally {
      if (!scope.signal.aborted) loading = false;
    }
    // A short page can leave the sentinel on screen, where the observer
    // will not fire again; keep filling until it scrolls away or ends. A
    // failed page waits for the Retry button instead of looping.
    if (loaded && !scope.signal.aborted && hasMore && sentinelVisible()) void loadMore();
  }

  function sentinelVisible(): boolean {
    if (sentinel === null || body === null) return false;
    const box = body.getBoundingClientRect();
    if (box.height === 0) return false;
    return sentinel.getBoundingClientRect().top <= box.bottom + 200;
  }

  function renderMonths(resp: ChannelMediaMonthsResponse): void {
    if (monthNav === null) return;
    monthNav.textContent = "";
    let year = "";
    for (const { month, count } of resp.months) {
      const y = month.slice(0, 4);
      if (y !== year) {
        year = y;
        monthNav.appendChild(createElement("div", { class: "media-gallery__year" }, y));
      }
      const btn = createElement("button", {
        type: "button",
        class: "media-gallery__month-btn",
        "data-month": month,
        "aria-pressed": String(month === startMonth),
        "aria-label": mediaGalleryText("month.jump", {
          month: monthLabel(month, "long"),
          count: formatNumber(count),
        }),
      });
      appendChildren(
        btn,
        createElement("span", {}, monthLabel(month, "short")),
        createElement("span", { class: "media-gallery__month-count" }, formatNumber(count)),
      );
      monthNav.appendChild(btn);
    }
  }

  /** Start over with the current filters: the list, the cursor and the months. */
  function reload(withMonths: boolean): void {
    queryScope.destroy();
    queryScope = new Disposable();
    cursor = "";
    hasMore = false;
    loading = false;
    lastSection = null;
    tilesByMessage.clear();
    tileObserver?.disconnect();
    if (list !== null) list.textContent = "";
    if (body !== null) body.scrollTop = 0;
    if (withMonths) {
      const scope = queryScope;
      options.loadMonths(currentQuery(), scope.signal).then(
        (resp) => {
          if (!scope.signal.aborted) renderMonths(resp);
        },
        () => {
          if (!scope.signal.aborted && monthNav !== null) monthNav.textContent = "";
        },
      );
    } else if (monthNav !== null) {
      for (const btn of monthNav.querySelectorAll<HTMLElement>(".media-gallery__month-btn")) {
        btn.setAttribute("aria-pressed", String(btn.dataset.month === startMonth));
      }
    }
    void loadMore();
  }

  /** Fill the Files tab's usage line; read once, and a failure just leaves it out. */
  function loadUsage(): void {
    if (usageRequested || options.loadStorage === undefined) return;
    usageRequested = true;
    options.loadStorage(disposable.signal).then(
      (storage) => {
        if (disposable.signal.aborted || usageEl === null) return;
        usageEl.textContent = "";
        usageEl.appendChild(createElement("span", {}, storageUsageText(storage)));
        if (options.onManageUploads !== undefined) {
          const manage = createElement(
            "button",
            { type: "button", class: "media-gallery__manage", "data-testid": "media-manage" },
            mediaGalleryText("usage.manage"),
          );
          manage.addEventListener("click", () => options.onManageUploads?.(), {
            signal: disposable.signal,
          });
          usageEl.appendChild(manage);
        }
        usageEl.hidden = kind !== "files";
      },
      () => {
        usageRequested = false;
      },
    );
  }

  function selectKind(next: Kind): void {
    if (next === kind) return;
    kind = next;
    if (usageEl !== null) usageEl.hidden = kind !== "files" || usageEl.childElementCount === 0;
    if (kind === "files") loadUsage();
    for (const [k, tab] of tabs) {
      tab.setAttribute("aria-selected", String(k === kind));
      tab.tabIndex = k === kind ? 0 : -1;
    }
    startMonth = undefined;
    reload(true);
  }

  function buildToolbar(): HTMLDivElement {
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
          disposable.signal,
          () => {
            const next = search.value.trim();
            if (next === nameQuery) return;
            nameQuery = next;
            startMonth = undefined;
            reload(true);
          },
          MEDIA_SEARCH_DEBOUNCE_MS,
        );
      },
      { signal: disposable.signal },
    );

    const from = createElement("select", {
      class: "media-gallery__select",
      "aria-label": mediaGalleryText("from.label"),
    });
    from.appendChild(createElement("option", { value: "" }, mediaGalleryText("from.anyone")));
    for (const u of options.uploaders()) {
      from.appendChild(createElement("option", { value: String(u.id) }, u.name));
    }
    from.addEventListener(
      "change",
      () => {
        uploader = from.value === "" ? undefined : Number(from.value);
        startMonth = undefined;
        reload(true);
      },
      { signal: disposable.signal },
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
      () => {
        order = sort.value === "oldest" ? "oldest" : "newest";
        reload(false);
      },
      { signal: disposable.signal },
    );

    appendChildren(toolbar, search, from, sort);
    return toolbar;
  }

  function onListClick(e: MouseEvent): void {
    if (!(e.target instanceof Element)) return;
    const item = e.target.closest<HTMLElement>("[data-message-id]");
    if (item === null) return;
    // A spoiler's first click uncovers it, like in the chat.
    if (item.classList.contains("is-spoiler")) {
      item.classList.remove("is-spoiler");
      item.querySelector(".media-gallery__spoiler")?.remove();
      return;
    }
    const id = Number(item.dataset.messageId);
    if (Number.isInteger(id) && id > 0) options.onJumpToMessage(id);
  }

  function onMonthClick(e: MouseEvent): void {
    if (!(e.target instanceof Element)) return;
    const btn = e.target.closest<HTMLElement>(".media-gallery__month-btn");
    const month = btn?.dataset.month;
    if (month === undefined) return;
    startMonth = month;
    reload(false);
  }

  function mount(container: Element): void {
    // A side panel like the pins panel: a complementary landmark, no focus trap.
    root = createElement("div", {
      class: "media-gallery",
      role: "complementary",
      "aria-label": mediaGalleryText("label"),
      "data-testid": "media-gallery",
    });

    const header = createElement("div", { class: "media-gallery__header" });
    const title = createElement("h3", { class: "media-gallery__title" });
    title.appendChild(createIcon("image", 16));
    title.appendChild(createElement("span", {}, mediaGalleryText("title")));
    title.appendChild(
      createElement(
        "span",
        { class: "media-gallery__channel" },
        mediaGalleryText("in", { channel: options.channelName }),
      ),
    );
    const closeBtn = createElement("button", {
      type: "button",
      class: "media-gallery__close",
      "aria-label": mediaGalleryText("close"),
    });
    closeBtn.appendChild(createIcon("x", 16));
    closeBtn.addEventListener("click", () => options.onClose(), { signal: disposable.signal });
    appendChildren(header, title, closeBtn);

    const tabList = createElement("div", { class: "media-gallery__tabs", role: "tablist" });
    for (const k of ["media", "files"] as const) {
      const tab = createElement(
        "button",
        {
          type: "button",
          class: "media-gallery__tab",
          role: "tab",
          "aria-selected": String(k === kind),
          tabindex: k === kind ? "0" : "-1",
          "data-kind": k,
        },
        mediaGalleryText(k === "media" ? "tab.media" : "tab.files"),
      );
      tab.addEventListener("click", () => selectKind(k), { signal: disposable.signal });
      tabs.set(k, tab);
      tabList.appendChild(tab);
    }
    tabList.addEventListener(
      "keydown",
      (e) => {
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
        const next: Kind = kind === "media" ? "files" : "media";
        selectKind(next);
        tabs.get(next)?.focus();
        e.preventDefault();
      },
      { signal: disposable.signal },
    );

    body = createElement("div", { class: "media-gallery__body", role: "tabpanel" });
    list = createElement("div", { class: "media-gallery__list" });
    statusEl = createElement("div", { class: "media-gallery__status", role: "status" });
    sentinel = createElement("div", { class: "media-gallery__sentinel" });
    appendChildren(body, list, statusEl, sentinel);
    list.addEventListener("click", onListClick, { signal: disposable.signal });

    monthNav = createElement("nav", {
      class: "media-gallery__months",
      "aria-label": mediaGalleryText("months.label"),
    });
    monthNav.addEventListener("click", onMonthClick, { signal: disposable.signal });

    const main = createElement("div", { class: "media-gallery__main" });
    appendChildren(main, body, monthNav);
    usageEl = createElement("div", {
      class: "media-gallery__usage",
      "data-testid": "media-usage",
    });
    usageEl.hidden = true;
    appendChildren(root, header, tabList, buildToolbar(), usageEl, main);
    container.appendChild(root);

    if (typeof IntersectionObserver !== "undefined") {
      tileObserver = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            tileObserver?.unobserve(entry.target);
            if (entry.target instanceof HTMLImageElement) loadThumb(entry.target);
          }
        },
        { root: body, rootMargin: "200px" },
      );
      moreObserver = new IntersectionObserver(
        (entries) => {
          if (entries.some((e) => e.isIntersecting) && hasMore) void loadMore();
        },
        { root: body, rootMargin: "200px" },
      );
      moreObserver.observe(sentinel);
      disposable.addCleanup(() => {
        tileObserver?.disconnect();
        moreObserver?.disconnect();
        tileObserver = null;
        moreObserver = null;
      });
    }
    reload(true);
  }

  function dropElement(el: HTMLElement): void {
    const section = el.closest(".media-gallery__section");
    el.remove();
    if (section !== null && section.querySelector("[data-message-id]") === null) {
      if (lastSection?.content.parentElement === section) lastSection = null;
      section.remove();
    }
  }

  function showEmptyIfDrained(): void {
    if (tilesByMessage.size === 0 && !hasMore && !loading) {
      setStatus(mediaGalleryText(kind === "media" ? "empty.media" : "empty.files"));
    }
  }

  function removeMessages(messageIds: readonly number[]): void {
    for (const id of messageIds) {
      const els = tilesByMessage.get(id);
      if (els === undefined) continue;
      tilesByMessage.delete(id);
      for (const el of els) dropElement(el);
    }
    showEmptyIfDrained();
  }

  function syncMessageAttachments(messageId: number, remainingIds: readonly string[]): void {
    const els = tilesByMessage.get(messageId);
    if (els === undefined) return;
    const keep = new Set(remainingIds);
    const kept = els.filter((el) => {
      const id = el.dataset.attachmentId;
      if (id === undefined || keep.has(id)) return true;
      dropElement(el);
      return false;
    });
    if (kept.length === 0) tilesByMessage.delete(messageId);
    else tilesByMessage.set(messageId, kept);
    showEmptyIfDrained();
  }

  function destroy(): void {
    queryScope.destroy();
    disposable.destroy();
    root?.remove();
    root = null;
    body = null;
    list = null;
    monthNav = null;
    sentinel = null;
    statusEl = null;
    usageEl = null;
    tabs.clear();
    tilesByMessage.clear();
  }

  return { mount, destroy, removeMessages, syncMessageAttachments };
}
