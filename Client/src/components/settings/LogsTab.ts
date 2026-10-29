/**
 * Logs settings tab — log viewer with filtering, level control, live updates.
 */

import { createElement, appendChildren, clearChildren } from "@lib/dom";
import {
  getLogBuffer,
  clearLogBuffer,
  addLogListener,
  setLogLevel,
  getLogLevel,
} from "@lib/logger";
import type { LogEntry, LogLevel } from "@lib/logger";
import type { TabName } from "../SettingsOverlay";
import { getSessionDebugInfo, getShareDiagnostics } from "@lib/livekitSession";
import { savePref, readMigratedStringPref, appendToggleRows } from "./helpers";
import {
  SHARE_DIAGNOSTICS_KEY,
  SHARE_MOTION_POLICIES,
  SHARE_MOTION_POLICY_KEY,
  getShareMotionPolicy,
  isShareMotionPolicy,
} from "@lib/shareFlags";
import { createDisclosure } from "../../features/settings/status";
import { createConnectionDiagnosticsPanel } from "./ConnectionDiagnosticsPanel";
import { desktop } from "../../platform/desktop";
import { settingsText as t } from "../../i18n/settings";
import { copyThenRelabel } from "@lib/clipboard";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LOG_FILTER_LEVELS = ["all", "debug", "info", "warn", "error"] as const;
const LOG_MIN_LEVELS = ["debug", "info", "warn", "error"] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatLogEntry(entry: LogEntry): HTMLDivElement {
  // Level colour comes from the log-<level> class (settings.css tokens).
  const row = createElement("div", { class: `log-entry log-${entry.level}` });
  const time = entry.timestamp.slice(11, 23); // HH:MM:SS.mmm
  const level = entry.level.toUpperCase().padEnd(5);
  const text = `${time} ${level} [${entry.component}] ${entry.message}`;
  row.appendChild(createElement("span", {}, text));

  if (entry.data !== undefined) {
    const dataStr =
      typeof entry.data === "string" ? entry.data : JSON.stringify(entry.data, null, 2);
    row.appendChild(createElement("pre", { class: "log-data" }, dataStr));
  }

  return row;
}

