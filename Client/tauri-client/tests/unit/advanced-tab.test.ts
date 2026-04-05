import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const {
  mockReadDir,
  mockRemove,
  mockRelaunch,
  mockClearPendingPersistedLogs,
  mockClearAttachmentCaches,
  mockClearEmbedCaches,
  mockClearMediaCaches,
  deleteDbState,
} = vi.hoisted(() => ({
  mockReadDir: vi.fn().mockResolvedValue([]),
  mockRemove: vi.fn().mockResolvedValue(undefined),
  mockRelaunch: vi.fn().mockResolvedValue(undefined),
  mockClearPendingPersistedLogs: vi.fn(),
  mockClearAttachmentCaches: vi.fn(),
  mockClearEmbedCaches: vi.fn(),
  mockClearMediaCaches: vi.fn(),
  deleteDbState: {
    mode: "success" as
      | "success"
      | "blocked-then-success"
      | "blocked-stuck"
      | "error"
      | "blocked-double"
      | "success-then-blocked",
  },
}));

// Mock Tauri APIs
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@tauri-apps/api/path", () => ({
  appLogDir: vi.fn().mockResolvedValue("/mock/logs"),
  join: vi.fn((...args: string[]) => args.join("/")),
}));
vi.mock("@tauri-apps/plugin-fs", () => ({
  readDir: mockReadDir,
  remove: mockRemove,
}));
vi.mock("@tauri-apps/plugin-process", () => ({
  relaunch: mockRelaunch,
}));
vi.mock("@lib/logger", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock("@lib/logPersistence", () => ({
  clearPendingPersistedLogs: mockClearPendingPersistedLogs,
}));

vi.mock("@components/message-list/attachments", () => ({
  clearAttachmentCaches: mockClearAttachmentCaches,
}));

vi.mock("@components/message-list/embeds", () => ({
  clearEmbedCaches: mockClearEmbedCaches,
}));

vi.mock("@components/message-list/media", () => ({
  clearMediaCaches: mockClearMediaCaches,
}));

// Stub globalThis.indexedDB with a simple fake that resolves deleteDatabase
vi.stubGlobal("indexedDB", {
  deleteDatabase: (_name: string) => {
    const fakeReq: Record<string, unknown> = {
      onsuccess: null,
      onerror: null,
      onblocked: null,
      result: undefined,
      error: null,
      readyState: "done",
    };
    Promise.resolve().then(() => {
      if (deleteDbState.mode === "success") {
        const fn = fakeReq.onsuccess as ((ev: Event) => void) | null;
        fn?.(new Event("success"));
      } else if (deleteDbState.mode === "blocked-then-success") {
        const fn = fakeReq.onblocked as ((ev: Event) => void) | null;
        fn?.(new Event("blocked"));
        setTimeout(() => {
          const success = fakeReq.onsuccess as ((ev: Event) => void) | null;
          success?.(new Event("success"));
        }, 0);
      } else if (deleteDbState.mode === "blocked-stuck") {
        const fn = fakeReq.onblocked as ((ev: Event) => void) | null;
        fn?.(new Event("blocked"));
      } else if (deleteDbState.mode === "blocked-double") {
        // Fire onblocked twice to test the blockedTimer guard
        const fn = fakeReq.onblocked as ((ev: Event) => void) | null;
        fn?.(new Event("blocked"));
        fn?.(new Event("blocked"));
      } else if (deleteDbState.mode === "success-then-blocked") {
        // Fire onsuccess first, then onblocked — tests the settled guard
        const successFn = fakeReq.onsuccess as ((ev: Event) => void) | null;
        successFn?.(new Event("success"));
        setTimeout(() => {
          const blockedFn = fakeReq.onblocked as ((ev: Event) => void) | null;
          blockedFn?.(new Event("blocked"));
        }, 0);
      } else {
        fakeReq.error = new Error("delete failed");
        const fn = fakeReq.onerror as ((ev: Event) => void) | null;
        fn?.(new Event("error"));
      }
    });
    return fakeReq;
  },
});

import { buildAdvancedTab } from "@components/settings/AdvancedTab";

describe("AdvancedTab — Clear All Cache", () => {
  let container: HTMLDivElement;
  const ac = new AbortController();

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    localStorage.clear();
    sessionStorage.clear();
    deleteDbState.mode = "success";
    mockReadDir.mockReset();
    mockReadDir.mockResolvedValue([]);
    mockRemove.mockReset();
    mockRemove.mockResolvedValue(undefined);
    mockRelaunch.mockReset();
    mockRelaunch.mockResolvedValue(undefined);
    mockClearPendingPersistedLogs.mockReset();
    mockClearAttachmentCaches.mockReset();
    mockClearEmbedCaches.mockReset();
    mockClearMediaCaches.mockReset();
  });

  afterEach(() => {
    container.remove();
    vi.useRealTimers();
  });

  function getClearAllBtn(): HTMLButtonElement {
    const section = buildAdvancedTab(ac.signal);
    container.appendChild(section);
    const buttons = container.querySelectorAll("button.ac-btn");
    const btn = Array.from(buttons).find(
      (b) => b.textContent === "Clear & Restart",
    ) as HTMLButtonElement;
    expect(btn).toBeDefined();
    return btn;
  }

  function getActionBtn(label: string): HTMLButtonElement {
    const section = buildAdvancedTab(ac.signal);
    container.appendChild(section);
    const buttons = container.querySelectorAll("button.ac-btn");
    const btn = Array.from(buttons).find((b) => b.textContent === label) as HTMLButtonElement;
    expect(btn).toBeDefined();
    return btn;
  }

  async function flush(): Promise<void> {
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  it("preserves owncord:profiles after Clear All Cache", async () => {
    localStorage.setItem(
      "owncord:profiles",
      JSON.stringify([{ name: "Local", host: "localhost" }]),
    );
    localStorage.setItem("owncord:settings:fontSize", "16");
    sessionStorage.setItem("some-session-key", "value");

    const btn = getClearAllBtn();

    // First click — confirmation
    btn.click();
    expect(btn.textContent).toBe("Are you sure? Click again");

    // Second click — execute
    btn.click();
    await flush();

    // Profiles MUST be preserved
    expect(localStorage.getItem("owncord:profiles")).not.toBeNull();
    // Other settings should be cleared
    expect(localStorage.getItem("owncord:settings:fontSize")).toBeNull();
    // sessionStorage should be cleared
    expect(sessionStorage.getItem("some-session-key")).toBeNull();
  });

  it("preserves credential keys after Clear All Cache", async () => {
    localStorage.setItem("owncord:credential:localhost", JSON.stringify({ user: "test" }));
    localStorage.setItem("owncord:settings:compactMode", "false");

    const btn = getClearAllBtn();

    btn.click();
    btn.click();
    await flush();

    expect(localStorage.getItem("owncord:credential:localhost")).not.toBeNull();
    expect(localStorage.getItem("owncord:settings:compactMode")).toBeNull();
  });

  it("preserves active and custom theme keys after Clear All Cache", async () => {
    localStorage.setItem("owncord:theme:active", "custom-sunrise");
    localStorage.setItem(
      "owncord:theme:custom:custom-sunrise",
      JSON.stringify({ name: "custom-sunrise" }),
    );
    localStorage.setItem("owncord:settings:accentColor", '"#00c8ff"');

    const btn = getClearAllBtn();

    btn.click();
    btn.click();
    await flush();

    expect(localStorage.getItem("owncord:theme:active")).toBe("custom-sunrise");
    expect(localStorage.getItem("owncord:theme:custom:custom-sunrise")).not.toBeNull();
    expect(localStorage.getItem("owncord:settings:accentColor")).toBeNull();
  });

  it("renders two-step confirmation for Clear All", () => {
    const btn = getClearAllBtn();
    expect(btn.textContent).toBe("Clear & Restart");

    btn.click();
    expect(btn.textContent).toBe("Are you sure? Click again");
    expect(btn.classList.contains("ac-btn-danger")).toBe(true);
  });

  it("clears runtime image and preview caches when clearing image cache succeeds", async () => {
    const btn = getActionBtn("Clear");

    btn.click();
    await flush();

    expect(mockClearAttachmentCaches).toHaveBeenCalledTimes(1);
    expect(mockClearEmbedCaches).toHaveBeenCalledTimes(1);
    expect(mockClearMediaCaches).toHaveBeenCalledTimes(1);
    expect(btn.textContent).toBe("Cleared!");
  });

  it("waits for a blocked image cache deletion to succeed", async () => {
    deleteDbState.mode = "blocked-then-success";
    const btn = getActionBtn("Clear");

    btn.click();

    await vi.waitFor(() => {
      expect(btn.textContent).toBe("Cleared!");
    });
    expect(mockClearAttachmentCaches).toHaveBeenCalledTimes(1);
    expect(mockClearEmbedCaches).toHaveBeenCalledTimes(1);
    expect(mockClearMediaCaches).toHaveBeenCalledTimes(1);
  });

  it("shows Failed when image cache deletion remains blocked", async () => {
    vi.useFakeTimers();
    deleteDbState.mode = "blocked-stuck";
    const btn = getActionBtn("Clear");

    btn.click();
    await vi.advanceTimersByTimeAsync(1000);

    expect(btn.textContent).toBe("Failed");
    expect(mockClearAttachmentCaches).not.toHaveBeenCalled();
    expect(mockClearEmbedCaches).not.toHaveBeenCalled();
    expect(mockClearMediaCaches).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("treats a missing log directory as an already-cleared success", async () => {
    mockReadDir.mockRejectedValueOnce(new Error("No such file or directory"));
    const section = buildAdvancedTab(ac.signal);
    container.appendChild(section);
    const clearButtons = Array.from(container.querySelectorAll("button.ac-btn")).filter(
      (b) => b.textContent === "Clear",
    );
    const btn = clearButtons[1] as HTMLButtonElement;
    expect(btn).toBeDefined();

    btn.click();

    await vi.waitFor(() => {
      expect(btn.textContent).toBe("Cleared!");
    });
  });

  it("shows Failed when removing existing log files errors", async () => {
    mockReadDir.mockResolvedValueOnce([{ name: "app.jsonl", isDirectory: false }]);
    mockRemove.mockRejectedValueOnce(new Error("Permission denied"));
    const section = buildAdvancedTab(ac.signal);
    container.appendChild(section);
    const clearButtons = Array.from(container.querySelectorAll("button.ac-btn")).filter(
      (b) => b.textContent === "Clear",
    );
    const btn = clearButtons[1] as HTMLButtonElement;
    expect(btn).toBeDefined();

    btn.click();

    await vi.waitFor(() => {
      expect(btn.textContent).toBe("Failed");
    });
  });

  it("clears buffered persisted logs before deleting log files", async () => {
    const section = buildAdvancedTab(ac.signal);
    container.appendChild(section);
    const clearButtons = Array.from(container.querySelectorAll("button.ac-btn")).filter(
      (b) => b.textContent === "Clear",
    );
    const btn = clearButtons[1] as HTMLButtonElement;

    btn.click();

    await vi.waitFor(() => {
      expect(btn.textContent).toBe("Cleared!");
    });
    expect(mockClearPendingPersistedLogs).toHaveBeenCalledTimes(1);
  });
});

describe("AdvancedTab — Toggles & Structure", () => {
  let container: HTMLDivElement;
  const ac = new AbortController();

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    localStorage.clear();
  });

  afterEach(() => {
    container.remove();
  });

  it("renders Developer Mode toggle defaulting to off", () => {
    const section = buildAdvancedTab(ac.signal);
    container.appendChild(section);

    const rows = container.querySelectorAll(".setting-row");
    const devRow = rows[0]!;
    const label = devRow.querySelector(".setting-label")!;
    expect(label.textContent).toBe("Developer Mode");

    const toggle = devRow.querySelector(".toggle")!;
    expect(toggle.classList.contains("on")).toBe(false);
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  });

  it("renders Hardware Acceleration toggle defaulting to on", () => {
    const section = buildAdvancedTab(ac.signal);
    container.appendChild(section);

    const rows = container.querySelectorAll(".setting-row");
    const hwRow = rows[1]!;
    const label = hwRow.querySelector(".setting-label")!;
    expect(label.textContent).toBe("Hardware Acceleration");

    const toggle = hwRow.querySelector(".toggle")!;
    expect(toggle.classList.contains("on")).toBe(true);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
  });

  it("toggles Developer Mode on and persists to localStorage", () => {
    const section = buildAdvancedTab(ac.signal);
    container.appendChild(section);

    const rows = container.querySelectorAll(".setting-row");
    const toggle = rows[0]!.querySelector(".toggle") as HTMLElement;

    toggle.click();
    expect(toggle.classList.contains("on")).toBe(true);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(localStorage.getItem("owncord:settings:developerMode")).toBe("true");

    // Toggle off again
    toggle.click();
    expect(toggle.classList.contains("on")).toBe(false);
    expect(localStorage.getItem("owncord:settings:developerMode")).toBe("false");
  });

  it("restores Developer Mode toggle state from localStorage", () => {
    localStorage.setItem("owncord:settings:developerMode", "true");
    const section = buildAdvancedTab(ac.signal);
    container.appendChild(section);

    const rows = container.querySelectorAll(".setting-row");
    const toggle = rows[0]!.querySelector(".toggle")!;
    expect(toggle.classList.contains("on")).toBe(true);
  });

  it("toggles via keyboard Enter/Space on Developer Mode", () => {
    const section = buildAdvancedTab(ac.signal);
    container.appendChild(section);

    const rows = container.querySelectorAll(".setting-row");
    const toggle = rows[0]!.querySelector(".toggle") as HTMLElement;

    toggle.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(toggle.classList.contains("on")).toBe(true);

    toggle.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    expect(toggle.classList.contains("on")).toBe(false);
  });

  it("renders DevTools button in Debug section", () => {
    const section = buildAdvancedTab(ac.signal);
    container.appendChild(section);

    const devtoolsBtn = Array.from(container.querySelectorAll("button.ac-btn")).find(
      (b) => b.textContent === "Open DevTools",
    );
    expect(devtoolsBtn).toBeDefined();
  });

  it("DevTools button invokes open_devtools command", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    const section = buildAdvancedTab(ac.signal);
    container.appendChild(section);

    const devtoolsBtn = Array.from(container.querySelectorAll("button.ac-btn")).find(
      (b) => b.textContent === "Open DevTools",
    ) as HTMLButtonElement;

    devtoolsBtn.click();

    await vi.waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("open_devtools");
    });
  });

  it("DevTools button handles invoke failure gracefully", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    (invoke as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("DevTools not supported"));

    const section = buildAdvancedTab(ac.signal);
    container.appendChild(section);

    const devtoolsBtn = Array.from(container.querySelectorAll("button.ac-btn")).find(
      (b) => b.textContent === "Open DevTools",
    ) as HTMLButtonElement;

    // Should not throw
    devtoolsBtn.click();
    await new Promise((r) => setTimeout(r, 10));

    expect(invoke).toHaveBeenCalledWith("open_devtools");
  });

  it("renders section titles for Debug and Storage & Cache", () => {
    const section = buildAdvancedTab(ac.signal);
    container.appendChild(section);

    const titles = container.querySelectorAll(".settings-section-title");
    const titleTexts = Array.from(titles).map((t) => t.textContent);
    expect(titleTexts).toContain("Debug");
    expect(titleTexts).toContain("Storage & Cache");
  });

  it("renders separators between sections", () => {
    const section = buildAdvancedTab(ac.signal);
    container.appendChild(section);

    const separators = container.querySelectorAll(".settings-separator");
    expect(separators.length).toBeGreaterThanOrEqual(2);
  });

  it("renders all three cache clear rows", () => {
    const section = buildAdvancedTab(ac.signal);
    container.appendChild(section);

    const labels = Array.from(container.querySelectorAll(".setting-label")).map(
      (l) => l.textContent,
    );
    expect(labels).toContain("Clear Image Cache");
    expect(labels).toContain("Clear Log Files");
    expect(labels).toContain("Clear All Cache & Restart");
  });

  it("shows image cache clear success then resets button text after timeout", async () => {
    vi.useFakeTimers();
    deleteDbState.mode = "success";
    const section = buildAdvancedTab(ac.signal);
    container.appendChild(section);
    const clearBtns = Array.from(container.querySelectorAll("button.ac-btn")).filter(
      (b) => b.textContent === "Clear",
    );
    const btn = clearBtns[0] as HTMLButtonElement;

    btn.click();
    // Flush microtasks for indexedDB mock
    await vi.advanceTimersByTimeAsync(0);

    expect(btn.textContent).toBe("Cleared!");
    expect(btn.getAttribute("disabled")).toBe("");

    // After 2 seconds, should reset
    await vi.advanceTimersByTimeAsync(2000);
    expect(btn.textContent).toBe("Clear");
    expect(btn.getAttribute("disabled")).toBeNull();
    vi.useRealTimers();
  });

  it("shows image cache clear failure then resets button text after timeout", async () => {
    vi.useFakeTimers();
    deleteDbState.mode = "error";
    const section = buildAdvancedTab(ac.signal);
    container.appendChild(section);
    const clearBtns = Array.from(container.querySelectorAll("button.ac-btn")).filter(
      (b) => b.textContent === "Clear",
    );
    const btn = clearBtns[0] as HTMLButtonElement;

    btn.click();
    await vi.advanceTimersByTimeAsync(0);

    expect(btn.textContent).toBe("Failed");

    await vi.advanceTimersByTimeAsync(2000);
    expect(btn.textContent).toBe("Clear");
    vi.useRealTimers();
  });

  it("shows log clear success then resets button text after timeout", async () => {
    vi.useFakeTimers();
    const section = buildAdvancedTab(ac.signal);
    container.appendChild(section);
    const clearBtns = Array.from(container.querySelectorAll("button.ac-btn")).filter(
      (b) => b.textContent === "Clear",
    );
    const btn = clearBtns[1] as HTMLButtonElement;

    btn.click();
    await vi.advanceTimersByTimeAsync(0);

    expect(btn.textContent).toBe("Cleared!");

    await vi.advanceTimersByTimeAsync(2000);
    expect(btn.textContent).toBe("Clear");
    vi.useRealTimers();
  });

  it("confirmation dialog resets after 3s timeout without second click", async () => {
    vi.useFakeTimers();
    const section = buildAdvancedTab(ac.signal);
    container.appendChild(section);
    const buttons = container.querySelectorAll("button.ac-btn");
    const btn = Array.from(buttons).find(
      (b) => b.textContent === "Clear & Restart",
    ) as HTMLButtonElement;

    btn.click();
    expect(btn.textContent).toBe("Are you sure? Click again");
    expect(btn.classList.contains("ac-btn-danger")).toBe(true);

    await vi.advanceTimersByTimeAsync(3000);
    expect(btn.textContent).toBe("Clear & Restart");
    expect(btn.classList.contains("ac-btn-danger")).toBe(false);
    vi.useRealTimers();
  });

  it("Clear All shows Failed when relaunch fails", async () => {
    mockRelaunch.mockRejectedValue(new Error("Relaunch not supported"));
    const section = buildAdvancedTab(ac.signal);
    container.appendChild(section);
    const buttons = container.querySelectorAll("button.ac-btn");
    const btn = Array.from(buttons).find(
      (b) => b.textContent === "Clear & Restart",
    ) as HTMLButtonElement;

    btn.click();
    btn.click();

    await vi.waitFor(() => {
      expect(btn.textContent).toBe("Failed");
    });
  });

  it("deletes only .jsonl files when clearing log files, skips directories", async () => {
    mockReadDir.mockResolvedValueOnce([
      { name: "app.jsonl", isDirectory: false },
      { name: "old.jsonl", isDirectory: false },
      { name: "subdir", isDirectory: true },
      { name: "readme.txt", isDirectory: false },
    ]);
    const section = buildAdvancedTab(ac.signal);
    container.appendChild(section);
    const clearButtons = Array.from(container.querySelectorAll("button.ac-btn")).filter(
      (b) => b.textContent === "Clear",
    );
    const btn = clearButtons[1] as HTMLButtonElement;

    btn.click();

    await vi.waitFor(() => {
      expect(btn.textContent).toBe("Cleared!");
    });
    // Should have removed only the 2 .jsonl files
    expect(mockRemove).toHaveBeenCalledTimes(2);
  });

  it("treats ENOENT as missing-path (no throw)", async () => {
    mockReadDir.mockRejectedValueOnce(new Error("ENOENT: no such file"));
    const section = buildAdvancedTab(ac.signal);
    container.appendChild(section);
    const clearButtons = Array.from(container.querySelectorAll("button.ac-btn")).filter(
      (b) => b.textContent === "Clear",
    );
    const btn = clearButtons[1] as HTMLButtonElement;

    btn.click();

    await vi.waitFor(() => {
      expect(btn.textContent).toBe("Cleared!");
    });
  });

  it("treats 'cannot find the path' as missing-path (no throw)", async () => {
    mockReadDir.mockRejectedValueOnce(new Error("cannot find the path"));
    const section = buildAdvancedTab(ac.signal);
    container.appendChild(section);
    const clearButtons = Array.from(container.querySelectorAll("button.ac-btn")).filter(
      (b) => b.textContent === "Clear",
    );
    const btn = clearButtons[1] as HTMLButtonElement;

    btn.click();

    await vi.waitFor(() => {
      expect(btn.textContent).toBe("Cleared!");
    });
  });

  it("treats 'os error 2' as missing-path (no throw)", async () => {
    mockReadDir.mockRejectedValueOnce(new Error("os error 2"));
    const section = buildAdvancedTab(ac.signal);
    container.appendChild(section);
    const clearButtons = Array.from(container.querySelectorAll("button.ac-btn")).filter(
      (b) => b.textContent === "Clear",
    );
    const btn = clearButtons[1] as HTMLButtonElement;

    btn.click();

    await vi.waitFor(() => {
      expect(btn.textContent).toBe("Cleared!");
    });
  });

  it("treats non-Error throw as missing-path when message matches pattern", async () => {
    mockReadDir.mockRejectedValueOnce("not found");
    const section = buildAdvancedTab(ac.signal);
    container.appendChild(section);
    const clearButtons = Array.from(container.querySelectorAll("button.ac-btn")).filter(
      (b) => b.textContent === "Clear",
    );
    const btn = clearButtons[1] as HTMLButtonElement;

    btn.click();

    await vi.waitFor(() => {
      expect(btn.textContent).toBe("Cleared!");
    });
  });

  it("handles double onblocked without error", async () => {
    vi.useFakeTimers();
    deleteDbState.mode = "blocked-double";
    const section = buildAdvancedTab(ac.signal);
    container.appendChild(section);
    const clearBtns = Array.from(container.querySelectorAll("button.ac-btn")).filter(
      (b) => b.textContent === "Clear",
    );
    const btn = clearBtns[0] as HTMLButtonElement;

    btn.click();
    await vi.advanceTimersByTimeAsync(1000);

    // Should still fail from the first blocked timer
    expect(btn.textContent).toBe("Failed");
    vi.useRealTimers();
  });

  it("handles success followed by blocked (settled guard)", async () => {
    vi.useFakeTimers();
    deleteDbState.mode = "success-then-blocked";
    const section = buildAdvancedTab(ac.signal);
    container.appendChild(section);
    const clearBtns = Array.from(container.querySelectorAll("button.ac-btn")).filter(
      (b) => b.textContent === "Clear",
    );
    const btn = clearBtns[0] as HTMLButtonElement;

    btn.click();
    // Flush microtask for the initial promise resolution (onsuccess fires)
    await vi.advanceTimersByTimeAsync(0);
    // Flush the setTimeout(onblocked, 0)
    await vi.advanceTimersByTimeAsync(0);
    // Flush the blocked timer (1000ms) which calls finish() but should find settled=true
    await vi.advanceTimersByTimeAsync(1000);

    // Should succeed because onsuccess fired first; blocked timer callback is a no-op
    expect(btn.textContent).toBe("Cleared!");
    vi.useRealTimers();
  });

  it("DevTools handles non-Error rejection gracefully", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    (invoke as ReturnType<typeof vi.fn>).mockRejectedValueOnce("string rejection");

    const section = buildAdvancedTab(ac.signal);
    container.appendChild(section);

    const devtoolsBtn = Array.from(container.querySelectorAll("button.ac-btn")).find(
      (b) => b.textContent === "Open DevTools",
    ) as HTMLButtonElement;

    // Should not throw
    devtoolsBtn.click();
    await new Promise((r) => setTimeout(r, 10));

    expect(invoke).toHaveBeenCalledWith("open_devtools");
  });
});
