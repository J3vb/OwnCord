/**
 * Advanced settings tab — developer mode, hardware acceleration, debug tools,
 * and cache management.
 */

import { createElement, appendChildren } from "@lib/dom";
import { invoke } from "@tauri-apps/api/core";
import { appLogDir, join } from "@tauri-apps/api/path";
import { readDir, remove } from "@tauri-apps/plugin-fs";
import { createLogger } from "@lib/logger";
import { clearPendingPersistedLogs } from "@lib/logPersistence";
import { clearAttachmentCaches } from "@components/message-list/attachments";
import { clearEmbedCaches } from "@components/message-list/embeds";
import { clearMediaCaches } from "@components/message-list/media";
import { loadPref, savePref, createToggle } from "./helpers";

const log = createLogger("AdvancedTab");
const IMAGE_CACHE_DELETE_BLOCK_TIMEOUT_MS = 1000;

export function buildAdvancedTab(signal: AbortSignal): HTMLDivElement {
  const section = createElement("div", { class: "settings-pane active" });

  // ---- Toggles ---------------------------------------------------------------

  const toggles: ReadonlyArray<{ key: string; label: string; desc: string; fallback: boolean }> = [
    {
      key: "developerMode",
      label: "Developer Mode",
      desc: "Show message IDs, user IDs, and channel IDs on context menus",
      fallback: false,
    },
    {
      key: "hardwareAcceleration",
      label: "Hardware Acceleration",
      desc: "Use GPU for rendering. Requires restart to take effect",
      fallback: true,
    },
  ];

  for (const item of toggles) {
    const row = createElement("div", { class: "setting-row" });
    const info = createElement("div", {});
    const label = createElement("div", { class: "setting-label" }, item.label);
    const desc = createElement("div", { class: "setting-desc" }, item.desc);
    appendChildren(info, label, desc);

    const isOn = loadPref<boolean>(item.key, item.fallback);
    const toggle = createToggle(isOn, {
      signal,
      onChange: (nowOn) => { savePref(item.key, nowOn); },
    });

    appendChildren(row, info, toggle);
    section.appendChild(row);
  }

  // ---- Separator -------------------------------------------------------------

  const sep = createElement("div", { class: "settings-separator" });
  section.appendChild(sep);

  // ---- Debug section ---------------------------------------------------------

  const debugTitle = createElement("div", { class: "settings-section-title" }, "Debug");
  section.appendChild(debugTitle);

  // DevTools button row
  const devtoolsRow = createElement("div", { class: "setting-row" });
  const devtoolsInfo = createElement("div", {});
  const devtoolsLabel = createElement("div", { class: "setting-label" }, "Open DevTools");
  const devtoolsDesc = createElement("div", { class: "setting-desc" }, "Open the browser developer tools for debugging");
  appendChildren(devtoolsInfo, devtoolsLabel, devtoolsDesc);

  const devtoolsBtn = createElement("button", { class: "ac-btn" }, "Open DevTools");
  devtoolsBtn.addEventListener("click", () => {
    void invoke("open_devtools").catch((err: unknown) => {
      log.warn("DevTools not available", { error: err instanceof Error ? err.message : String(err) });
    });
  }, { signal });

  appendChildren(devtoolsRow, devtoolsInfo, devtoolsBtn);
  section.appendChild(devtoolsRow);

  // ---- Storage & Cache section ------------------------------------------------

  const cacheSep = createElement("div", { class: "settings-separator" });
  section.appendChild(cacheSep);

  const cacheTitle = createElement("div", { class: "settings-section-title" }, "Storage & Cache");
  section.appendChild(cacheTitle);

  // Clear Image Cache
  section.appendChild(buildCacheRow(
    "Clear Image Cache",
    "Remove cached images and link previews. They will be re-downloaded as needed.",
    "Clear",
    signal,
    async (btn) => {
      btn.textContent = "Clearing...";
      btn.setAttribute("disabled", "");
      try {
        await clearImageCache();
        btn.textContent = "Cleared!";
        setTimeout(() => { btn.textContent = "Clear"; btn.removeAttribute("disabled"); }, 2000);
      } catch (err) {
        log.error("Failed to clear image cache", err);
        btn.textContent = "Failed";
        setTimeout(() => { btn.textContent = "Clear"; btn.removeAttribute("disabled"); }, 2000);
      }
    },
  ));

  // Clear Log Files
  section.appendChild(buildCacheRow(
    "Clear Log Files",
    "Remove persisted client log files from disk.",
    "Clear",
    signal,
    async (btn) => {
      btn.textContent = "Clearing...";
      btn.setAttribute("disabled", "");
      try {
        await clearLogFiles();
        btn.textContent = "Cleared!";
        setTimeout(() => { btn.textContent = "Clear"; btn.removeAttribute("disabled"); }, 2000);
      } catch (err) {
        log.error("Failed to clear log files", err);
        btn.textContent = "Failed";
        setTimeout(() => { btn.textContent = "Clear"; btn.removeAttribute("disabled"); }, 2000);
      }
    },
  ));

  // Clear All Cache (nuclear option)
  section.appendChild(buildCacheRow(
    "Clear All Cache & Restart",
    "Remove all cached data (images, logs, WebView storage) and restart the app. "
      + "Server profiles and credentials are preserved.",
    "Clear & Restart",
    signal,
    async (btn) => {
      // Two-step confirmation: first click shows warning, second click confirms
      if (btn.dataset.confirmPending !== "true") {
        btn.dataset.confirmPending = "true";
        btn.textContent = "Are you sure? Click again";
        btn.classList.add("ac-btn-danger");
        const resetTimer = setTimeout(() => {
          btn.dataset.confirmPending = "";
          btn.textContent = "Clear & Restart";
          btn.classList.remove("ac-btn-danger");
        }, 3000);
        // Store timer ID so it can be cleared if the button is clicked again
        btn.dataset.resetTimer = String(resetTimer);
        return;
      }
      // Second click — clear the pending state and proceed
      const pendingTimer = btn.dataset.resetTimer;
      if (pendingTimer) clearTimeout(Number(pendingTimer));
      btn.dataset.confirmPending = "";
      btn.textContent = "Clearing...";
      btn.setAttribute("disabled", "");
      try {
        await clearImageCache();
        await clearLogFiles();
        clearLocalStoragePreservingUserData();
        sessionStorage.clear();
        log.info("All cache cleared, restarting app");
        const { relaunch } = await import("@tauri-apps/plugin-process");
        await relaunch();
      } catch (err) {
        log.error("Failed to clear all cache", err);
        btn.textContent = "Failed";
        setTimeout(() => { btn.textContent = "Clear & Restart"; btn.removeAttribute("disabled"); }, 2000);
      }
    },
  ));

  return section;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildCacheRow(
  label: string,
  desc: string,
  btnText: string,
  signal: AbortSignal,
  onClick: (btn: HTMLButtonElement) => void,
): HTMLDivElement {
  const row = createElement("div", { class: "setting-row" });
  const info = createElement("div", {});
  const labelEl = createElement("div", { class: "setting-label" }, label);
  const descEl = createElement("div", { class: "setting-desc" }, desc);
  appendChildren(info, labelEl, descEl);

  const btn = createElement("button", { class: "ac-btn" }, btnText);
  btn.addEventListener("click", () => { onClick(btn); }, { signal });

  appendChildren(row, info, btn);
  return row;
}

/** Delete the IndexedDB image cache database. */
async function clearImageCache(): Promise<void> {
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

    req.onsuccess = () => finish(resolve);
    req.onerror = () => finish(() => reject(req.error));
    req.onblocked = () => {
      if (blockedTimer !== null) return;
      blockedTimer = setTimeout(() => {
        finish(() => reject(new Error("Image cache is still in use. Close active media and try again.")));
      }, IMAGE_CACHE_DELETE_BLOCK_TIMEOUT_MS);
    };
  });

  clearAttachmentCaches();
  clearEmbedCaches();
  clearMediaCaches();
}

/**
 * Clear localStorage but preserve user-critical data: server profiles,
 * saved credentials, active theme selection, and custom themes.
 */
function clearLocalStoragePreservingUserData(): void {
  const PRESERVE_PREFIXES = [
    "owncord:profiles",
    "owncord:credential:",
    "owncord:theme:active",
    "owncord:theme:custom:",
  ];
  const keysToRemove: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key !== null && !PRESERVE_PREFIXES.some((p) => key.startsWith(p))) {
      keysToRemove.push(key);
    }
  }
  for (const key of keysToRemove) {
    localStorage.removeItem(key);
  }
}

/** Delete all JSONL log files from the app log directory. */
async function clearLogFiles(): Promise<void> {
  try {
    await clearPendingPersistedLogs();
    const baseDir = await appLogDir();
    const logDir = await join(baseDir, "client-logs");
    const entries = await readDir(logDir);
    for (const entry of entries) {
      if (entry.name?.endsWith(".jsonl") && !entry.isDirectory) {
        await remove(`${logDir}/${entry.name}`);
      }
    }
  } catch (err) {
    if (isMissingPathError(err)) {
      return;
    }
    throw err;
  }
}

function isMissingPathError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /not found|no such file|cannot find the path|os error 2|enoent/i.test(message);
}
