/**
 * The "Send to" sheet for a share from another app: one channel or DM the
 * viewer can post in, picked from the same list the Forward picker offers.
 * Picking closes the sheet and hands the target back; the files and text then
 * go to that composer, where the user still presses Send. Loaded on the first
 * share, so it stays out of the startup and MainPage chunks.
 * Built with @lib/dom helpers, never innerHTML.
 */

import { Disposable } from "@lib/disposable";
import { appendChildren, clearChildren, createElement, setText } from "@lib/dom";
import { createIcon } from "@lib/icons";
import { closeOnBackdropClick, createModal, type ModalInstance } from "@lib/ui/modalFactory";
import { channelsStore } from "@stores/channels.store";
import { blocksStore } from "@stores/blocks.store";
import { dmStore } from "@stores/dm.store";
import {
  filterForwardTargets,
  listForwardTargets,
  type ForwardTarget,
} from "../messaging/forwardTargets";
import { shareText } from "../../i18n/share";
import { shellText } from "../../i18n/shell";
import type { ReceivedShare } from "../../platform/contracts/shareSheet";

export interface SharePickerOptions {
  readonly share: ReceivedShare;
  /** The picked target; the sheet is already closed. */
  readonly onPick: (target: ForwardTarget) => void;
  /** Closes the sheet when it aborts (a newer share, the page going away). */
  readonly signal: AbortSignal;
}

const PREVIEW_CHARS = 120;

const iconFor = (t: ForwardTarget): SVGSVGElement =>
  createIcon(t.kind === "dm" ? "user" : t.kind === "announcement" ? "megaphone" : "hash", 14);

/** What the sheet says it is sending: the file count and the start of the text. */
export function sharePreview(share: ReceivedShare): string {
  const parts: string[] = [];
  if (share.files.length > 0) parts.push(shareText("files", { count: share.files.length }));
  const text = share.text.trim();
  if (text !== "") {
    parts.push(text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}…` : text);
  }
  return parts.join(" · ");
}

export function openSharePicker(opts: SharePickerOptions): void {
  if (opts.signal.aborted) return;
  const hasFiles = opts.share.files.length > 0;
  const owner = new Disposable();
  const { signal } = owner;
  // No source channel: nothing limits the list to labelled channels.
  let all: readonly ForwardTarget[] = listForwardTargets(0, hasFiles);
  let modal: ModalInstance | null = null;

  const search = createElement("input", {
    class: "form-input",
    type: "text",
    placeholder: shareText("search.placeholder"),
    "aria-label": shareText("search.label"),
    "data-testid": "share-search",
  });
  const list = createElement("div", {
    class: "quick-switcher__results",
    role: "group",
    "aria-label": shareText("list.label"),
    "data-testid": "share-list",
  });
  const empty = createElement("div", { class: "quick-switcher__empty", role: "status" });

  function renderList(): void {
    clearChildren(list);
    const shown = filterForwardTargets(all, search.value);
    setText(empty, shown.length === 0 ? shareText("list.empty") : "");
    for (const t of shown) {
      const row = createElement("button", {
        class: "quick-switcher__item",
        type: "button",
        "data-testid": `share-target-${t.id}`,
        "data-target-id": String(t.id),
      });
      const icon = createElement("span", { class: "quick-switcher__icon" });
      icon.appendChild(iconFor(t));
      const parts: (Element | string)[] = [
        icon,
        createElement("span", { class: "quick-switcher__name" }, t.name),
      ];
      if (t.category !== null) {
        parts.push(createElement("span", { class: "quick-switcher__category" }, t.category));
      }
      appendChildren(row, ...parts);
      list.appendChild(row);
    }
  }

  function refreshTargets(): void {
    all = listForwardTargets(0, hasFiles);
    renderList();
  }

  const header = createElement("div", { class: "modal-header" });
  const closeBtn = createElement("button", {
    class: "modal-close",
    type: "button",
    "aria-label": shellText("common.close"),
    "data-testid": "share-close",
  });
  closeBtn.appendChild(createIcon("x", 14));
  appendChildren(header, createElement("h3", { id: "share-title" }, shareText("title")), closeBtn);

  const preview = sharePreview(opts.share);
  const body = createElement("div", { class: "modal-body" });
  appendChildren(
    body,
    ...(preview === "" ? [] : [createElement("div", { class: "forward-hint" }, preview)]),
    search,
    list,
    empty,
  );

  modal = createModal(
    {
      content: header,
      onClose: () => owner.destroy(),
      onEscape: () => modal?.destroy(),
      className: "forward-picker",
      overlayAttrs: { "data-testid": "share-picker" },
      ariaLabelledBy: "share-title",
      signal: opts.signal,
    },
    document.body,
  );
  modal.modal.appendChild(body);

  closeOnBackdropClick(modal.overlay, () => modal?.destroy(), signal);
  closeBtn.addEventListener("click", () => modal?.destroy(), { signal });
  search.addEventListener("input", renderList, { signal });
  list.addEventListener(
    "click",
    (e) => {
      const row = e.target instanceof Element ? e.target.closest("[data-target-id]") : null;
      if (row === null) return;
      const target = all.find((t) => String(t.id) === row.getAttribute("data-target-id"));
      if (target === undefined) return;
      modal?.destroy();
      opts.onPick(target);
    },
    { signal },
  );
  owner.onStoreChange(channelsStore, (s) => s.channels, refreshTargets);
  owner.onStoreChange(dmStore, (s) => s.channels, refreshTargets);
  owner.onStoreChange(blocksStore, (s) => s.blockedByMe, refreshTargets);
  renderList();
}
