import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// vi.hoisted ensures these are available when vi.mock factory runs
const {
  mockGetLogBuffer,
  mockClearLogBuffer,
  mockAddLogListener,
  mockSetLogLevel,
} = vi.hoisted(() => ({
  mockGetLogBuffer: vi.fn(),
  mockClearLogBuffer: vi.fn(),
  mockAddLogListener: vi.fn(),
  mockSetLogLevel: vi.fn(),
}));

vi.mock("@lib/logger", () => ({
  getLogBuffer: mockGetLogBuffer,
  clearLogBuffer: mockClearLogBuffer,
  addLogListener: mockAddLogListener,
  setLogLevel: mockSetLogLevel,
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock("@lib/livekitSession", () => ({
  getSessionDebugInfo: vi.fn().mockReturnValue({}),
}));

import { createLogsTab } from "../../src/components/settings/LogsTab";
import type { TabName } from "../../src/components/SettingsOverlay";

function makeMockEntry(level: "debug" | "info" | "warn" | "error", msg: string) {
  return {
    level,
    message: msg,
    component: "test",
    timestamp: "2026-03-17T12:00:00.000Z",
  };
}

describe("LogsTab", () => {
  let controller: AbortController;

  beforeEach(() => {
    vi.restoreAllMocks();
    controller = new AbortController();
    mockGetLogBuffer.mockReturnValue([]);
    mockAddLogListener.mockReturnValue(() => {});
  });

  afterEach(() => {
    controller.abort();
  });

  it("returns an object with build and cleanup", () => {
    const handle = createLogsTab(() => "Logs" as TabName, controller.signal);
    expect(handle).toHaveProperty("build");
    expect(handle).toHaveProperty("cleanup");
  });

  it("build() returns a div with settings-pane class", () => {
    const handle = createLogsTab(() => "Logs" as TabName, controller.signal);
    const el = handle.build();
    expect(el.tagName).toBe("DIV");
    expect(el.className).toBe("settings-pane active");
  });

  it("renders a Voice Diagnostics header", () => {
    const handle = createLogsTab(() => "Logs" as TabName, controller.signal);
    const el = handle.build();
    const h3 = el.querySelector("h3");
    expect(h3).not.toBeNull();
    expect(h3!.textContent).toBe("Voice Diagnostics");
  });

  it("renders log entries from getLogBuffer", () => {
    mockGetLogBuffer.mockReturnValue([
      makeMockEntry("info", "hello"),
      makeMockEntry("warn", "warning"),
    ]);
    const handle = createLogsTab(() => "Logs" as TabName, controller.signal);
    const el = handle.build();
    const entries = el.querySelectorAll(".log-entry");
    expect(entries.length).toBe(2);
  });

  it("renders log entry with data field", () => {
    mockGetLogBuffer.mockReturnValue([
      { ...makeMockEntry("info", "with data"), data: { key: "value" } },
    ]);
    const handle = createLogsTab(() => "Logs" as TabName, controller.signal);
    const el = handle.build();
    const pre = el.querySelector("pre");
    expect(pre).not.toBeNull();
  });

  it("renders log entry with string data field", () => {
    mockGetLogBuffer.mockReturnValue([
      { ...makeMockEntry("info", "str data"), data: "some string" },
    ]);
    const handle = createLogsTab(() => "Logs" as TabName, controller.signal);
    const el = handle.build();
    // Find the <pre> inside a log-entry row (not the diagnostics result <pre>).
    const pre = el.querySelector(".log-entry pre");
    expect(pre).not.toBeNull();
    expect(pre!.textContent).toBe("some string");
  });

  it("renders filter dropdown and level selector", () => {
    const handle = createLogsTab(() => "Logs" as TabName, controller.signal);
    const el = handle.build();
    const selects = el.querySelectorAll("select");
    expect(selects.length).toBe(2);
  });

  it("renders Clear Logs and Refresh buttons", () => {
    const handle = createLogsTab(() => "Logs" as TabName, controller.signal);
    const el = handle.build();
    const buttons = el.querySelectorAll("button");
    const texts = Array.from(buttons).map((b) => b.textContent);
    expect(texts).toContain("Clear Logs");
    expect(texts).toContain("Refresh");
  });

  it("shows entry count", () => {
    mockGetLogBuffer.mockReturnValue([
      makeMockEntry("info", "one"),
      makeMockEntry("info", "two"),
      makeMockEntry("info", "three"),
    ]);
    const handle = createLogsTab(() => "Logs" as TabName, controller.signal);
    const el = handle.build();
    expect(el.textContent).toContain("3 entries");
  });

  it("subscribes to log listener on build", () => {
    const handle = createLogsTab(() => "Logs" as TabName, controller.signal);
    handle.build();
    expect(mockAddLogListener).toHaveBeenCalledTimes(1);
  });

  it("cleanup unsubscribes log listener", () => {
    const unsub = vi.fn();
    mockAddLogListener.mockReturnValue(unsub);
    const handle = createLogsTab(() => "Logs" as TabName, controller.signal);
    handle.build();
    handle.cleanup();
    expect(unsub).toHaveBeenCalledTimes(1);
  });

  it("filter dropdown changes filter level", () => {
    mockGetLogBuffer.mockReturnValue([
      makeMockEntry("info", "info msg"),
      makeMockEntry("warn", "warn msg"),
    ]);
    const handle = createLogsTab(() => "Logs" as TabName, controller.signal);
    const el = handle.build();
    const filterSelect = el.querySelectorAll("select")[0]!;

    // Change to "warn" filter
    filterSelect.value = "warn";
    filterSelect.dispatchEvent(new Event("change"));

    const entries = el.querySelectorAll(".log-entry");
    expect(entries.length).toBe(1);
  });

  it("clear button calls clearLogBuffer", () => {
    const handle = createLogsTab(() => "Logs" as TabName, controller.signal);
    const el = handle.build();
    const clearBtn = Array.from(el.querySelectorAll("button")).find(
      (b) => b.textContent === "Clear Logs",
    );
    clearBtn!.click();
    expect(mockClearLogBuffer).toHaveBeenCalledTimes(1);
  });

  it("level selector calls setLogLevel", () => {
    const handle = createLogsTab(() => "Logs" as TabName, controller.signal);
    const el = handle.build();
    const levelSelect = el.querySelectorAll("select")[1]!;
    levelSelect.value = "error";
    levelSelect.dispatchEvent(new Event("change"));
    expect(mockSetLogLevel).toHaveBeenCalledWith("error");
  });

  it("Copy All shows 'Failed to copy' on clipboard rejection", async () => {
    mockGetLogBuffer.mockReturnValue([makeMockEntry("info", "test")]);
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
    });

    const handle = createLogsTab(() => "Logs" as TabName, controller.signal);
    const el = handle.build();
    const copyBtn = Array.from(el.querySelectorAll("button")).find(
      (b) => b.textContent === "Copy All",
    )!;
    copyBtn.click();

    await vi.waitFor(() => {
      expect(copyBtn.textContent).toBe("Failed to copy");
    });
  });

  it("Copy Diagnostics shows 'Failed to copy' on clipboard rejection", async () => {
    mockGetLogBuffer.mockReturnValue([]);
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
    });

    const handle = createLogsTab(() => "Logs" as TabName, controller.signal);
    const el = handle.build();
    const diagCopy = Array.from(el.querySelectorAll("button")).find(
      (b) => b.textContent === "Copy Diagnostics",
    )!;
    diagCopy.click();

    await vi.waitFor(() => {
      expect(diagCopy.textContent).toBe("Failed to copy");
    });
  });

  it("filter level persists via owncord:settings prefix", () => {
    mockGetLogBuffer.mockReturnValue([]);
    localStorage.clear();

    const handle = createLogsTab(() => "Logs" as TabName, controller.signal);
    const el = handle.build();
    const filterSelect = el.querySelectorAll("select")[0]!;

    filterSelect.value = "error";
    filterSelect.dispatchEvent(new Event("change"));

    // Should use owncord:settings: prefix (normalized)
    expect(localStorage.getItem("owncord:settings:logs_filter_level")).toBe('"error"');
  });

  it("restores legacy unprefixed filter level and migrates it", () => {
    mockGetLogBuffer.mockReturnValue([]);
    localStorage.clear();
    localStorage.setItem("logs_filter_level", "warn");

    const handle = createLogsTab(() => "Logs" as TabName, controller.signal);
    const el = handle.build();
    const filterSelect = el.querySelectorAll("select")[0]!;

    expect(filterSelect.value).toBe("warn");
    expect(localStorage.getItem("owncord:settings:logs_filter_level")).toBe('"warn"');
  });

  it("restores legacy unprefixed min level and migrates it", () => {
    mockGetLogBuffer.mockReturnValue([]);
    localStorage.clear();
    localStorage.setItem("logs_min_level", "error");

    const handle = createLogsTab(() => "Logs" as TabName, controller.signal);
    const el = handle.build();
    const levelSelect = el.querySelectorAll("select")[1]!;

    expect(levelSelect.value).toBe("error");
    expect(mockSetLogLevel).toHaveBeenCalledWith("error");
    expect(localStorage.getItem("owncord:settings:logs_min_level")).toBe('"error"');
  });

  it("Copy All shows 'Copied!' on successful clipboard write", async () => {
    mockGetLogBuffer.mockReturnValue([makeMockEntry("info", "test")]);
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    });

    const handle = createLogsTab(() => "Logs" as TabName, controller.signal);
    const el = handle.build();
    const copyBtn = Array.from(el.querySelectorAll("button")).find(
      (b) => b.textContent === "Copy All",
    )!;
    copyBtn.click();

    await vi.waitFor(() => {
      expect(copyBtn.textContent).toBe("Copied!");
    });
  });

  it("Copy Diagnostics shows 'Copied!' on successful clipboard write", async () => {
    mockGetLogBuffer.mockReturnValue([]);
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    });

    const handle = createLogsTab(() => "Logs" as TabName, controller.signal);
    const el = handle.build();
    const diagCopy = Array.from(el.querySelectorAll("button")).find(
      (b) => b.textContent === "Copy Diagnostics",
    )!;
    diagCopy.click();

    await vi.waitFor(() => {
      expect(diagCopy.textContent).toBe("Copied!");
    });
  });

  it("Refresh button re-renders log entries", () => {
    mockGetLogBuffer.mockReturnValue([makeMockEntry("info", "initial")]);
    const handle = createLogsTab(() => "Logs" as TabName, controller.signal);
    const el = handle.build();

    expect(el.querySelectorAll(".log-entry").length).toBe(1);

    // Add more entries
    mockGetLogBuffer.mockReturnValue([
      makeMockEntry("info", "initial"),
      makeMockEntry("warn", "new entry"),
    ]);

    const refreshBtn = Array.from(el.querySelectorAll("button")).find(
      (b) => b.textContent === "Refresh",
    )!;
    refreshBtn.click();

    expect(el.querySelectorAll(".log-entry").length).toBe(2);
  });

  it("live log listener updates entries when on the Logs tab", () => {
    mockGetLogBuffer.mockReturnValue([]);
    let logCallback: (() => void) | null = null;
    mockAddLogListener.mockImplementation((cb: () => void) => {
      logCallback = cb;
      return () => { logCallback = null; };
    });

    const handle = createLogsTab(() => "Logs" as TabName, controller.signal);
    const el = handle.build();
    expect(el.querySelectorAll(".log-entry").length).toBe(0);

    // Simulate a new log entry arriving
    mockGetLogBuffer.mockReturnValue([makeMockEntry("error", "live entry")]);
    logCallback?.();

    expect(el.querySelectorAll(".log-entry").length).toBe(1);
  });

  it("live log listener does NOT update when on a different tab", () => {
    mockGetLogBuffer.mockReturnValue([]);
    let logCallback: (() => void) | null = null;
    mockAddLogListener.mockImplementation((cb: () => void) => {
      logCallback = cb;
      return () => { logCallback = null; };
    });

    const handle = createLogsTab(() => "Account" as TabName, controller.signal);
    const el = handle.build();

    mockGetLogBuffer.mockReturnValue([makeMockEntry("error", "live entry")]);
    logCallback?.();

    // Should not have updated since active tab is not "Logs"
    expect(el.querySelectorAll(".log-entry").length).toBe(0);
  });

  it("Copy All includes data field in copied text", async () => {
    const writeTextMock = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, {
      clipboard: { writeText: writeTextMock },
    });
    mockGetLogBuffer.mockReturnValue([
      { ...makeMockEntry("info", "with data"), data: { key: "value" } },
    ]);

    const handle = createLogsTab(() => "Logs" as TabName, controller.signal);
    const el = handle.build();
    const copyBtn = Array.from(el.querySelectorAll("button")).find(
      (b) => b.textContent === "Copy All",
    )!;
    copyBtn.click();

    await vi.waitFor(() => {
      expect(writeTextMock).toHaveBeenCalledTimes(1);
    });

    const copiedText = writeTextMock.mock.calls[0]![0] as string;
    expect(copiedText).toContain("with data");
    expect(copiedText).toContain('"key"');
  });

  it("Refresh Diagnostics button re-renders diagnostics panel", () => {
    mockGetLogBuffer.mockReturnValue([]);
    const handle = createLogsTab(() => "Logs" as TabName, controller.signal);
    const el = handle.build();

    const diagRefresh = Array.from(el.querySelectorAll("button")).find(
      (b) => b.textContent === "Refresh Diagnostics",
    )!;
    // Should not throw
    diagRefresh.click();

    const diagPanel = el.querySelector("[style*='monospace']");
    expect(diagPanel).not.toBeNull();
  });
});
