/** Advanced tab cache helpers: the cache action row and the cache and local storage clearing. */

import { createElement, appendChildren } from "@lib/dom";
import { clearAttachmentCaches, clearExternalImageCache } from "../messaging/content/attachments";
import { clearEmbedCaches } from "../messaging/content/embeds";
import { clearMediaCaches } from "../messaging/content/media";
import { removeStored, storedKeys } from "@lib/prefs/preferences";

const IMAGE_CACHE_DELETE_BLOCK_TIMEOUT_MS = 1000;

export function buildCacheRow(
  label: string,
  desc: string,
  btnText: string,
  destructive: boolean,
  signal: AbortSignal,
  onClick: (btn: HTMLButtonElement) => void,
): HTMLDivElement {
  const row = createElement("div", { class: "setting-row" });
  const info = createElement("div", {});
  const labelEl = createElement("div", { class: "setting-label" }, label);
  const descEl = createElement("div", { class: "setting-desc" }, desc);
  appendChildren(info, labelEl, descEl);

  const btn = createElement("button", { class: "ac-btn secondary" }, btnText);
  btn.classList.toggle("destructive", destructive);
  btn.addEventListener(
    "click",
    () => {
      onClick(btn);
    },
    { signal },
  );

  appendChildren(row, info, btn);
  return row;
}

/** Delete the IndexedDB image cache database. */
export async function clearImageCache(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase("owncord-image-cache");
    let settled = false;
    let blockedTimer: ReturnType<typeof setTimeout> | null = null;

    function finish(callback: () => void): void {
      if (settled) return;
      settled = true;
      if (blockedTimer !== null) {
        clearTimeout(blockedTimer);
      }
      callback();
    }

    // oxlint-disable-next-line prefer-add-event-listener -- IDBRequest does not support addEventListener
    req.onsuccess = () => finish(resolve);
    // oxlint-disable-next-line prefer-add-event-listener -- IDBRequest does not support addEventListener
    req.onerror = () => finish(() => reject(req.error));
    // oxlint-disable-next-line prefer-add-event-listener -- IDBRequest does not support addEventListener
    req.onblocked = () => {
      if (blockedTimer !== null) return;
      blockedTimer = setTimeout(() => {
        // The caller shows only the generic "Failed" button state, never this text.
        const blocked = new Error("Image cache is still in use. Close active media and try again."); // i18n-exempt: internal error, only the button state is shown
        finish(() => reject(blocked));
      }, IMAGE_CACHE_DELETE_BLOCK_TIMEOUT_MS);
    };
  });

  clearAttachmentCaches();
  clearEmbedCaches();
  clearMediaCaches();
  // Also moves the external-content broker to a fresh partition, which drops
  // the native cache of the previous one on its next request.
  clearExternalImageCache();
}

/**
 * Clear localStorage but preserve user-critical data: server profiles,
 * saved credentials, active theme selection, custom themes, and the
 * notification levels.
 */
export function clearLocalStoragePreservingUserData(): void {
  const PRESERVE_PREFIXES = [
    "owncord:profiles",
    "owncord:credential:",
    "owncord:theme:active",
    "owncord:theme:custom:",
    "owncord:settings:notificationLevel",
  ];
  for (const key of storedKeys()) {
    if (!PRESERVE_PREFIXES.some((p) => key.startsWith(p))) removeStored(key);
  }
}
