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

  it("renders a Logs header", () => {
    const handle = createLogsTab(() => "Logs" as TabName, controller.signal);
    const el = handle.build();
    const h1 = el.querySelector("h1");
    expect(h1!.textContent).toBe("Logs");
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
    const pre = el.querySelector("pre");
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
});
