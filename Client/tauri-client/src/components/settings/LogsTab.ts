/**
 * Logs settings tab — log viewer with filtering, level control, live updates.
 */

import { createElement, appendChildren, clearChildren } from "@lib/dom";
import { getLogBuffer, clearLogBuffer, addLogListener, setLogLevel } from "@lib/logger";
import type { LogEntry, LogLevel } from "@lib/logger";
import type { TabName } from "../SettingsOverlay";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LOG_LEVEL_COLORS: Record<LogLevel, string> = {
  debug: "#888",
  info: "#3ba55d",
  warn: "#faa61a",
  error: "#ed4245",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatLogEntry(entry: LogEntry): HTMLDivElement {
  const row = createElement("div", {
    class: "log-entry",
    style: `border-left: 3px solid ${LOG_LEVEL_COLORS[entry.level]}; padding: 4px 8px; margin: 2px 0; font-family: monospace; font-size: 12px; line-height: 1.4;`,
  });
  const time = entry.timestamp.slice(11, 23); // HH:MM:SS.mmm
  const level = entry.level.toUpperCase().padEnd(5);
  const text = `${time} ${level} [${entry.component}] ${entry.message}`;
  const textEl = createElement("span", {
    style: `color: ${LOG_LEVEL_COLORS[entry.level]}`,
  }, text);
  row.appendChild(textEl);

  if (entry.data !== undefined) {
    const dataStr = typeof entry.data === "string" ? entry.data : JSON.stringify(entry.data, null, 2);
    const dataEl = createElement("pre", {
      style: "margin: 2px 0 0 0; color: #999; font-size: 11px; white-space: pre-wrap; word-break: break-all;",
    }, dataStr);
    row.appendChild(dataEl);
  }

  return row;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface LogsTabHandle {
  build(): HTMLDivElement;
  cleanup(): void;
}

export function createLogsTab(
  getActiveTab: () => TabName,
  signal: AbortSignal,
): LogsTabHandle {
  let logListEl: HTMLDivElement | null = null;
  let logFilterLevel: LogLevel | "all" = "all";
  let unsubLogListener: (() => void) | null = null;

  function renderLogEntries(): void {
    if (logListEl === null) return;
    clearChildren(logListEl);

    const entries = getLogBuffer();
    for (const entry of entries) {
      if (logFilterLevel !== "all" && entry.level !== logFilterLevel) continue;
      logListEl.appendChild(formatLogEntry(entry));
    }

    // Auto-scroll to bottom
    logListEl.scrollTop = logListEl.scrollHeight;
  }

  function build(): HTMLDivElement {
    const section = createElement("div", { class: "settings-pane active" });
    const header = createElement("h1", {}, "Logs");
    section.appendChild(header);

    // Controls row
    const controls = createElement("div", {
      style: "display: flex; gap: 8px; margin-bottom: 8px; align-items: center;",
    });

    // Filter dropdown
    const filterLabel = createElement("span", { class: "setting-label", style: "margin: 0;" }, "Filter:");
    const filterSelect = createElement("select", {
      style: "background: var(--bg-tertiary); color: var(--text-normal); border: 1px solid var(--bg-active); border-radius: 4px; padding: 4px 8px; font-size: 13px;",
    });
    const levels: Array<LogLevel | "all"> = ["all", "debug", "info", "warn", "error"];
    for (const lvl of levels) {
      const opt = createElement("option", { value: lvl }, lvl.toUpperCase());
      if (lvl === logFilterLevel) opt.setAttribute("selected", "");
      filterSelect.appendChild(opt);
    }
    filterSelect.addEventListener("change", () => {
      logFilterLevel = filterSelect.value as LogLevel | "all";
      renderLogEntries();
    }, { signal });

    // Log level selector
    const levelLabel = createElement("span", { class: "setting-label", style: "margin: 0 0 0 16px;" }, "Min Level:");
    const levelSelect = createElement("select", {
      style: "background: var(--bg-tertiary); color: var(--text-normal); border: 1px solid var(--bg-active); border-radius: 4px; padding: 4px 8px; font-size: 13px;",
    });
    const minLevels: LogLevel[] = ["debug", "info", "warn", "error"];
    for (const lvl of minLevels) {
      const opt = createElement("option", { value: lvl }, lvl.toUpperCase());
      levelSelect.appendChild(opt);
    }
    levelSelect.addEventListener("change", () => {
      setLogLevel(levelSelect.value as LogLevel);
    }, { signal });

    // Clear button
    const clearBtn = createElement("button", {
      class: "ac-btn",
      style: "margin-left: auto;",
    }, "Clear Logs");
    clearBtn.addEventListener("click", () => {
      clearLogBuffer();
      renderLogEntries();
    }, { signal });

    // Refresh button
    const refreshBtn = createElement("button", { class: "ac-btn" }, "Refresh");
    refreshBtn.addEventListener("click", () => renderLogEntries(), { signal });

    appendChildren(controls, filterLabel, filterSelect, levelLabel, levelSelect, clearBtn, refreshBtn);
    section.appendChild(controls);

    // Log count
    const countEl = createElement("div", {
      style: "font-size: 12px; color: #888; margin-bottom: 4px;",
    }, `${getLogBuffer().length} entries`);
    section.appendChild(countEl);

    // Log list (scrollable)
    logListEl = createElement("div", {
      class: "log-viewer",
      style: "max-height: 60vh; overflow-y: auto; background: var(--bg-tertiary); border-radius: 8px; padding: 8px;",
    });
    section.appendChild(logListEl);

    renderLogEntries();

    // Live update: subscribe to new log entries
    unsubLogListener?.();
    unsubLogListener = addLogListener(() => {
      if (getActiveTab() === "Logs") {
        renderLogEntries();
        countEl.textContent = `${getLogBuffer().length} entries`;
      }
    });

    return section;
  }

  function cleanup(): void {
    unsubLogListener?.();
    unsubLogListener = null;
    logListEl = null;
  }

  return { build, cleanup };
}
