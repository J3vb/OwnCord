/**
 * The pieces of the channel media gallery that only turn data into elements:
 * month labels, file rows, picture tiles, the usage line and the month list.
 */

import { createElement, appendChildren } from "@lib/dom";
import { createIcon } from "@lib/icons";
import type { IconName } from "@lib/icons";
import { parseTimestamp } from "@lib/text/formatting";
import type { ChannelMediaItem, ChannelMediaMonthsResponse, UserStorage } from "@lib/types";
import { formatDate, formatNumber } from "../../i18n/format";
import { mediaGalleryText } from "../../i18n/mediaGallery";
import { isSpoilerFilename } from "./spoilerAttachment";
import {
  formatFileSize,
  isImageMime,
  isVideoAttachment,
  isAudioMime,
  resolveServerUrl,
  thumbnailUrl,
} from "./content/attachments";

/** "YYYY-MM" of a timestamp in the viewer's local calendar. */
export function localMonthKey(timestamp: string): string {
  const d = parseTimestamp(timestamp);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export function monthLabel(key: string, style: "long" | "short"): string {
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

export function renderFileRow(item: ChannelMediaItem): HTMLButtonElement {
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

/** A picture or video tile; `observeThumb` lazy-loads the picture. */
export function renderTile(
  item: ChannelMediaItem,
  observeThumb: (img: HTMLImageElement) => void,
): HTMLButtonElement {
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

/** The month jump list; `selected` is the month the walk starts at, if any. */
export function renderMonths(
  monthNav: HTMLElement,
  resp: ChannelMediaMonthsResponse,
  selected: string | undefined,
): void {
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
      "aria-pressed": String(month === selected),
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

/** Fill the Files tab's usage line with the text and, when wired, the Manage link. */
export function fillUsageLine(
  usageEl: HTMLElement,
  storage: UserStorage,
  onManageUploads: (() => void) | undefined,
  signal: AbortSignal,
): void {
  usageEl.textContent = "";
  usageEl.appendChild(createElement("span", {}, storageUsageText(storage)));
  if (onManageUploads === undefined) return;
  const manage = createElement(
    "button",
    { type: "button", class: "media-gallery__manage", "data-testid": "media-manage" },
    mediaGalleryText("usage.manage"),
  );
  manage.addEventListener("click", () => onManageUploads(), { signal });
  usageEl.appendChild(manage);
}
