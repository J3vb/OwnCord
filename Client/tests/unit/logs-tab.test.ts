import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// vi.hoisted ensures these are available when vi.mock factory runs
const {
  mockGetLogBuffer,
  mockClearLogBuffer,
  mockAddLogListener,
  mockSetLogLevel,
  mockGetLogLevel,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} = vi.hoisted(() => ({
  mockGetLogBuffer: vi.fn<any>(),
  mockClearLogBuffer: vi.fn<any>(),
  mockAddLogListener: vi.fn<any>(),
  mockSetLogLevel: vi.fn<any>(),
  mockGetLogLevel: vi.fn<any>(),
}));

vi.mock("@lib/logger", () => ({
  getLogBuffer: mockGetLogBuffer,
  clearLogBuffer: mockClearLogBuffer,
  addLogListener: mockAddLogListener,
  setLogLevel: mockSetLogLevel,
  getLogLevel: mockGetLogLevel,
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock("@lib/livekitSession", () => ({
  getSessionDebugInfo: vi.fn().mockReturnValue({}),
}));

const { mockExportSupportBundle } = vi.hoisted(() => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockExportSupportBundle: vi.fn<any>(),
}));
vi.mock("@lib/supportBundle", () => ({ exportSupportBundle: mockExportSupportBundle }));

import { getSessionDebugInfo } from "@lib/livekitSession";
import { createLogsTab } from "../../src/components/settings/LogsTab";
import type { TabName } from "../../src/components/SettingsOverlay";

/** The <details> whose summary starts with `label`. */
function disclosure(el: HTMLElement, label: string): HTMLDetailsElement {
  const found = [...el.querySelectorAll("details")].find((d) =>
    d.querySelector("summary")!.textContent!.startsWith(label),
  );
  expect(found, `a disclosure named ${label}`).toBeDefined();
  return found!;
}

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
    // vitest 4's restoreAllMocks no longer resets vi.fn() state — reset
    // explicitly so call counts don't accumulate across tests.
    vi.resetAllMocks();
    controller = new AbortController();
    mockGetLogBuffer.mockReturnValue([]);
    mockAddLogListener.mockReturnValue(() => {});
    mockGetLogLevel.mockReturnValue("info");
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

  it("keeps the voice engine state in its own closed disclosure", () => {
    const handle = createLogsTab(() => "Logs" as TabName, controller.signal);
    const el = handle.build();
    const voice = disclosure(el, "Voice engine state");
    expect(voice.open).toBe(false);
    expect(voice.querySelector(".diag-state")).not.toBeNull();
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

  it("Copy Diagnostics copies the voice state as of the click, not as of the build", async () => {
    mockGetLogBuffer.mockReturnValue([]);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    const el = createLogsTab(() => "Logs" as TabName, controller.signal).build();
    vi.mocked(getSessionDebugInfo).mockReturnValue({ hasRoom: true } as never);
    Array.from(el.querySelectorAll("button"))
      .find((b) => b.textContent === "Copy Diagnostics")!
      .click();

    expect(JSON.parse(writeText.mock.calls[0]![0] as string)).toEqual({ hasRoom: true });
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

  it("defaults min-level select to the effective runtime level when no pref is saved", () => {
    mockGetLogBuffer.mockReturnValue([]);
    localStorage.clear();
    mockGetLogLevel.mockReturnValue("info");

    const handle = createLogsTab(() => "Logs" as TabName, controller.signal);
    const el = handle.build();
    const levelSelect = el.querySelectorAll("select")[1]!;

    // Reflects getLogLevel() rather than the first option (DEBUG); no save/apply.
    expect(levelSelect.value).toBe("info");
    expect(mockSetLogLevel).not.toHaveBeenCalled();
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
    let logCallback: (() => void) | undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockAddLogListener.mockImplementation(((cb: any) => {
      logCallback = cb;
      return () => {
        logCallback = undefined;
      };
    }) as any);

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
    let logCallback: (() => void) | undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockAddLogListener.mockImplementation(((cb: any) => {
      logCallback = cb;
      return () => {
        logCallback = undefined;
      };
    }) as any);

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

  it("clear button updates the entry count, not just the list", () => {
    mockGetLogBuffer.mockReturnValue([makeMockEntry("info", "one"), makeMockEntry("info", "two")]);
    const handle = createLogsTab(() => "Logs" as TabName, controller.signal);
    const el = handle.build();
    expect(el.textContent).toContain("2 entries");

    // Simulate clearLogBuffer() actually emptying the buffer.
    mockClearLogBuffer.mockImplementation(() => {
      mockGetLogBuffer.mockReturnValue([]);
    });

    const clearBtn = Array.from(el.querySelectorAll("button")).find(
      (b) => b.textContent === "Clear Logs",
    )!;
    clearBtn.click();

    expect(el.querySelectorAll(".log-entry").length).toBe(0);
    expect(el.textContent).toContain("0 entries");
    expect(el.textContent).not.toContain("2 entries");
  });

  it("Refresh button updates the entry count to match the refreshed list", () => {
    mockGetLogBuffer.mockReturnValue([makeMockEntry("info", "initial")]);
    const handle = createLogsTab(() => "Logs" as TabName, controller.signal);
    const el = handle.build();
    expect(el.textContent).toContain("1 entry ·");

    mockGetLogBuffer.mockReturnValue([
      makeMockEntry("info", "initial"),
      makeMockEntry("warn", "new entry"),
    ]);

    const refreshBtn = Array.from(el.querySelectorAll("button")).find(
      (b) => b.textContent === "Refresh",
    )!;
    refreshBtn.click();

    expect(el.textContent).toContain("2 entries");
    expect(el.textContent).not.toContain("1 entry ·");
  });

  it("Refresh Diagnostics button re-renders diagnostics panel", () => {
    mockGetLogBuffer.mockReturnValue([]);
    const handle = createLogsTab(() => "Logs" as TabName, controller.signal);
    const el = handle.build();

    const diagRefresh = Array.from(el.querySelectorAll("button")).find(
      (b) => b.textContent === "Refresh Diagnostics",
    )!;
    vi.mocked(getSessionDebugInfo).mockReturnValue({ hasRoom: true } as never);
    diagRefresh.click();

    const diagPanel = el.querySelector(".diag-state");
    expect(diagPanel).not.toBeNull();
    expect(JSON.parse(diagPanel!.textContent!)).toEqual({ hasRoom: true });
  });

  // B7-15c: the support bundle is exported locally and the UI says plainly
  // that log lines go out unredacted.
  describe("support bundle", () => {
    function build() {
      const el = createLogsTab(() => "Logs" as TabName, controller.signal).build();
      document.body.appendChild(el);
      return el;
    }

    it("states that nothing is uploaded and that logs are not redacted", () => {
      const el = build();
      expect(el.textContent).toContain(
        "Saves a zip of your logs, diagnostics and settings on this computer. Nothing is uploaded.",
      );
      expect(el.textContent).toContain("Log lines are not redacted, so read them before sharing.");
      el.remove();
    });

    it("exports on click and reports the save", async () => {
      mockExportSupportBundle.mockResolvedValue(true);
      const el = build();
      const btn = el.querySelector("[data-testid='export-support-bundle']") as HTMLButtonElement;
      btn.click();
      expect(btn.disabled).toBe(true);
      const status = el.querySelector("[data-testid='support-bundle-status']")!;
      await vi.waitFor(() => expect(status.textContent).toBe("Support bundle saved."));
      expect(mockExportSupportBundle).toHaveBeenCalledTimes(1);
      expect(btn.disabled).toBe(false);
      el.remove();
    });

    it("says nothing when the dialog is cancelled and reports a failure", async () => {
      mockExportSupportBundle.mockResolvedValueOnce(false);
      const el = build();
      const btn = el.querySelector("[data-testid='export-support-bundle']") as HTMLButtonElement;
      const status = el.querySelector("[data-testid='support-bundle-status']")!;
      btn.click();
      await vi.waitFor(() => expect(btn.disabled).toBe(false));
      expect(status.textContent).toBe("");

      mockExportSupportBundle.mockRejectedValueOnce(new Error("disk full"));
      btn.click();
      await vi.waitFor(() => expect(status.textContent).toBe("Export failed: disk full"));
      el.remove();
    });
  });

  describe("Diagnostics & logs layout", () => {
    const buttonNamed = (el: HTMLElement, text: string) =>
      [...el.querySelectorAll("button")].find((b) => b.textContent === text)!;

    it("keeps the client logs in a closed disclosure whose summary counts entries, warnings and errors", () => {
      mockGetLogBuffer.mockReturnValue([
        makeMockEntry("info", "a"),
        makeMockEntry("warn", "b"),
        makeMockEntry("error", "c"),
        makeMockEntry("error", "d"),
      ]);
      const el = createLogsTab(() => "Logs" as TabName, controller.signal).build();
      const logs = disclosure(el, "Client logs");
      expect(logs.open).toBe(false);
      expect(logs.querySelector("summary")!.textContent).toContain(
        "4 entries · 1 warning · 2 errors",
      );
      expect(logs.querySelectorAll(".log-entry")).toHaveLength(4);
    });

    it("scrolls to the newest entry when the client logs are opened", () => {
      mockGetLogBuffer.mockReturnValue([makeMockEntry("info", "a"), makeMockEntry("info", "b")]);
      const el = createLogsTab(() => "Logs" as TabName, controller.signal).build();
      const logs = disclosure(el, "Client logs");
      const viewer = logs.querySelector<HTMLElement>(".log-viewer")!;
      Object.defineProperty(viewer, "scrollHeight", { value: 480 });
      Object.defineProperty(viewer, "scrollTop", { value: 0, writable: true });

      logs.open = true;
      logs.dispatchEvent(new Event("toggle"));

      expect(viewer.scrollTop).toBe(480);
    });

    it("updates the summary counts as live entries arrive", () => {
      let listener: () => void = () => {};
      mockAddLogListener.mockImplementation((...args: unknown[]) => {
        listener = args[0] as () => void;
        return () => {};
      });
      mockGetLogBuffer.mockReturnValue([makeMockEntry("info", "a")]);
      const el = createLogsTab(() => "Logs" as TabName, controller.signal).build();
      const summary = disclosure(el, "Client logs").querySelector("summary")!;
      expect(summary.textContent).toContain("1 entry · 0 warnings · 0 errors");
      mockGetLogBuffer.mockReturnValue([makeMockEntry("info", "a"), makeMockEntry("warn", "b")]);
      listener();
      expect(summary.textContent).toContain("2 entries · 1 warning · 0 errors");
    });

    it("gives the Get help card one primary action: export the support bundle", () => {
      const el = createLogsTab(() => "Logs" as TabName, controller.signal).build();
      const card = el.querySelector<HTMLElement>("[data-testid='get-help']")!;
      expect(card.querySelector("h3")!.textContent).toBe("Get help");
      const exportBtn = card.querySelector("[data-testid='export-support-bundle']")!;
      expect(exportBtn.classList.contains("secondary")).toBe(false);
      expect(buttonNamed(card, "Copy Diagnostics").classList.contains("secondary")).toBe(true);
    });

    it("makes every log and voice-state tool a secondary button", () => {
      const el = createLogsTab(() => "Logs" as TabName, controller.signal).build();
      for (const text of ["Copy All", "Clear Logs", "Refresh", "Refresh Diagnostics"]) {
        expect(buttonNamed(el, text).classList.contains("secondary"), text).toBe(true);
      }
    });

    it("colours log levels with tokens through classes, never literal hex inline styles", () => {
      mockGetLogBuffer.mockReturnValue([
        { ...makeMockEntry("debug", "d"), data: { k: 1 } },
        makeMockEntry("error", "e"),
      ]);
      const el = createLogsTab(() => "Logs" as TabName, controller.signal).build();
      const [debug, error] = [...el.querySelectorAll<HTMLElement>(".log-entry")];
      expect(debug!.classList.contains("log-debug")).toBe(true);
      expect(error!.classList.contains("log-error")).toBe(true);
      const hexStyles = [...el.querySelectorAll<HTMLElement>("[style]")].filter((n) =>
        /#[0-9a-f]{3,6}\b/i.test(n.getAttribute("style")!),
      );
      expect(hexStyles).toEqual([]);
    });
  });
});