/** "N entries · N warnings · N errors" for the client logs summary. */
function logCounts(entries: readonly LogEntry[]): string {
  const warnings = entries.filter((e) => e.level === "warn").length;
  const errors = entries.filter((e) => e.level === "error").length;
  return [
    t("logs.entries", { count: entries.length }),
    t("logs.warnings", { count: warnings }),
    t("logs.errors", { count: errors }),
  ].join(" · ");
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface LogsTabHandle {
  /**
   * Build the pane's DOM. `signal` scopes this build's own element
   * listeners — pass a per-render signal (aborted just before the next
   * build) so a discarded pane's listeners don't outlive it. Defaults to
   * the factory's overlay-lifetime signal when omitted, matching this
   * tab's original single-signal behavior.
   */
  build(signal?: AbortSignal): HTMLDivElement;
  cleanup(): void;
}

export function createLogsTab(getActiveTab: () => TabName, signal: AbortSignal): LogsTabHandle {
  let logListEl: HTMLDivElement | null = null;
  let countEl: HTMLSpanElement | null = null;
  let logFilterLevel: LogLevel | "all" = readMigratedStringPref(
    "logs_filter_level",
    "all",
    LOG_FILTER_LEVELS,
  );
  let unsubLogListener: (() => void) | null = null;
  let cleanupConnectionDiagnostics: (() => void) | null = null;

  // Single point of truth for both the list and the "N entries" counter above
  // it, so every render path (filter change, Clear, Refresh, live entry)
  // keeps them in sync — see OC-0230.
  function renderLogEntries(): void {
    const entries = getLogBuffer();
    if (countEl !== null) {
      countEl.textContent = logCounts(entries);
    }

    if (logListEl === null) return;
    clearChildren(logListEl);

    for (const entry of entries) {
      if (logFilterLevel !== "all" && entry.level !== logFilterLevel) continue;
      logListEl.appendChild(formatLogEntry(entry));
    }

    // Auto-scroll to bottom
    logListEl.scrollTop = logListEl.scrollHeight;
  }

  function build(buildSignal: AbortSignal = signal): HTMLDivElement {
    const section = createElement("div", { class: "settings-pane active" });
    cleanupConnectionDiagnostics?.();
    const diagnostics = createConnectionDiagnosticsPanel(buildSignal);
    cleanupConnectionDiagnostics = diagnostics.cleanup;
    section.appendChild(diagnostics.element);

    // ---- Get help: one primary action, the support bundle -----------------

    const diagPanel = createElement("pre", { class: "diag-state" });
    function refreshDiag(): void {
      const info = getSessionDebugInfo();
      diagPanel.textContent = JSON.stringify(info, null, 2);
    }
    refreshDiag();

    const helpCard = createElement("section", {
      class: "settings-card",
      "data-testid": "get-help",
      "aria-labelledby": "logs-get-help-title",
    });
    const helpHead = createElement("div", { class: "settings-card-head" });
    const helpTitle = createElement("h3", { id: "logs-get-help-title" }, t("logs.getHelp"));

    const diagCopy = createElement(
      "button",
      { class: "ac-btn secondary", type: "button" },
      t("logs.copyDiagnostics"),
    );
    diagCopy.addEventListener(
      "click",
      () => {
        refreshDiag();
        copyThenRelabel(
          diagPanel.textContent ?? "",
          diagCopy,
          { idle: t("logs.copyDiagnostics"), done: t("logs.copied"), failed: t("logs.copyFailed") },
          { signal: buildSignal },
        );
      },
      { signal: buildSignal },
    );

    // Support bundle (B7-15c): lazily loaded so the zip writer stays off the
    // startup path. Everything is read and written on this machine.
    const bundleBtn = createElement(
      "button",
      { class: "ac-btn", type: "button", "data-testid": "export-support-bundle" },
      t("logs.exportBundle"),
    );
    const bundleNote = createElement("p", { class: "setting-desc" }, t("logs.bundleNote"));
    const bundleStatus = createElement("div", {
      class: "setting-desc",
      role: "status",
      "data-testid": "support-bundle-status",
    });
    bundleBtn.addEventListener(
      "click",
      () => {
        bundleBtn.disabled = true;
        bundleStatus.textContent = "";
        void import("@lib/supportBundle")
          .then(({ exportSupportBundle }) =>
            exportSupportBundle(desktop, getSessionDebugInfo(), getShareDiagnostics()),
          )
          .then((saved) => {
            bundleStatus.textContent = saved ? t("logs.bundleSaved") : "";
          })
          .catch((err: unknown) => {
            bundleStatus.textContent = t("logs.exportFailed", {
              error: err instanceof Error ? err.message : String(err),
            });
          })
          .finally(() => {
            bundleBtn.disabled = false;
          });
      },
      { signal: buildSignal },
    );
    // Open log folder: the tray item's twin, for desktops with no tray (stock
    // GNOME). Failure shows in the same status line the bundle export uses.
    const openLogsBtn = createElement(
      "button",
      { class: "ac-btn secondary", type: "button", "data-testid": "open-log-folder" },
      t("logs.openFolder"),
    );
    openLogsBtn.addEventListener(
      "click",
      () => {
        openLogsBtn.disabled = true;
        bundleStatus.textContent = "";
        void desktop.logFiles
          .openFolder()
          .then((result) => {
            if (!result.ok) {
              bundleStatus.textContent = t("logs.openFolderFailed", { error: result.error });
            }
          })
          .finally(() => {
            openLogsBtn.disabled = false;
          });
      },
      { signal: buildSignal },
    );
    // A page has no log folder (the browser keeps logs in memory), so the web
    // build offers only the bundle.
    if (__OWNCORD_WEB__) appendChildren(helpHead, helpTitle, diagCopy, bundleBtn);
    else appendChildren(helpHead, helpTitle, diagCopy, openLogsBtn, bundleBtn);
    appendChildren(helpCard, helpHead, bundleNote, bundleStatus);
    section.appendChild(helpCard);

    // ---- Client logs (disclosure; the summary carries the counts) ---------

    const logs = createDisclosure(t("logs.clientLogs"));
    countEl = logs.count;
    const controls = createElement("div", { class: "settings-toolbar" });

    const filterLabel = createElement("span", { class: "setting-label" }, t("logs.filter"));
    const filterSelect = createElement("select", {
      class: "settings-select",
      "aria-label": t("logs.filterLabel"),
    });
    for (const lvl of LOG_FILTER_LEVELS) {
      const opt = createElement("option", { value: lvl }, lvl.toUpperCase());
      if (lvl === logFilterLevel) opt.setAttribute("selected", "");
      filterSelect.appendChild(opt);
    }
    filterSelect.value = logFilterLevel;
    filterSelect.addEventListener(
      "change",
      () => {
        logFilterLevel = filterSelect.value as LogLevel | "all";
        savePref("logs_filter_level", logFilterLevel);
        renderLogEntries();
      },
      { signal: buildSignal },
    );

    const levelLabel = createElement("span", { class: "setting-label" }, t("logs.minLevel"));
    const levelSelect = createElement("select", {
      class: "settings-select",
      "aria-label": t("logs.minLevelLabel"),
    });
    for (const lvl of LOG_MIN_LEVELS) {
      const opt = createElement("option", { value: lvl }, lvl.toUpperCase());
      levelSelect.appendChild(opt);
    }
    const savedMinLevel = readMigratedStringPref<LogLevel | "">("logs_min_level", "", [
      "",
      ...LOG_MIN_LEVELS,
    ]);
    if (savedMinLevel !== "") {
      levelSelect.value = savedMinLevel;
      setLogLevel(savedMinLevel);
    } else {
      // No saved pref: reflect the actual effective runtime level (the
      // applyStoredLogLevel fallback — info in prod, debug in dev) instead of
      // leaving the select on its first option (DEBUG). Purely cosmetic — no
      // save/apply, so the runtime level is unchanged.
      levelSelect.value = getLogLevel();
    }
    levelSelect.addEventListener(
      "change",
      () => {
        const level = levelSelect.value as LogLevel;
        setLogLevel(level);
        savePref("logs_min_level", level);
      },
      { signal: buildSignal },
    );

    const copyBtn = createElement(
      "button",
      { class: "ac-btn secondary", type: "button" },
      t("logs.copyAll"),
    );
    copyBtn.addEventListener(
      "click",
      () => {
        const entries = getLogBuffer();
        const filtered =
          logFilterLevel === "all" ? entries : entries.filter((e) => e.level === logFilterLevel);
        const text = filtered
          .map((e) => {
            const time = e.timestamp.slice(11, 23);
            const level = e.level.toUpperCase().padEnd(5);
            const base = `${time} ${level} [${e.component}] ${e.message}`;
            if (e.data === undefined) return base;
            const dataStr = typeof e.data === "string" ? e.data : JSON.stringify(e.data, null, 2);
            return `${base}\n${dataStr}`;
          })
          .join("\n");
        copyThenRelabel(
          text,
          copyBtn,
          { idle: t("logs.copyAll"), done: t("logs.copied"), failed: t("logs.copyFailed") },
          { signal: buildSignal },
        );
      },
      { signal: buildSignal },
    );

    const clearBtn = createElement(
      "button",
      { class: "ac-btn secondary", type: "button" },
      t("logs.clear"),
    );
    clearBtn.addEventListener(
      "click",
      () => {
        clearLogBuffer();
        renderLogEntries();
      },
      { signal: buildSignal },
    );

    const refreshBtn = createElement(
      "button",
      { class: "ac-btn secondary", type: "button" },
      t("logs.refresh"),
    );
    refreshBtn.addEventListener("click", () => renderLogEntries(), { signal: buildSignal });

    appendChildren(
      controls,
      filterLabel,
      filterSelect,
      levelLabel,
      levelSelect,
      copyBtn,
      clearBtn,
      refreshBtn,
    );
    logListEl = createElement("div", { class: "log-viewer" });
    appendChildren(logs.details, controls, logListEl);
    logs.details.addEventListener(
      "toggle",
      () => {
        if (logs.details.open && logListEl !== null) logListEl.scrollTop = logListEl.scrollHeight;
      },
      { signal: buildSignal },
    );
    section.appendChild(logs.details);

    renderLogEntries();

    // ---- Voice engine state (disclosure) ----------------------------------

    const voice = createDisclosure(t("logs.voiceDiagnostics"));
    const diagRefresh = createElement(
      "button",
      { class: "ac-btn secondary", type: "button" },
      t("logs.refreshDiagnostics"),
    );
    diagRefresh.addEventListener("click", refreshDiag, { signal: buildSignal });
    const voiceTools = createElement("div", { class: "settings-toolbar" });
    voiceTools.appendChild(diagRefresh);
    appendChildren(voice.details, voiceTools, diagPanel);
    section.appendChild(voice.details);

    // ---- Screen share testing ---------------------------------------------

    const shareCard = createElement("section", {
      class: "settings-card",
      "data-testid": "share-testing",
      "aria-labelledby": "logs-share-testing-title",
    });
    const shareHead = createElement("div", { class: "settings-card-head" });
    shareHead.appendChild(
      createElement("h3", { id: "logs-share-testing-title" }, t("logs.shareTesting")),
    );
    shareCard.appendChild(shareHead);
    appendToggleRows(
      shareCard,
      [
        {
          key: SHARE_DIAGNOSTICS_KEY,
          label: t("logs.shareRecord"),
          desc: t("logs.shareRecordDesc"),
          fallback: false,
        },
      ],
      buildSignal,
    );
    const modeRow = createElement("div", { class: "setting-row" });
    const modeInfo = createElement("div", {});
    appendChildren(
      modeInfo,
      createElement("div", { class: "setting-label" }, t("logs.shareMode")),
      createElement("div", { class: "setting-desc" }, t("logs.shareModeDesc")),
    );
    const modeSelect = createElement("select", {
      class: "settings-select",
      "aria-label": t("logs.shareMode"),
      "data-testid": "share-motion-policy",
    });
    for (const policy of SHARE_MOTION_POLICIES) {
      modeSelect.appendChild(
        createElement("option", { value: policy }, t(`logs.shareMode.${policy}`)),
      );
    }
    modeSelect.value = getShareMotionPolicy();
    modeSelect.addEventListener(
      "change",
      () => {
        if (isShareMotionPolicy(modeSelect.value)) {
          savePref(SHARE_MOTION_POLICY_KEY, modeSelect.value);
        }
      },
      { signal: buildSignal },
    );
    appendChildren(modeRow, modeInfo, modeSelect);
    shareCard.appendChild(modeRow);
    section.appendChild(shareCard);

    // Live update: subscribe to new log entries
    unsubLogListener?.();
    unsubLogListener = addLogListener(() => {
      if (getActiveTab() === "Logs") {
        renderLogEntries();
      }
    });

    return section;
  }

  function cleanup(): void {
    cleanupConnectionDiagnostics?.();
    cleanupConnectionDiagnostics = null;
    unsubLogListener?.();
    unsubLogListener = null;
    logListEl = null;
    countEl = null;
  }

  return { build, cleanup };
}
